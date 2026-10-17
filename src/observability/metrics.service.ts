import { Injectable } from '@nestjs/common';
import {
  Counter, Gauge, Histogram, Registry, collectDefaultMetrics,
} from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions by final processing status',
    labelNames: ['status'],
    registers: [this.registry],
  });
  readonly duplicates = new Counter({
    name: 'wager_idempotent_replays_total',
    help: 'Idempotent transaction replays',
    registers: [this.registry],
  });
  readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Retry attempts by worker type',
    labelNames: ['worker'],
    registers: [this.registry],
  });
  readonly deadLetters = new Counter({
    name: 'wager_dlq_messages_total',
    help: 'Messages sent to the dead-letter queue',
    registers: [this.registry],
  });
  readonly deadLetterDepth = new Gauge({
    name: 'wager_dlq_approximate_messages',
    help: 'Approximate messages currently in the SQS dead-letter queue',
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Database lock conflicts',
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: 'wager_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  readonly reconciliationMismatches = new Counter({
    name: 'wallet_reconciliation_mismatches_total',
    help: 'Wallet reconciliations where the ledger differs from the stored balance',
    registers: [this.registry],
  });
  readonly processingLatency = new Histogram({
    name: 'wager_processing_latency_seconds',
    help: 'Transaction processing latency',
    registers: [this.registry],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  });

  constructor() {
    this.reconciliationMismatches.inc(0);
    collectDefaultMetrics({ register: this.registry });
  }
}
