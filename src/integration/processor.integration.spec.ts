import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import config from '../../mikro-orm.config';
import { MetricsService } from '../observability/metrics.service';
import { NoopProviderIdentityAdapter } from '../auth/noop-provider-identity.adapter';
import { DatabaseService } from '../infrastructure/database.service';
import { StructuredLogger } from '../infrastructure/logger.service';
import { WageringService } from '../wagering/wagering.service';
import { SubmitWagerDto } from '../wagering/wagering.dto';
import { SqsService } from '../infrastructure/sqs.service';
import { QueueWorkersService } from '../infrastructure/queue-workers.service';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

const enabled = process.env.RUN_INTEGRATION === 'true';
const ormInstances: MikroORM<PostgreSqlDriver>[] = [];
const processors: WageringService[] = [];
const metricsInstances: MetricsService[] = [];
const originalQueueUrls = {
  transaction: process.env.SQS_TRANSACTION_QUEUE_URL,
  deadLetter: process.env.SQS_TRANSACTION_DLQ_URL,
  events: process.env.SQS_EVENT_QUEUE_URL,
};
let testSqs: SqsService;
const testQueueUrls: string[] = [];

describe.skipIf(!enabled)('PostgreSQL concurrency integration', () => {
  beforeAll(async () => {
    testSqs = new SqsService();
    const queueSuffix = randomUUID();
    const deadLetterQueue = await testSqs.client.send(new CreateQueueCommand({
      QueueName: `wager-test-dlq-${queueSuffix}.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
    }));
    const transactionQueue = await testSqs.client.send(new CreateQueueCommand({
      QueueName: `wager-test-transactions-${queueSuffix}.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
    }));
    const eventQueue = await testSqs.client.send(new CreateQueueCommand({
      QueueName: `wager-test-events-${queueSuffix}.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
    }));
    if (!deadLetterQueue.QueueUrl || !transactionQueue.QueueUrl || !eventQueue.QueueUrl) {
      throw new Error('LocalStack did not return URLs for integration queues');
    }
    testQueueUrls.push(deadLetterQueue.QueueUrl, transactionQueue.QueueUrl, eventQueue.QueueUrl);
    process.env.SQS_TRANSACTION_DLQ_URL = deadLetterQueue.QueueUrl;
    process.env.SQS_TRANSACTION_QUEUE_URL = transactionQueue.QueueUrl;
    process.env.SQS_EVENT_QUEUE_URL = eventQueue.QueueUrl;

    for (let index = 0; index < 3; index += 1) {
      const orm = await MikroORM.init(config);
      ormInstances.push(orm);
      const metrics = new MetricsService();
      metricsInstances.push(metrics);
      processors.push(new WageringService(
        new DatabaseService(orm),
        new StructuredLogger(),
        metrics,
        new NoopProviderIdentityAdapter(),
      ));
    }
    await ormInstances[0].getMigrator().up();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(ormInstances.map((orm) => orm.close(true)));
    if (testSqs) {
      await Promise.all(testQueueUrls.map((QueueUrl) =>
        testSqs.client.send(new DeleteQueueCommand({ QueueUrl }))));
      await testSqs.onModuleDestroy();
    }
    restoreQueueUrl('SQS_TRANSACTION_QUEUE_URL', originalQueueUrls.transaction);
    restoreQueueUrl('SQS_TRANSACTION_DLQ_URL', originalQueueUrls.deadLetter);
    restoreQueueUrl('SQS_EVENT_QUEUE_URL', originalQueueUrls.events);
  });

  test('enforces migration constraints and rolls back wallet, inbox and outbox together', async () => {
    const processor = processors[0];
    const wallet = await processor.createWallet({
      playerId: randomUUID(),
      initialBalance: { amount: '5.00', currency: 'BRL' },
    });
    const walletId = wallet.id as string;
    const database = new DatabaseService(ormInstances[0]);

    await expect(database.execute('UPDATE wallets SET balance = -1 WHERE id = $1', [walletId])).rejects.toBeDefined();
    const ledger = await database.execute<{ id: string }>(
      'SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1',
      [walletId],
    );
    await expect(database.execute('DELETE FROM wallet_ledger_entries WHERE id = $1', [ledger[0].id]))
      .rejects.toBeDefined();
    expect(await database.execute('SELECT id FROM wallet_ledger_entries WHERE id = $1', [ledger[0].id]))
      .toHaveLength(1);

    const rollbackWalletId = randomUUID();
    const rollbackPlayerId = randomUUID();
    const messageId = randomUUID();
    const eventId = randomUUID();
    await expect(database.transaction(async (query) => {
      await query(
        'INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1, $2, $3, $4)',
        [rollbackWalletId, rollbackPlayerId, 'BRL', '10.00'],
      );
      await query(
        'INSERT INTO inbox_messages (message_id, consumer_name, payload_hash) VALUES ($1, $2, $3)',
        [messageId, 'atomicity-test', 'a'.repeat(64)],
      );
      await query(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
         VALUES ($1, $2, $3, '{}'::jsonb, now())`,
        [eventId, rollbackWalletId, 'AtomicityTest'],
      );
      await query('UPDATE wallets SET balance = -1 WHERE id = $1', [rollbackWalletId]);
    })).rejects.toBeDefined();

    expect(await database.execute('SELECT id FROM wallets WHERE id = $1', [rollbackWalletId])).toHaveLength(0);
    expect(await database.execute('SELECT message_id FROM inbox_messages WHERE message_id = $1', [messageId]))
      .toHaveLength(0);
    expect(await database.execute('SELECT id FROM outbox_messages WHERE id = $1', [eventId])).toHaveLength(0);
  }, 30_000);

  test('deduplicates 50 parallel requests across independent database connections', async () => {
    const processor = processors[0];
    const wallet = await processor.createWallet({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const walletId = wallet.id as string;
    const dto = createBet(walletId, wallet.playerId as string, randomUUID(), '5.00');
    const idempotencyKey = `integration:${dto.externalTransactionId}`;
    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      processors[index % processors.length].process(dto, { idempotencyKey })));

    const balance = await processor.getWallet(walletId);
    const ledger = await processor.getLedger(walletId, undefined, 100);
    expect((balance.balance as { amount: string }).amount).toBe('95.00');
    expect((ledger.entries as unknown[]).length).toBe(2);
  }, 30_000);

  test('processes distinct wallets in parallel without blocking or losing ledger entries', async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, (_, index) =>
      processors[index].createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      })));
    await Promise.all(wallets.flatMap((wallet, walletIndex) =>
      Array.from({ length: 8 }, (_, operationIndex) => {
        const dto = createBet(
          wallet.id as string,
          wallet.playerId as string,
          randomUUID(),
          '1.00',
        );
        return processors[(walletIndex + operationIndex) % processors.length]
          .process(dto, { idempotencyKey: `integration:${dto.externalTransactionId}` });
      })));

    for (const wallet of wallets) {
      const walletId = wallet.id as string;
      expect((await processors[0].getWallet(walletId)).balance).toEqual({
        amount: '42.00',
        currency: 'BRL',
      });
      expect((await processors[0].reconcile(walletId)).consistent).toBe(true);
      expect((await processors[0].getLedger(walletId, undefined, 100)).entries).toHaveLength(9);
    }
  }, 30_000);

  test('serializes identical wagers across three independent application processes', async () => {
    const wallet = await processors[0].createWallet({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const dto = createBet(wallet.id as string, wallet.playerId as string, randomUUID(), '5.00');
    const idempotencyKey = `integration:${dto.externalTransactionId}`;
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      runProcessorProcess({ mode: 'process', dto, idempotencyKey })));

    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(3);
    expect(results.filter((result) => result.idempotentReplay === true)).toHaveLength(2);
    expect((await processors[0].getWallet(wallet.id as string)).balance).toEqual({
      amount: '95.00',
      currency: 'BRL',
    });
    expect((await processors[0].getLedger(wallet.id as string, undefined, 100)).entries).toHaveLength(2);
  }, 30_000);

  test('serializes two competing bets and preserves ledger reconciliation', async () => {
    const playerId = randomUUID();
    const wallet = await processors[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const walletId = wallet.id as string;
    const requests = [randomUUID(), randomUUID()].map((externalId, index) => {
      const dto = createBet(walletId, playerId, externalId, '80.00');
      return processors[index % processors.length]
        .process(dto, { idempotencyKey: `integration:${externalId}` });
    });
    const results = await Promise.all(requests);
    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'REJECTED')).toHaveLength(1);
    expect((await processors[0].getWallet(walletId)).balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect((await processors[0].reconcile(walletId)).consistent).toBe(true);
  }, 30_000);

  test('reprocesses a refund delivered before its referenced bet', async () => {
    const processor = processors[0];
    const playerId = randomUUID();
    const wallet = await processor.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const walletId = wallet.id as string;
    const externalReference = randomUUID();
    const refund: SubmitWagerDto = {
      providerId: 'integration-provider',
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: 'integration-round',
      gameId: 'integration-game',
      kind: 'REFUND' as SubmitWagerDto['kind'],
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: externalReference,
    };
    const pending = await processor.process(refund, { idempotencyKey: `integration:${refund.externalTransactionId}` });
    expect(pending.status).toBe('PENDING_REFERENCE');

    const bet = createBet(walletId, playerId, externalReference, '10.00');
    await processor.process(bet, { idempotencyKey: `integration:${externalReference}` });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await processor.retryPendingReferences(10);
    expect((await processor.getProviderTransaction('integration-provider', refund.externalTransactionId)).status)
      .toBe('PROCESSED');
    expect((await processor.getWallet(walletId)).balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect((await processor.reconcile(walletId)).consistent).toBe(true);
  }, 30_000);

  test('applies bet, win, loss, refund and rollback without breaking ledger consistency', async () => {
    const processor = processors[0];
    const playerId = randomUUID();
    const wallet = await processor.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const walletId = wallet.id as string;
    const betId = randomUUID();
    const bet = createBet(walletId, playerId, betId, '20.00');
    const win: SubmitWagerDto = {
      ...createBet(walletId, playerId, randomUUID(), '10.00'),
      kind: 'WIN' as SubmitWagerDto['kind'],
    };
    const loss: SubmitWagerDto = {
      ...createBet(walletId, playerId, randomUUID(), '0.00'),
      kind: 'LOSS' as SubmitWagerDto['kind'],
    };
    const refund: SubmitWagerDto = {
      ...createBet(walletId, playerId, randomUUID(), '20.00'),
      kind: 'REFUND' as SubmitWagerDto['kind'],
      referenceExternalTransactionId: betId,
    };
    const rollbackWin: SubmitWagerDto = {
      ...createBet(walletId, playerId, randomUUID(), '10.00'),
      kind: 'ROLLBACK' as SubmitWagerDto['kind'],
      referenceExternalTransactionId: win.externalTransactionId,
    };

    for (const dto of [bet, win, loss, refund, rollbackWin]) {
      const result = await processor.process(dto, { idempotencyKey: `integration:${dto.externalTransactionId}` });
      expect(result.status).toBe('PROCESSED');
    }
    expect((await processor.getWallet(walletId)).balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const ledger = await processor.getLedger(walletId, undefined, 100);
    expect((ledger.entries as unknown[]).length).toBe(5);
    expect((await processor.reconcile(walletId)).consistent).toBe(true);

    await expect(processor.process({ ...bet, money: { amount: '21.00', currency: 'BRL' } }, {
      idempotencyKey: `integration:${bet.externalTransactionId}`,
    })).rejects.toMatchObject({ status: 409 });
  }, 30_000);

  test('consumes an SQS message and commits its durable inbox entry before acknowledgement', async () => {
    const processor = processors[0];
    const playerId = randomUUID();
    const wallet = await processor.createWallet({
      playerId,
      initialBalance: { amount: '20.00', currency: 'BRL' },
    });
    const dto = createBet(wallet.id as string, playerId, randomUUID(), '2.00');
    const sqs = new SqsService();
    const worker = new QueueWorkersService(sqs, processor, new StructuredLogger(), new MetricsService());
    const envelope = {
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        ...dto,
        idempotencyKey: `integration:${dto.externalTransactionId}`,
      },
    };
    try {
      const sent = await sqs.client.send(new SendMessageCommand({
        QueueUrl: sqs.transactionQueueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: dto.walletId,
        MessageDeduplicationId: envelope.messageId,
      }));
      await worker.consumeTransactions();
      let result: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          result = await processor.getProviderTransaction(dto.providerId, dto.externalTransactionId);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      expect(result?.status).toBe('PROCESSED');
      const inbox = await new DatabaseService(ormInstances[0]).execute<{ processed_at: Date | null }>(
        'SELECT processed_at FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2',
        ['wager-transaction-consumer', sent.MessageId],
      );
      expect(inbox).toHaveLength(1);
      expect(inbox[0].processed_at).toBeTruthy();
      const transaction = await processor.getProviderTransaction(dto.providerId, dto.externalTransactionId);
      const transactionId = transaction.id as string;
      expect(await new DatabaseService(ormInstances[0]).execute(
        'SELECT id FROM wallet_ledger_entries WHERE transaction_id = $1',
        [transactionId],
      )).toHaveLength(1);
      expect(await new DatabaseService(ormInstances[0]).execute(
        'SELECT id FROM outbox_messages WHERE aggregate_id = $1',
        [transactionId],
      )).toHaveLength(1);
      expect(await new DatabaseService(ormInstances[0]).execute(
        `SELECT id FROM outbox_messages
         WHERE aggregate_id = $1 AND event_type = 'WalletBalanceChanged'`,
        [dto.walletId],
      )).toHaveLength(2);
    } finally {
      await worker.onApplicationShutdown();
      await sqs.onModuleDestroy();
    }
  }, 30_000);

  test('redelivers a committed SQS message after a simulated worker crash before ack', async () => {
    const processor = processors[0];
    const playerId = randomUUID();
    const wallet = await processor.createWallet({
      playerId,
      initialBalance: { amount: '20.00', currency: 'BRL' },
    });
    const dto = createBet(wallet.id as string, playerId, randomUUID(), '2.00');
    const sqs = new SqsService();
    const envelope = {
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...dto, idempotencyKey: `integration:${dto.externalTransactionId}` },
    };
    let worker: QueueWorkersService | undefined;
    try {
      await sqs.client.send(new SendMessageCommand({
        QueueUrl: sqs.transactionQueueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: dto.walletId,
        MessageDeduplicationId: envelope.messageId,
      }));
      const firstDelivery = await sqs.client.send(new ReceiveMessageCommand({
        QueueUrl: sqs.transactionQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 5,
        VisibilityTimeout: 30,
      }));
      const message = firstDelivery.Messages?.[0];
      expect(message?.ReceiptHandle).toBeTruthy();
      expect(message?.MessageId).toBeTruthy();

      const crashedWorkerResult = await runProcessorProcess({
        mode: 'commit-before-ack',
        dto,
        idempotencyKey: envelope.data.idempotencyKey,
        messageId: message!.MessageId!,
      });
      expect(crashedWorkerResult.status).toBe('PROCESSED');
      await sqs.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: sqs.transactionQueueUrl,
        ReceiptHandle: message!.ReceiptHandle!,
        VisibilityTimeout: 0,
      }));

      worker = new QueueWorkersService(sqs, processor, new StructuredLogger(), new MetricsService());
      await worker.consumeTransactions();
      await worker.onApplicationShutdown();
      worker = undefined;

      const redelivery = await sqs.client.send(new ReceiveMessageCommand({
        QueueUrl: sqs.transactionQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 1,
      }));
      expect(redelivery.Messages ?? []).toHaveLength(0);
      const walletAfter = await processor.getWallet(dto.walletId);
      expect(walletAfter.balance).toEqual({ amount: '18.00', currency: 'BRL' });
      expect((await processor.getLedger(dto.walletId, undefined, 100)).entries).toHaveLength(2);
      const inbox = await new DatabaseService(ormInstances[0]).execute<{ processed_at: Date | null }>(
        `SELECT processed_at FROM inbox_messages
         WHERE consumer_name = $1 AND message_id = $2`,
        ['wager-transaction-consumer', message!.MessageId!],
      );
      expect(inbox).toHaveLength(1);
      expect(inbox[0].processed_at).toBeTruthy();
      expect((await processor.reconcile(dto.walletId)).consistent).toBe(true);
    } finally {
      if (worker) await worker.onApplicationShutdown();
      await sqs.onModuleDestroy();
    }
  }, 30_000);

  test('retries a transient message failure and moves permanent messages to the DLQ', async () => {
    const processor = processors[0];
    const playerId = randomUUID();
    const wallet = await processor.createWallet({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const dto = createBet(wallet.id as string, playerId, randomUUID(), '1.00');
    const sqs = new SqsService();
    const transientEnvelope = {
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...dto, idempotencyKey: `integration:${dto.externalTransactionId}` },
    };
    let failingWorker: QueueWorkersService | undefined;
    let retryWorker: QueueWorkersService | undefined;
    let dlqWorker: QueueWorkersService | undefined;
    try {
      await sqs.client.send(new SendMessageCommand({
        QueueUrl: sqs.transactionQueueUrl,
        MessageBody: JSON.stringify(transientEnvelope),
        MessageGroupId: dto.walletId,
        MessageDeduplicationId: transientEnvelope.messageId,
      }));

      const transientProcessor = new WageringService(
        new DatabaseService(ormInstances[0]),
        new StructuredLogger(),
        new MetricsService(),
        new NoopProviderIdentityAdapter(),
      );
      transientProcessor.process = async () => {
        throw new Error('Simulated transient database timeout');
      };
      failingWorker = new QueueWorkersService(sqs, transientProcessor, new StructuredLogger(), new MetricsService());
      await failingWorker.consumeTransactions();
      await failingWorker.onApplicationShutdown();
      failingWorker = undefined;

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_100));
      retryWorker = new QueueWorkersService(sqs, processor, new StructuredLogger(), new MetricsService());
      await retryWorker.consumeTransactions();
      await retryWorker.onApplicationShutdown();
      retryWorker = undefined;
      expect((await processor.getWallet(dto.walletId)).balance).toEqual({
        amount: '9.00',
        currency: 'BRL',
      });

      const permanentEnvelope = {
        messageId: randomUUID(),
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {},
      };
      await sqs.client.send(new SendMessageCommand({
        QueueUrl: sqs.transactionQueueUrl,
        MessageBody: JSON.stringify(permanentEnvelope),
        MessageGroupId: 'invalid-message',
        MessageDeduplicationId: permanentEnvelope.messageId,
      }));
      dlqWorker = new QueueWorkersService(sqs, processor, new StructuredLogger(), new MetricsService());
      await dlqWorker.consumeTransactions();
      await dlqWorker.onApplicationShutdown();
      dlqWorker = undefined;

      const deadLetter = await sqs.client.send(new ReceiveMessageCommand({
        QueueUrl: sqs.deadLetterQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
      }));
      expect(deadLetter.Messages?.map((message) => message.Body)).toContain(JSON.stringify(permanentEnvelope));
      if (deadLetter.Messages?.[0]?.ReceiptHandle) {
        await sqs.client.send(new DeleteMessageCommand({
          QueueUrl: sqs.deadLetterQueueUrl,
          ReceiptHandle: deadLetter.Messages[0].ReceiptHandle,
        }));
      }
      expect((await processor.reconcile(dto.walletId)).consistent).toBe(true);
    } finally {
      if (failingWorker) await failingWorker.onApplicationShutdown();
      if (retryWorker) await retryWorker.onApplicationShutdown();
      if (dlqWorker) await dlqWorker.onApplicationShutdown();
      await sqs.onModuleDestroy();
    }
  }, 30_000);

  test('publishes outbox events concurrently and records the completed publication', async () => {
    const processor = processors[0];
    const playerId = randomUUID();
    const wallet = await processor.createWallet({
      playerId,
      initialBalance: { amount: '3.00', currency: 'BRL' },
    });
    const dto = createBet(wallet.id as string, playerId, randomUUID(), '1.00');
    await processor.process(dto, { idempotencyKey: `integration:${dto.externalTransactionId}` });
    const database = new DatabaseService(ormInstances[0]);
    const events = await database.execute<{ id: string }>(
      'SELECT id FROM outbox_messages WHERE aggregate_id = $1 ORDER BY id',
      [wallet.id],
    );
    expect(events).toHaveLength(2);

    const firstSqs = new SqsService();
    const secondSqs = new SqsService();
    const firstPublisher = new QueueWorkersService(
      firstSqs, processors[0], new StructuredLogger(), new MetricsService(),
    );
    const secondPublisher = new QueueWorkersService(
      secondSqs, processors[1], new StructuredLogger(), new MetricsService(),
    );
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await Promise.all([firstPublisher.publishOutbox(), secondPublisher.publishOutbox()]);
        const pending = await database.execute<{ id: string }>(
          'SELECT id FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL',
          [wallet.id],
        );
        if (pending.length === 0) break;
      }
      const published = await database.execute<{ id: string; published_at: Date | null }>(
        'SELECT id, published_at FROM outbox_messages WHERE aggregate_id = $1',
        [wallet.id],
      );
      expect(published).toHaveLength(2);
      expect(published.every((event) => event.published_at !== null)).toBe(true);
      expect((await processor.reconcile(wallet.id as string)).consistent).toBe(true);
    } finally {
      await Promise.all([firstPublisher.onApplicationShutdown(), secondPublisher.onApplicationShutdown()]);
      await Promise.all([firstSqs.onModuleDestroy(), secondSqs.onModuleDestroy()]);
    }
  }, 30_000);

  test('keeps committed balances and ledger consistent after the processing process exits', async () => {
    const wallet = await processors[0].createWallet({
      playerId: randomUUID(),
      initialBalance: { amount: '40.00', currency: 'BRL' },
    });
    const dto = createBet(wallet.id as string, wallet.playerId as string, randomUUID(), '7.00');
    const result = await runProcessorProcess({
      mode: 'process',
      dto,
      idempotencyKey: `integration:${dto.externalTransactionId}`,
    });
    expect(result.status).toBe('PROCESSED');

    const afterRestart = await runProcessorProcess({
      mode: 'verify',
      walletId: wallet.id as string,
    });
    expect(afterRestart.reconciliation).toMatchObject({ consistent: true });
    expect(afterRestart.wallet).toMatchObject({
      balance: { amount: '33.00', currency: 'BRL' },
    });
  }, 30_000);

  test('counts and reports reconciliation mismatches without repairing them silently', async () => {
    const processor = processors[0];
    const wallet = await processor.createWallet({
      playerId: randomUUID(),
      initialBalance: { amount: '8.00', currency: 'BRL' },
    });
    const database = new DatabaseService(ormInstances[0]);
    await database.execute('UPDATE wallets SET balance = balance + 1 WHERE id = $1', [wallet.id]);
    try {
      const mismatch = await processor.reconcile(wallet.id as string);
      expect(mismatch.consistent).toBe(false);
      expect(mismatch.difference).toEqual({ amount: '1.00', currency: 'BRL' });
      const metric = await metricsInstances[0].reconciliationMismatches.get();
      expect(metric.values.reduce((sum, value) => sum + value.value, 0)).toBe(1);
    } finally {
      await database.execute('UPDATE wallets SET balance = balance - 1 WHERE id = $1', [wallet.id]);
    }
    expect((await processor.reconcile(wallet.id as string)).consistent).toBe(true);
  }, 30_000);
});

function createBet(walletId: string, playerId: string, externalTransactionId: string, amount: string): SubmitWagerDto {
  return {
    providerId: 'integration-provider',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'integration-round',
    gameId: 'integration-game',
    kind: 'BET' as SubmitWagerDto['kind'],
    money: { amount, currency: 'BRL' },
  };
}

async function runProcessorProcess(request: {
  mode: 'process' | 'commit-before-ack' | 'verify';
  dto?: SubmitWagerDto;
  idempotencyKey?: string;
  messageId?: string;
  walletId?: string;
}): Promise<Record<string, unknown>> {
  const encodedRequest = Buffer.from(JSON.stringify(request)).toString('base64');
  const child = Bun.spawn([
    process.execPath,
    resolve(process.cwd(), 'src', 'integration', 'processor-process.worker.ts'),
    encodedRequest,
  ], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Processor child process failed: ${stderr}\n${stdout}`);
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith('WORKER_RESULT:'));
  if (!resultLine) throw new Error(`Processor child process returned no result: ${stderr}\n${stdout}`);
  return JSON.parse(resultLine.slice('WORKER_RESULT:'.length)) as Record<string, unknown>;
}

function restoreQueueUrl(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
