import { Injectable } from '@nestjs/common';

@Injectable()
export class StructuredLogger {
  info(message: string, context: Record<string, string | number | boolean | undefined> = {}): void {
    console.log(JSON.stringify({ level: 'info', message, timestamp: new Date().toISOString(), ...context }));
  }

  error(message: string, error: unknown, context: Record<string, string | number | boolean | undefined> = {}): void {
    const detail = error instanceof Error
      ? { errorName: error.name, ...(this.getErrorCode(error) ? { errorCode: this.getErrorCode(error) } : {}) }
      : { errorName: 'UnknownError' };
    console.error(JSON.stringify({ level: 'error', message, timestamp: new Date().toISOString(), ...context, ...detail }));
  }

  private getErrorCode(error: Error): string | undefined {
    if (!('code' in error)) return undefined;
    const code = error.code;
    return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
  }
}
