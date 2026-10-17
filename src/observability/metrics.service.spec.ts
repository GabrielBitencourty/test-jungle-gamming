import { describe, expect, test } from 'bun:test';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  test('exposes the reconciliation mismatch counter before the first mismatch', async () => {
    const metrics = new MetricsService();
    const output = await metrics.registry.metrics();
    expect(output).toContain('wallet_reconciliation_mismatches_total 0');
  });
});
