import { Type } from 'class-transformer';
import {
  IsDefined, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateNested,
} from 'class-validator';
import { WagerTransactionKind } from '../domain/wager-transaction';

export class MoneyDto {
  @IsString()
  @Matches(/^(0|[1-9]\d{0,17})\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class SubmitWagerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  gameId!: string;

  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  referenceExternalTransactionId?: string;
}

export class SubmitWagerHeadersDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 512)
  idempotencyKey!: string;
}
