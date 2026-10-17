import {
  BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpException, HttpStatus,
  Param, ParseIntPipe, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { CreateWalletDto, SubmitWagerDto } from './wagering.dto';
import { WageringService } from './wagering.service';

@Controller()
export class WageringController {
  constructor(private readonly wagering: WageringService) {}

  @Post('wallets')
  createWallet(@Body() body: CreateWalletDto): Promise<Record<string, unknown>> {
    return this.wagering.createWallet(body);
  }

  @Get('wallets/:walletId')
  getWallet(@Param('walletId', new ParseUUIDPipe()) walletId: string): Promise<Record<string, unknown>> {
    return this.wagering.getWallet(walletId);
  }

  @Get('wallets/:walletId/ledger')
  getLedger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<Record<string, unknown>> {
    return this.wagering.getLedger(walletId, cursor, limit ?? 50);
  }

  @Post('wagering/transactions')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Body() body: SubmitWagerDto,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<Record<string, unknown>> {
    if (!idempotencyKey?.trim() || idempotencyKey.length > 512) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required' });
    }
    const result = await this.wagering.process(body, { idempotencyKey, correlationId });
    if (result.status === 'REJECTED') throw new HttpException(result, 422);
    if (result.status === 'PENDING_REFERENCE') throw new HttpException(result, 202);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  getTransaction(@Param('transactionId', new ParseUUIDPipe()) id: string): Promise<Record<string, unknown>> {
    return this.wagering.getTransaction(id);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getProviderTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
  ): Promise<Record<string, unknown>> {
    return this.wagering.getProviderTransaction(providerId, externalId);
  }

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(@Param('walletId', new ParseUUIDPipe()) walletId: string): Promise<Record<string, unknown>> {
    return this.wagering.reconcile(walletId);
  }
}
