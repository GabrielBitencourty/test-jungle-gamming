import { describe, expect, test } from 'bun:test';
import { WagerTransactionProcessed } from './events';
import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';

describe('InboxMessage', () => {
  test('marks a received message exactly once', () => {
    const inbox = InboxMessage.receive({
      messageId: 'message-1',
      consumerName: 'wager-consumer',
      payloadHash: 'a'.repeat(64),
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(new Date());
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(new Date())).toThrow('already processed');
  });
});

describe('OutboxMessage', () => {
  test('schedules exponential retries and publishes once', () => {
    const event = new WagerTransactionProcessed('wallet-1', 'correlation-1', { status: 'PROCESSED' });
    const outbox = OutboxMessage.enqueue(event);
    const now = new Date();
    expect(outbox.isDue(now)).toBe(true);
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(new Date(now.getTime() + 999))).toBe(false);
    expect(outbox.isDue(new Date(now.getTime() + 1000))).toBe(true);
    outbox.markPublished(new Date(now.getTime() + 1000));
    expect(outbox.isPending()).toBe(false);
    expect(() => outbox.scheduleRetry(new Date())).toThrow('published');
  });
});
