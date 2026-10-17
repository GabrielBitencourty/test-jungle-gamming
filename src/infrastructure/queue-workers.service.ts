import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WageringService } from '../wagering/wagering.service';
import { SubmitWagerDto } from '../wagering/wagering.dto';
import { SqsService } from './sqs.service';
import { StructuredLogger } from './logger.service';
import { MetricsService } from '../observability/metrics.service';

@Injectable()
export class QueueWorkersService implements OnApplicationShutdown, OnModuleInit {
  private stopped = false;
  private consuming = false;
  private publishing = false;
  private retryingReferences = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly sqs: SqsService,
    private readonly wagering: WageringService,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.sqs.transactionQueueUrl || !this.sqs.eventQueueUrl) {
      this.logger.error('SQS worker configuration is incomplete', new Error('Queue URL is missing'));
    }
  }

  @Interval(500)
  async consumeTransactions(): Promise<void> {
    if (this.stopped || this.consuming || !this.sqs.transactionQueueUrl) return;
    this.consuming = true;
    try {
      const response = await this.sqs.client.send(new ReceiveMessageCommand({
        QueueUrl: this.sqs.transactionQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }));
      if (this.stopped) {
        await Promise.all((response.Messages ?? []).map(async (message) => {
          if (!message.ReceiptHandle) return;
          await this.sqs.client.send(new ChangeMessageVisibilityCommand({
            QueueUrl: this.sqs.transactionQueueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          }));
        }));
        return;
      }
      for (const message of response.Messages ?? []) {
        if (!message.ReceiptHandle || !message.MessageId || !message.Body) continue;
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
        const work = this.processMessage(message.MessageId, message.ReceiptHandle, message.Body, receiveCount);
        this.inFlight.add(work);
        void work.finally(() => this.inFlight.delete(work));
      }
    } catch (error) {
      this.logger.error('SQS receive failed; queue will retry', error);
    } finally {
      this.consuming = false;
    }
  }

  @Interval(1000)
  async publishOutbox(): Promise<void> {
    if (this.stopped || this.publishing || !this.sqs.eventQueueUrl) return;
    this.publishing = true;
    try {
      const ids = await this.wagering.claimOutbox(10);
      for (const id of ids) {
        const message = await this.wagering.getOutboxMessage(id);
        if (!message) continue;
        try {
          await this.sqs.client.send(new SendMessageCommand({
            QueueUrl: this.sqs.eventQueueUrl,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: id,
          }));
          await this.wagering.markOutboxPublished(id);
        } catch (error) {
          await this.wagering.scheduleOutboxRetry(id);
          this.metrics.retries.inc({ worker: 'outbox_publisher' });
          this.logger.error('Outbox event publish failed', error, { transactionId: id });
        }
      }
    } catch (error) {
      this.logger.error('Outbox publisher failed', error);
    } finally {
      this.publishing = false;
    }
  }

  @Interval(1000)
  async retryReferences(): Promise<void> {
    if (this.stopped || this.retryingReferences) return;
    this.retryingReferences = true;
    try {
      await this.wagering.retryPendingReferences(20);
    } catch (error) {
      this.logger.error('Pending-reference worker failed', error);
    } finally {
      this.retryingReferences = false;
    }
  }

  @Interval(10_000)
  async updateDeadLetterMetric(): Promise<void> {
    if (!this.sqs.deadLetterQueueUrl) return;
    try {
      const response = await this.sqs.client.send(new GetQueueAttributesCommand({
        QueueUrl: this.sqs.deadLetterQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      this.metrics.deadLetterDepth.set(Number(response.Attributes?.ApproximateNumberOfMessages ?? 0));
    } catch (error) {
      if (!this.stopped) this.logger.error('Could not read DLQ depth', error);
    }
  }

  async checkSqs(): Promise<boolean> {
    try {
      await this.sqs.client.send(new GetQueueAttributesCommand({
        QueueUrl: this.sqs.transactionQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      return true;
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    while (this.consuming || this.publishing || this.retryingReferences) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pending = [...this.inFlight];
    if (pending.length) {
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (result.status === 'rejected') this.logger.error('In-flight SQS task failed during shutdown', result.reason);
      }
    }
  }

  private async processMessage(
    messageId: string,
    receiptHandle: string,
    body: string,
    receiveCount: number,
  ): Promise<void> {
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new PermanentMessageError('INVALID_JSON', 'SQS message is not valid JSON');
      }
      const candidate = typeof parsed === 'object' && parsed !== null && 'data' in parsed
        ? (parsed as { data: unknown }).data
        : parsed;
      const dto = plainToInstance(SubmitWagerDto, candidate);
      const errors = await validate(dto);
      if (errors.length) {
        throw new PermanentMessageError('INVALID_MESSAGE', 'SQS transaction message failed validation');
      }
      const result = await this.wagering.process(dto, {
        idempotencyKey: this.readIdempotencyKey(parsed, dto),
        source: { consumerName: 'wager-transaction-consumer', messageId },
        correlationId: this.readCorrelationId(parsed),
      });
      if ('duplicateMessage' in result) {
        await this.ack(receiptHandle);
        return;
      }
      await this.ack(receiptHandle);
    } catch (error) {
      if (error instanceof PermanentMessageError || this.isPermanentClientError(error)) {
        await this.toDeadLetter(messageId, receiptHandle, body, error);
        return;
      }
      this.metrics.retries.inc({ worker: 'sqs_consumer' });
      this.logger.error('Transaction message processing failed; leaving for redelivery', error, { messageId });
      try {
        await this.sqs.client.send(new ChangeMessageVisibilityCommand({
          QueueUrl: this.sqs.transactionQueueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: Math.min(300, 2 ** Math.min(Math.max(receiveCount, 1), 8)),
        }));
      } catch (visibilityError) {
        this.logger.error('Could not shorten visibility timeout', visibilityError, { messageId });
      }
    }
  }

  private async ack(receiptHandle: string): Promise<void> {
    await this.sqs.client.send(new DeleteMessageCommand({
      QueueUrl: this.sqs.transactionQueueUrl,
      ReceiptHandle: receiptHandle,
    }));
  }

  private async toDeadLetter(messageId: string, receiptHandle: string, body: string, error: unknown): Promise<void> {
    try {
      await this.sqs.client.send(new SendMessageCommand({
        QueueUrl: this.sqs.deadLetterQueueUrl,
        MessageBody: body,
        MessageGroupId: 'invalid',
        MessageDeduplicationId: messageId,
      }));
      this.metrics.deadLetters.inc();
      await this.ack(receiptHandle);
      this.logger.error('Permanently invalid transaction message sent to DLQ', error, { messageId });
    } catch (dlqError) {
      this.logger.error('Failed to move permanent message to DLQ; leaving it for retry', dlqError, { messageId });
    }
  }

  private isPermanentClientError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('status' in error)) return false;
    const status = error.status;
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
  }

  private readIdempotencyKey(parsed: unknown, dto: SubmitWagerDto): string {
    if (typeof parsed === 'object' && parsed !== null && 'data' in parsed) {
      const data = (parsed as { data: unknown }).data;
      if (typeof data === 'object' && data !== null && 'idempotencyKey' in data) {
        const key = (data as { idempotencyKey: unknown }).idempotencyKey;
        if (typeof key === 'string' && key.length > 0) return key;
      }
    }
    return `${dto.providerId}:${dto.externalTransactionId}`;
  }

  private readCorrelationId(parsed: unknown): string | undefined {
    if (typeof parsed === 'object' && parsed !== null && 'correlationId' in parsed) {
      const id = (parsed as { correlationId: unknown }).correlationId;
      if (typeof id === 'string') return id;
    }
    return undefined;
  }
}

class PermanentMessageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
