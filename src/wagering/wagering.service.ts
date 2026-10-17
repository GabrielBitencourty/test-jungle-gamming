import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { DatabaseService } from '../infrastructure/database.service';
import { StructuredLogger } from '../infrastructure/logger.service';
import { Money } from '../domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { MetricsService } from '../observability/metrics.service';
import { ProviderIdentityPort } from '../auth/provider-identity.port';
import {
  IntegrationEvent,
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events';
import { CreateWalletDto, SubmitWagerDto } from './wagering.dto';

type Query = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

interface ProcessOptions {
  idempotencyKey: string;
  source?: { consumerName: string; messageId: string };
  correlationId?: string;
}

interface TxRow extends Record<string, unknown> {
  id: string;
  status: WagerTransactionStatus;
  failure_code: string | null;
  response_balance: string | null;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const payloadHash = (dto: SubmitWagerDto): string =>
  createHash('sha256').update(canonical(dto)).digest('hex');

const addOutbox = async (query: Query, event: IntegrationEvent<unknown>): Promise<void> => {
  await query(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [event.eventId, event.aggregateId, event.eventType, JSON.stringify(event.toJSON()), event.occurredAt],
  );
};

@Injectable()
export class WageringService {
  constructor(
    private readonly database: DatabaseService,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricsService,
    private readonly providerIdentity: ProviderIdentityPort,
  ) {}

  async createWallet(dto: CreateWalletDto): Promise<Record<string, unknown>> {
    const initial = Money.from(dto.initialBalance);
    const id = randomUUID();
    const createdAt = new Date();
    try {
      return await this.database.transaction(async (query) => {
        const wallets = await query<{ id: string; balance: string; version: number }>(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 1, $5, $5)
           RETURNING id, balance::text, version`,
          [id, dto.playerId, initial.currency, initial.toJSON().amount, createdAt],
        );
        if (initial.isPositive()) {
          const transactionId = randomUUID();
          await query(
            `INSERT INTO wager_transactions
              (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
               round_id, game_id, kind, amount, currency, status, response_balance, processed_at)
             VALUES ($1, 'internal', $2, $2, $3, $4, $5, 'opening', 'internal', 'OPENING', $6, $7,
                     'PROCESSED', $6, $8)`,
            [
              transactionId, transactionId, createHash('sha256').update(transactionId).digest('hex'),
              id, dto.playerId, initial.toJSON().amount, initial.currency, createdAt,
            ],
          );
          await query(
            `INSERT INTO wallet_ledger_entries
              (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
             VALUES ($1, $2, $3, 'CREDIT', $4, $5, 0, $4, $6)`,
            [randomUUID(), id, transactionId, initial.toJSON().amount, initial.currency, createdAt],
          );
          await addOutbox(query, WalletBalanceChanged.from({
            walletId: id,
            transactionId,
            direction: 'CREDIT',
            money: initial.toJSON(),
            balanceBefore: Money.zero(initial.currency).toJSON(),
            balanceAfter: initial.toJSON(),
            walletVersion: 1,
          }, { correlationId: transactionId }));
          await addOutbox(query, new WagerTransactionProcessed(transactionId, transactionId, {
            transactionId,
            providerId: 'internal',
            externalTransactionId: transactionId,
            walletId: id,
            kind: WagerTransactionKind.Opening,
            money: initial.toJSON(),
            status: WagerTransactionStatus.Processed,
          }));
        }
        const wallet = wallets[0];
        return {
          id: wallet.id,
          playerId: dto.playerId,
          balance: { amount: wallet.balance, currency: initial.currency },
          version: wallet.version,
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({ code: 'WALLET_ALREADY_EXISTS', message: 'Wallet already exists for player and currency' });
      }
      throw error;
    }
  }

  async process(dto: SubmitWagerDto, options: ProcessOptions): Promise<Record<string, unknown>> {
    const startedAt = process.hrtime.bigint();
    if (!options.idempotencyKey.trim() || options.idempotencyKey.length > 512) {
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must contain between 1 and 512 characters' });
    }
    await this.providerIdentity.assertProvider(dto.providerId);
    if (dto.kind === WagerTransactionKind.Opening) {
      throw new BadRequestException({ code: 'INTERNAL_TRANSACTION', message: 'OPENING cannot be submitted externally' });
    }
    if (this.needsReference(dto.kind) && !dto.referenceExternalTransactionId?.trim()) {
      throw new BadRequestException({ code: 'REFERENCE_REQUIRED', message: 'This transaction kind requires a reference' });
    }
    if (dto.referenceExternalTransactionId !== undefined && !dto.referenceExternalTransactionId.trim()) {
      throw new BadRequestException({ code: 'INVALID_REFERENCE', message: 'Reference transaction ID cannot be empty' });
    }
    const hash = payloadHash(dto);
    const correlationId = options.correlationId ?? randomUUID();
    const txId = randomUUID();
    const amount = Money.from(dto.money);
    const domainTransaction = WagerTransaction.create({
      id: txId,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey: options.idempotencyKey,
      payloadHash: hash,
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: amount,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
    });
    try {
      const response = await this.database.transaction(async (query) => {
        if (options.source) {
          const inbox = await query<{ message_id: string }>(
            `INSERT INTO inbox_messages (message_id, consumer_name, payload_hash)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING message_id`,
            [options.source.messageId, options.source.consumerName, hash],
          );
          if (inbox.length === 0) {
            const existingInbox = (await query<{ payload_hash: string; processed_at: Date | null }>(
              `SELECT payload_hash, processed_at FROM inbox_messages
               WHERE consumer_name = $1 AND message_id = $2`,
              [options.source.consumerName, options.source.messageId],
            ))[0];
            if (existingInbox.payload_hash !== hash) {
              throw new ConflictException({ code: 'MESSAGE_ID_CONFLICT', message: 'SQS message ID was reused with a different payload' });
            }
            this.metrics.duplicates.inc();
            this.logger.info('Duplicate SQS delivery ignored', {
              messageId: options.source.messageId,
              correlationId,
              providerId: dto.providerId,
              walletId: dto.walletId,
            });
            return { duplicateMessage: true, alreadyProcessed: Boolean(existingInbox.processed_at) };
          }
        }

        await query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [options.idempotencyKey],
        );

        const prior = (await query<TxRow>(
          `SELECT id, status, failure_code, response_balance::text
           FROM wager_transactions WHERE idempotency_key = $1 FOR UPDATE`,
          [options.idempotencyKey],
        ))[0];
        if (prior) {
          const priorHash = (await query<{ payload_hash: string }>(
            'SELECT payload_hash FROM wager_transactions WHERE id = $1',
            [prior.id],
          ))[0].payload_hash;
          if (priorHash !== hash) {
            throw new ConflictException({ code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'Idempotency key was used with a different payload' });
          }
          await this.markInboxProcessed(query, options.source);
          return this.toResponse(prior, prior.response_balance, true, dto.money.currency);
        }

        const wallets = await query<{
          id: string; player_id: string; currency: string; balance: string; version: number;
        }>(
          `SELECT id, player_id, currency, balance::text, version
           FROM wallets WHERE id = $1 FOR UPDATE`,
          [dto.walletId],
        );
        const wallet = wallets[0];
        if (!wallet) {
          throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found' });
        }
        if (wallet.player_id !== dto.playerId || wallet.currency.trim() !== dto.money.currency) {
          throw new UnprocessableEntityException({ code: 'WALLET_MISMATCH', message: 'Wallet player or currency does not match transaction' });
        }

        await query(
          `INSERT INTO wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
             round_id, game_id, kind, amount, currency, reference_external_transaction_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING')`,
          [
            txId, dto.providerId, dto.externalTransactionId, options.idempotencyKey, hash,
            dto.walletId, dto.playerId, dto.roundId, dto.gameId, dto.kind, dto.money.amount,
            dto.money.currency, dto.referenceExternalTransactionId ?? null,
          ],
        );

        const before = Money.from({ amount: wallet.balance, currency: wallet.currency.trim() });
        let rejection: string | undefined = amount.isZero() && dto.kind !== WagerTransactionKind.Loss
          ? 'AMOUNT_MUST_BE_POSITIVE'
          : undefined;
        if (dto.referenceExternalTransactionId === dto.externalTransactionId) rejection = 'REFERENCE_SELF';
        let reference: {
          id: string; kind: WagerTransactionKind; status: WagerTransactionStatus;
          amount: string; currency: string; wallet_id: string; player_id: string; round_id: string;
        } | undefined;
        if (dto.referenceExternalTransactionId) {
          reference = (await query<{
            id: string; kind: WagerTransactionKind; status: WagerTransactionStatus;
            amount: string; currency: string; wallet_id: string; player_id: string; round_id: string;
          }>(
            `SELECT id, kind, status, amount::text, currency, wallet_id, player_id, round_id
             FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2`,
            [dto.providerId, dto.referenceExternalTransactionId],
          ))[0];
        }

        if (!rejection && ((this.needsReference(dto.kind) && !reference) || (dto.referenceExternalTransactionId && !reference))) {
          const retryAt = new Date(Date.now() + 1_000);
          await query(
            `UPDATE wager_transactions SET status = 'PENDING_REFERENCE', next_attempt_at = $2,
             response_balance = $3
             WHERE id = $1`,
            [txId, retryAt, before.toJSON().amount],
          );
          await addOutbox(query, new WagerTransactionPendingReference(
            txId, correlationId, { transactionId: txId, providerId: dto.providerId, referenceExternalTransactionId: dto.referenceExternalTransactionId },
          ));
          await this.markInboxProcessed(query, options.source);
          domainTransaction.markPendingReference();
          return this.toResponse({ id: txId, status: WagerTransactionStatus.PendingReference, failure_code: null }, before.toJSON().amount, false, dto.money.currency);
        }

        if (reference && !rejection) {
          if ([WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference].includes(reference.status as WagerTransactionStatus)) {
            const retryAt = new Date(Date.now() + 1_000);
            await query(
              `UPDATE wager_transactions SET status = 'PENDING_REFERENCE', next_attempt_at = $2,
               response_balance = $3 WHERE id = $1`,
              [txId, retryAt, before.toJSON().amount],
            );
            await addOutbox(query, new WagerTransactionPendingReference(
              txId, correlationId, { transactionId: txId, providerId: dto.providerId, referenceExternalTransactionId: dto.referenceExternalTransactionId },
            ));
            await this.markInboxProcessed(query, options.source);
            domainTransaction.markPendingReference();
            return this.toResponse({ id: txId, status: WagerTransactionStatus.PendingReference, failure_code: null }, before.toJSON().amount, false, dto.money.currency);
          }
          rejection = this.validateReference(dto, reference);
          if (!rejection) {
            await query('UPDATE wager_transactions SET reference_transaction_id = $2 WHERE id = $1', [txId, reference.id]);
            if (dto.kind === WagerTransactionKind.Refund || dto.kind === WagerTransactionKind.Rollback) {
              const reversed = await query(
                `SELECT id FROM wager_transactions
                 WHERE reference_transaction_id = $1 AND kind = $2 AND status = 'PROCESSED' LIMIT 1`,
                [reference.id, dto.kind],
              );
              if (reversed.length) rejection = 'REFERENCE_ALREADY_REVERSED';
            }
          }
        }

        let direction: 'DEBIT' | 'CREDIT' | undefined;
        let after = before;
        if (!rejection) {
          if (dto.kind === WagerTransactionKind.Bet) direction = 'DEBIT';
          else if (dto.kind === WagerTransactionKind.Win || dto.kind === WagerTransactionKind.Refund) direction = 'CREDIT';
          else if (dto.kind === WagerTransactionKind.Rollback && reference) {
            direction = reference.kind === WagerTransactionKind.Bet ? 'CREDIT' : 'DEBIT';
          }

          if (direction === 'DEBIT' && before.isLessThan(amount)) {
            rejection = dto.kind === WagerTransactionKind.Rollback ? 'REVERSAL_WOULD_OVERDRAW' : 'INSUFFICIENT_FUNDS';
          } else if (direction === 'DEBIT') after = before.subtract(amount);
          else if (direction === 'CREDIT') after = before.add(amount);
        }

        const now = new Date();
        if (rejection) domainTransaction.reject(rejection);
        else domainTransaction.markProcessed(reference?.id, now);
        const status = domainTransaction.status;
        await query(
          `UPDATE wager_transactions
           SET status = $2, failure_code = $3, response_balance = $4, processed_at = $5, next_attempt_at = NULL
           WHERE id = $1`,
          [txId, status, rejection ?? null, after.toJSON().amount, now],
        );

        if (!rejection && direction) {
          await query(
            `UPDATE wallets SET balance = $2, version = version + 1, updated_at = $3 WHERE id = $1`,
            [wallet.id, after.toJSON().amount, now],
          );
          await query(
            `INSERT INTO wallet_ledger_entries
              (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [randomUUID(), wallet.id, txId, direction, amount.toJSON().amount, amount.currency, before.toJSON().amount, after.toJSON().amount, now],
          );
          await addOutbox(query, WalletBalanceChanged.from({
            walletId: wallet.id,
            transactionId: txId,
            direction,
            money: amount.toJSON(),
            balanceBefore: before.toJSON(),
            balanceAfter: after.toJSON(),
            walletVersion: wallet.version + 1,
          }, { correlationId, causationId: options.source?.messageId }));
        }

        const eventData = {
          transactionId: txId,
          providerId: dto.providerId,
          externalTransactionId: dto.externalTransactionId,
          walletId: wallet.id,
          roundId: dto.roundId,
          gameId: dto.gameId,
          kind: dto.kind,
          money: amount.toJSON(),
          status,
          ...(rejection ? { failureCode: rejection } : {}),
        };
        await addOutbox(query, rejection
          ? new WagerTransactionRejected(txId, correlationId, eventData)
          : new WagerTransactionProcessed(txId, correlationId, eventData));
        await this.markInboxProcessed(query, options.source);
        return this.toResponse({ id: txId, status, failure_code: rejection ?? null }, after.toJSON().amount, false, dto.money.currency);
      });

      if ('duplicateMessage' in response && response.duplicateMessage) return response;
      if (response.idempotentReplay === true) this.metrics.duplicates.inc();
      if (typeof response.status === 'string') this.metrics.transactions.inc({ status: response.status });
      this.metrics.processingLatency.observe(Number(process.hrtime.bigint() - startedAt) / 1_000_000_000);
      this.logger.info('Wager transaction handled', {
        correlationId,
        messageId: options.source?.messageId,
        transactionId: typeof response.transactionId === 'string' ? response.transactionId : undefined,
        walletId: dto.walletId,
        providerId: dto.providerId,
        status: typeof response.status === 'string' ? response.status : undefined,
        idempotentReplay: response.idempotentReplay === true,
      });
      return response;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const priorRows = await this.database.execute<TxRow & { payload_hash: string }>(
          `SELECT id, status, failure_code, response_balance::text, payload_hash
           FROM wager_transactions WHERE idempotency_key = $1`,
          [options.idempotencyKey],
        );
        const prior = priorRows[0];
        if (prior) {
          if (prior.payload_hash !== hash) {
            throw new ConflictException({ code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'Idempotency key was used with a different payload' });
          }
          this.metrics.duplicates.inc();
          this.metrics.transactions.inc({ status: prior.status });
          this.metrics.processingLatency.observe(Number(process.hrtime.bigint() - startedAt) / 1_000_000_000);
          this.logger.info('Concurrent idempotent replay handled', {
            correlationId,
            messageId: options.source?.messageId,
            transactionId: prior.id,
            walletId: dto.walletId,
            providerId: dto.providerId,
            status: prior.status,
            idempotentReplay: true,
          });
          return this.toResponse(prior, prior.response_balance, true, dto.money.currency);
        }
        throw new ConflictException({ code: 'EXTERNAL_TRANSACTION_CONFLICT', message: 'Provider transaction ID already exists' });
      }
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03') {
        this.metrics.lockConflicts.inc();
      }
      this.logger.error('Wager transaction processing failed', error, {
        correlationId,
        messageId: options.source?.messageId,
        transactionId: txId,
        walletId: dto.walletId,
        providerId: dto.providerId,
      });
      throw error;
    }
  }

  async getWallet(walletId: string): Promise<Record<string, unknown>> {
    const rows = await this.database.execute<{ id: string; player_id: string; balance: string; currency: string; version: number }>(
      'SELECT id, player_id, balance::text, currency, version FROM wallets WHERE id = $1',
      [walletId],
    );
    const wallet = rows[0];
    if (!wallet) throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found' });
    return { id: wallet.id, playerId: wallet.player_id, balance: { amount: wallet.balance, currency: wallet.currency.trim() }, version: wallet.version };
  }

  async getLedger(walletId: string, cursor?: string, limit = 50): Promise<Record<string, unknown>> {
    await this.getWallet(walletId);
    let cursorDate: string | undefined;
    let cursorId: string | undefined;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt: string; id: string };
        if (
          !decoded.createdAt ||
          Number.isNaN(Date.parse(decoded.createdAt)) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.id)
        ) throw new Error('Malformed cursor');
        cursorDate = decoded.createdAt;
        cursorId = decoded.id;
      } catch {
        throw new UnprocessableEntityException({ code: 'INVALID_CURSOR', message: 'Ledger cursor is invalid' });
      }
    }
    const rows = await this.database.execute<Record<string, unknown>>(
      `SELECT id, transaction_id, direction, amount::text, currency, balance_before::text,
              balance_after::text, created_at
       FROM wallet_ledger_entries
       WHERE wallet_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [walletId, cursorDate ?? null, cursorId ?? null, Math.min(Math.max(limit, 1), 100)],
    );
    const last = rows[rows.length - 1] as { id: string; created_at: Date } | undefined;
    const nextCursor = rows.length === Math.min(Math.max(limit, 1), 100) && last
      ? Buffer.from(JSON.stringify({ createdAt: new Date(last.created_at).toISOString(), id: last.id })).toString('base64url')
      : null;
    return { entries: rows, nextCursor };
  }

  async getTransaction(transactionId: string): Promise<Record<string, unknown>> {
    const rows = await this.database.execute<Record<string, unknown>>(
      `SELECT id, provider_id, external_transaction_id, wallet_id, round_id, game_id, kind,
              amount::text, currency, status, failure_code, response_balance::text, created_at, processed_at
       FROM wager_transactions WHERE id = $1`,
      [transactionId],
    );
    if (!rows[0]) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found' });
    return rows[0];
  }

  async getProviderTransaction(providerId: string, externalId: string): Promise<Record<string, unknown>> {
    const rows = await this.database.execute<{ id: string }>(
      'SELECT id FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2',
      [providerId, externalId],
    );
    if (!rows[0]) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found' });
    return this.getTransaction(rows[0].id);
  }

  async reconcile(walletId: string): Promise<Record<string, unknown>> {
    return this.database.transaction(async (query) => {
      const rows = await query<{ id: string; currency: string; balance: string }>(
        'SELECT id, currency, balance::text FROM wallets WHERE id = $1 FOR UPDATE',
        [walletId],
      );
      if (!rows[0]) throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found' });
      const totals = await query<{ calculated: string; count: string }>(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS calculated,
                COUNT(*)::text AS count
         FROM wallet_ledger_entries WHERE wallet_id = $1`,
        [walletId],
      );
      const storedBalance = Money.from({ amount: rows[0].balance, currency: rows[0].currency.trim() });
      const calculatedBalance = Money.from({ amount: totals[0].calculated, currency: rows[0].currency.trim() });
      const difference = storedBalance.subtract(calculatedBalance);
      const consistent = difference.isZero();
      if (!consistent) {
        this.metrics.reconciliationMismatches.inc();
        this.logger.error('Wallet reconciliation mismatch', new Error('Ledger and materialized balance differ'), { walletId });
      }
      return {
        walletId,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: Number(totals[0].count),
      };
    });
  }

  async claimOutbox(limit: number): Promise<string[]> {
    const lag = await this.database.execute<{ seconds: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::float8 AS seconds
       FROM outbox_messages WHERE published_at IS NULL`,
    );
    this.metrics.outboxLag.set(lag[0]?.seconds ?? 0);
    return this.database.transaction(async (query) => {
      const rows = await query<{ message_id: string }>(
        `WITH due AS (
           SELECT o.id
           FROM outbox_messages o
           LEFT JOIN outbox_claims c ON c.message_id = o.id
           WHERE o.published_at IS NULL
             AND COALESCE(o.next_attempt_at, now()) <= now()
             AND (c.message_id IS NULL OR c.locked_until < now())
           ORDER BY o.created_at, o.id
           LIMIT $1
           FOR UPDATE OF o SKIP LOCKED
         )
         INSERT INTO outbox_claims (message_id, locked_until)
         SELECT id, now() + interval '60 seconds' FROM due
         ON CONFLICT (message_id) DO UPDATE SET locked_until = EXCLUDED.locked_until
         RETURNING message_id`,
        [limit],
      );
      return rows.map((row) => row.message_id);
    });
  }

  async getOutboxMessage(id: string): Promise<{ payload: unknown; aggregateId: string } | undefined> {
    const rows = await this.database.execute<{ payload: unknown; aggregate_id: string }>(
      'SELECT payload, aggregate_id FROM outbox_messages WHERE id = $1 AND published_at IS NULL',
      [id],
    );
    return rows[0] ? { payload: rows[0].payload, aggregateId: rows[0].aggregate_id } : undefined;
  }

  async markOutboxPublished(id: string): Promise<void> {
    await this.database.transaction(async (query) => {
      await query('UPDATE outbox_messages SET published_at = now() WHERE id = $1 AND published_at IS NULL', [id]);
      await query('DELETE FROM outbox_claims WHERE message_id = $1', [id]);
    });
  }

  async scheduleOutboxRetry(id: string): Promise<void> {
    await this.database.transaction(async (query) => {
      await query(
        `UPDATE outbox_messages
         SET attempts = attempts + 1,
             next_attempt_at = now() + make_interval(secs => LEAST(300, (2 ^ LEAST(attempts, 9))::integer))
         WHERE id = $1 AND published_at IS NULL`,
        [id],
      );
      await query('DELETE FROM outbox_claims WHERE message_id = $1', [id]);
    });
  }

  async retryPendingReferences(limit: number): Promise<void> {
    const due = await this.database.execute<{ id: string }>(
      `SELECT id FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
       ORDER BY next_attempt_at, id LIMIT $1`,
      [limit],
    );
    for (const item of due) {
      this.metrics.retries.inc({ worker: 'pending_reference' });
      await this.retryReference(item.id);
    }
  }

  private async retryReference(transactionId: string): Promise<void> {
    await this.database.transaction(async (query) => {
      const transactions = await query<{
        id: string; provider_id: string; external_transaction_id: string; wallet_id: string;
        player_id: string; round_id: string; game_id: string; kind: WagerTransactionKind; amount: string; currency: string;
        reference_external_transaction_id: string; reference_attempts: number; created_at: Date;
      }>(
        `SELECT id, provider_id, external_transaction_id, wallet_id, player_id, round_id, game_id, kind,
                amount::text, currency, reference_external_transaction_id, reference_attempts, created_at
         FROM wager_transactions
         WHERE id = $1 AND status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
         FOR UPDATE SKIP LOCKED`,
        [transactionId],
      );
      const transaction = transactions[0];
      if (!transaction) return;
      const wallets = await query<{ balance: string; currency: string; version: number }>(
        'SELECT balance::text, currency, version FROM wallets WHERE id = $1 FOR UPDATE',
        [transaction.wallet_id],
      );
      const wallet = wallets[0];
      if (!wallet) {
        await query(
          `UPDATE wager_transactions SET status = 'FAILED', failure_code = 'WALLET_MISSING',
           processed_at = now(), next_attempt_at = NULL WHERE id = $1`,
          [transaction.id],
        );
        return;
      }
      const now = new Date();
      const referenceRows = await query<Record<string, unknown>>(
        `SELECT id, kind, status, amount::text, currency, wallet_id, player_id, round_id
         FROM wager_transactions
         WHERE provider_id = $1 AND external_transaction_id = $2
         `,
        [transaction.provider_id, transaction.reference_external_transaction_id],
      );
      const reference = referenceRows[0];
      const attempts = transaction.reference_attempts + 1;
      const maxAttempts = Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 12);
      const ttlHours = Number(process.env.PENDING_REFERENCE_TTL_HOURS ?? 24);
      const expired = now.getTime() - new Date(transaction.created_at).getTime() >= ttlHours * 3_600_000;
      const before = Money.from({ amount: wallet.balance, currency: wallet.currency.trim() });
      const amount = Money.from({ amount: transaction.amount, currency: transaction.currency.trim() });
      const ctx = { correlationId: transaction.id };

      if (!reference) {
        if (attempts >= maxAttempts || expired) {
          await query(
            `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND',
             reference_attempts = $2, response_balance = $3, processed_at = $4, next_attempt_at = NULL
             WHERE id = $1`,
            [transaction.id, attempts, before.toJSON().amount, now],
          );
          await addOutbox(query, new WagerTransactionRejected(transaction.id, ctx.correlationId, {
            transactionId: transaction.id, providerId: transaction.provider_id,
            externalTransactionId: transaction.external_transaction_id, walletId: transaction.wallet_id,
            status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND',
          }));
          return;
        }
        const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 12));
        await query(
          `UPDATE wager_transactions SET reference_attempts = $2,
           next_attempt_at = $3 WHERE id = $1`,
          [transaction.id, attempts, new Date(now.getTime() + delaySeconds * 1000)],
        );
        return;
      }

      const fakeDto = {
        providerId: transaction.provider_id,
        walletId: transaction.wallet_id,
        playerId: transaction.player_id,
        roundId: transaction.round_id,
        kind: transaction.kind,
        money: { amount: transaction.amount, currency: transaction.currency.trim() },
      } as SubmitWagerDto;
      const invalidAmount = amount.isZero() && transaction.kind !== WagerTransactionKind.Loss
        ? 'AMOUNT_MUST_BE_POSITIVE'
        : undefined;
      if (!invalidAmount && [WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference].includes(reference.status as WagerTransactionStatus)) {
        if (attempts >= maxAttempts || expired) {
          await query(
            `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_PROCESSED',
             reference_attempts = $2, response_balance = $3, processed_at = $4, next_attempt_at = NULL
             WHERE id = $1`,
            [transaction.id, attempts, before.toJSON().amount, now],
          );
          await addOutbox(query, new WagerTransactionRejected(transaction.id, ctx.correlationId, {
            transactionId: transaction.id, providerId: transaction.provider_id,
            externalTransactionId: transaction.external_transaction_id, walletId: transaction.wallet_id,
            status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED',
          }));
          return;
        }
        const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 12));
        await query(
          `UPDATE wager_transactions SET reference_attempts = $2,
           next_attempt_at = $3 WHERE id = $1`,
          [transaction.id, attempts, new Date(now.getTime() + delaySeconds * 1000)],
        );
        return;
      }
      let failure = invalidAmount ?? this.validateReference(fakeDto, reference);
      if (!failure && transaction.kind !== WagerTransactionKind.Refund && transaction.kind !== WagerTransactionKind.Rollback) {
        failure = reference.kind === WagerTransactionKind.Bet ? undefined : 'INVALID_REFERENCE_KIND';
      }
      if (!failure && (transaction.kind === WagerTransactionKind.Refund || transaction.kind === WagerTransactionKind.Rollback)) {
        const reversed = await query(
          `SELECT id FROM wager_transactions
           WHERE reference_transaction_id = $1 AND kind = $2 AND status IN ('PROCESSED', 'PENDING_REFERENCE')
           LIMIT 1`,
          [reference.id, transaction.kind],
        );
        if (reversed.length) failure = 'REFERENCE_ALREADY_REVERSED';
      }

      let direction: 'DEBIT' | 'CREDIT' | undefined;
      let after = before;
      if (!failure) {
        if (transaction.kind === WagerTransactionKind.Refund) direction = 'CREDIT';
        else if (transaction.kind === WagerTransactionKind.Rollback) {
          direction = reference.kind === WagerTransactionKind.Bet ? 'CREDIT' : 'DEBIT';
        }
        if (direction === 'DEBIT' && before.isLessThan(amount)) failure = 'REVERSAL_WOULD_OVERDRAW';
        else if (direction === 'DEBIT') after = before.subtract(amount);
        else if (direction === 'CREDIT') after = before.add(amount);
      }

      const status = failure ? WagerTransactionStatus.Rejected : WagerTransactionStatus.Processed;
      await query(
        `UPDATE wager_transactions SET status = $2, failure_code = $3, reference_transaction_id = $4,
         reference_attempts = $5, response_balance = $6, processed_at = $7, next_attempt_at = NULL
         WHERE id = $1`,
        [transaction.id, status, failure ?? null, reference.id, attempts, after.toJSON().amount, now],
      );
      if (!failure && direction) {
        await query(
          'UPDATE wallets SET balance = $2, version = version + 1, updated_at = $3 WHERE id = $1',
          [transaction.wallet_id, after.toJSON().amount, now],
        );
        await query(
          `INSERT INTO wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [randomUUID(), transaction.wallet_id, transaction.id, direction, amount.toJSON().amount,
            amount.currency, before.toJSON().amount, after.toJSON().amount, now],
        );
        await addOutbox(query, WalletBalanceChanged.from({
          walletId: transaction.wallet_id,
          transactionId: transaction.id,
          direction,
          money: amount.toJSON(),
          balanceBefore: before.toJSON(),
          balanceAfter: after.toJSON(),
          walletVersion: wallet.version + 1,
        }, ctx));
      }
      const eventData = {
        transactionId: transaction.id,
        providerId: transaction.provider_id,
        externalTransactionId: transaction.external_transaction_id,
        walletId: transaction.wallet_id,
        roundId: transaction.round_id,
        gameId: transaction.game_id,
        kind: transaction.kind,
        money: amount.toJSON(),
        status,
        ...(failure ? { failureCode: failure } : {}),
      };
      await addOutbox(query, failure
        ? new WagerTransactionRejected(transaction.id, ctx.correlationId, eventData)
        : new WagerTransactionProcessed(transaction.id, ctx.correlationId, eventData));
    });
  }

  private async markInboxProcessed(query: Query, source?: ProcessOptions['source']): Promise<void> {
    if (source) {
      await query(
        `UPDATE inbox_messages SET processed_at = now()
         WHERE consumer_name = $1 AND message_id = $2`,
        [source.consumerName, source.messageId],
      );
    }
  }

  private needsReference(kind: WagerTransactionKind): boolean {
    return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  }

  private validateReference(dto: SubmitWagerDto, reference: Record<string, unknown>): string | undefined {
    if (reference.status !== WagerTransactionStatus.Processed) return 'REFERENCE_NOT_PROCESSED';
    if (
      reference.wallet_id !== dto.walletId ||
      reference.player_id !== dto.playerId ||
      reference.round_id !== dto.roundId ||
      reference.currency !== dto.money.currency
    ) return 'REFERENCE_CONTEXT_MISMATCH';
    const allowed = dto.kind === WagerTransactionKind.Refund
      ? [WagerTransactionKind.Bet]
      : dto.kind === WagerTransactionKind.Rollback
        ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]
        : dto.kind === WagerTransactionKind.Win
          ? [WagerTransactionKind.Bet]
          : [];
    if (!allowed.includes(reference.kind as WagerTransactionKind)) return 'INVALID_REFERENCE_KIND';
    if (reference.amount !== dto.money.amount) return 'REFERENCE_AMOUNT_MISMATCH';
    return undefined;
  }

  private toResponse(
    row: Pick<TxRow, 'id' | 'status' | 'failure_code'>,
    balance: string | null,
    idempotentReplay: boolean,
    currency: string,
  ): Record<string, unknown> {
    return {
      transactionId: row.id,
      status: row.status,
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
      balance: balance ? { amount: balance, currency } : null,
      idempotentReplay,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }
}
