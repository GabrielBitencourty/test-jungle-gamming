import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../infrastructure/database.service';
import { QueueWorkersService } from '../infrastructure/queue-workers.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly queues: QueueWorkersService,
  ) {}

  @Get('live')
  live(): Record<string, string> {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<Record<string, string>> {
    let postgres = false;
    try {
      await this.database.execute('SELECT 1 AS ready');
      postgres = true;
    } catch {
      postgres = false;
    }
    const sqs = await this.queues.checkSqs();
    if (!postgres || !sqs) {
      throw new ServiceUnavailableException({ status: 'not_ready', postgres, sqs });
    }
    return { status: 'ready', postgres: 'ok', sqs: 'ok' };
  }
}
