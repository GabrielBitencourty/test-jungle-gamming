import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ScheduleModule } from '@nestjs/schedule';
import mikroOrmConfig from '../mikro-orm.config';
import { DatabaseService } from './infrastructure/database.service';
import { QueueWorkersService } from './infrastructure/queue-workers.service';
import { SqsService } from './infrastructure/sqs.service';
import { StructuredLogger } from './infrastructure/logger.service';
import { HealthController } from './health/health.controller';
import { WageringController } from './wagering/wagering.controller';
import { WageringService } from './wagering/wagering.service';
import { MetricsService } from './observability/metrics.service';
import { MetricsController } from './observability/metrics.controller';
import { ProviderIdentityPort } from './auth/provider-identity.port';
import { NoopProviderIdentityAdapter } from './auth/noop-provider-identity.adapter';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    ScheduleModule.forRoot(),
  ],
  controllers: [HealthController, WageringController, MetricsController],
  providers: [
    DatabaseService, SqsService, StructuredLogger, WageringService, QueueWorkersService, MetricsService,
    { provide: ProviderIdentityPort, useClass: NoopProviderIdentityAdapter },
  ],
})
export class AppModule {}
