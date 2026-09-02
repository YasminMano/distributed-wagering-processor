import { Wallet } from '../../domain/entities/wallet';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry';
import { WagerTransaction } from '../../domain/entities/wager-transaction';
import type { OutboxMessageInput } from './wager-processing.store';

export const WALLET_CREATION_STORE = Symbol('WALLET_CREATION_STORE');

export interface WalletCreationStore {
  create(
    wallet: Wallet,
    openingTransaction?: WagerTransaction,
    openingLedgerEntry?: WalletLedgerEntry,
    outboxMessages?: OutboxMessageInput[],
  ): Promise<void>;
}
