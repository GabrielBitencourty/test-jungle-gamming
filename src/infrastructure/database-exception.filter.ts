import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { DriverException } from '@mikro-orm/core';

const TRANSIENT_CODES = new Set([
  '40001', '40P01', '55P03', '57014',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
]);

@Catch(DriverException)
export class DatabaseExceptionFilter implements ExceptionFilter<DriverException> {
  catch(exception: DriverException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    const code = exception.code ?? exception.sqlState;
    if ((code && (TRANSIENT_CODES.has(code) || code.startsWith('08'))) || exception.name === 'ConnectionException') {
      response.status(503).json({
        code: 'DATABASE_TRANSIENT_FAILURE',
        message: 'Database temporarily unavailable; retry the request with the same idempotency key',
      });
      return;
    }
    response.status(500).json({ code: 'DATABASE_ERROR', message: 'Database operation failed' });
  }
}
