import { BadRequestException, Injectable } from '@nestjs/common';
import { ProviderIdentityPort } from './provider-identity.port';

@Injectable()
export class NoopProviderIdentityAdapter extends ProviderIdentityPort {
  async assertProvider(providerId: string): Promise<void> {
    if (!providerId.trim()) {
      throw new BadRequestException({ code: 'PROVIDER_ID_REQUIRED', message: 'Provider ID is required' });
    }
  }
}
