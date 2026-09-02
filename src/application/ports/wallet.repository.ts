import { Wallet } from '../../domain/entities/wallet';

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;

  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null>;

  insert(wallet: Wallet): Promise<void>;
}