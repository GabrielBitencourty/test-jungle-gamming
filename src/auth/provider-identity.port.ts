export abstract class ProviderIdentityPort {
  abstract assertProvider(providerId: string): Promise<void>;
}
