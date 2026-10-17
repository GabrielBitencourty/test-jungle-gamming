import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

@Injectable()
export class SqsService implements OnModuleDestroy {
  readonly client: SQSClient;
  readonly transactionQueueUrl: string;
  readonly deadLetterQueueUrl: string;
  readonly eventQueueUrl: string;

  constructor() {
    this.transactionQueueUrl = process.env.SQS_TRANSACTION_QUEUE_URL ?? '';
    this.deadLetterQueueUrl = process.env.SQS_TRANSACTION_DLQ_URL ?? '';
    this.eventQueueUrl = process.env.SQS_EVENT_QUEUE_URL ?? '';
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT_URL || undefined,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.client.destroy();
  }
}
