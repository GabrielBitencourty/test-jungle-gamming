import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { NoopProviderIdentityAdapter } from '../auth/noop-provider-identity.adapter';
import config from '../../mikro-orm.config';
import { DatabaseService } from '../infrastructure/database.service';
import { StructuredLogger } from '../infrastructure/logger.service';
import { MetricsService } from '../observability/metrics.service';
import { WageringService } from '../wagering/wagering.service';
import { SubmitWagerDto } from '../wagering/wagering.dto';

interface WorkerRequest {
  mode: 'process' | 'commit-before-ack' | 'verify';
  dto?: SubmitWagerDto;
  idempotencyKey?: string;
  messageId?: string;
  walletId?: string;
}

async function run(): Promise<void> {
  const encodedRequest = process.argv[2];
  if (!encodedRequest) throw new Error('Worker request is required');
  const request = JSON.parse(Buffer.from(encodedRequest, 'base64').toString('utf8')) as WorkerRequest;
  const orm = await MikroORM.init(config);
  try {
    const wagering = new WageringService(
      new DatabaseService(orm),
      new StructuredLogger(),
      new MetricsService(),
      new NoopProviderIdentityAdapter(),
    );
    if (
      (request.mode === 'process' || request.mode === 'commit-before-ack') &&
      request.dto &&
      request.idempotencyKey
    ) {
      const result = await wagering.process(request.dto, {
        idempotencyKey: request.idempotencyKey,
        ...(request.mode === 'commit-before-ack' && request.messageId
          ? { source: { consumerName: 'wager-transaction-consumer', messageId: request.messageId } }
          : {}),
      });
      process.stdout.write(`WORKER_RESULT:${JSON.stringify(result)}\n`);
      return;
    }
    if (request.mode === 'verify' && request.walletId) {
      const wallet = await wagering.getWallet(request.walletId);
      const reconciliation = await wagering.reconcile(request.walletId);
      process.stdout.write(`WORKER_RESULT:${JSON.stringify({ wallet, reconciliation })}\n`);
      return;
    }
    throw new Error('Worker request is incomplete');
  } finally {
    await orm.close(true);
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
