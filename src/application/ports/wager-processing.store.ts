import { Wallet } from '../../domain/entities/wallet';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind } from '../../domain/entities/wager-transaction';

export const WAGER_PROCESSING_STORE = Symbol(
  'WAGER_PROCESSING_STORE',
);

export interface InboxMessageInput {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
}

export type InboxClaimResult =
  | 'CLAIMED'
  | 'DUPLICATE'
  | 'CONFLICT';

export interface WagerProcessingUnitOfWork {
  findWalletForUpdate(id: string): Promise<Wallet | null>;

  findTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;

  findTransactionByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;

  findProcessedReversalByReferenceTransactionId(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null>;

  findDuePendingReferenceTransactionIds(
    now: Date,
  ): Promise<string[]>;

  lockTransactionForPendingReferenceRetry(
    transactionId: string,
  ): Promise<WagerTransaction | null>;

  updateWallet(wallet: Wallet): Promise<void>;

  insertTransaction(
    transaction: WagerTransaction,
  ): Promise<void>;

  updateTransaction(
    transaction: WagerTransaction,
  ): Promise<void>;

  insertLedgerEntry(
    entry: WalletLedgerEntry,
  ): Promise<void>;

  claimInboxMessage(
    message: InboxMessageInput,
  ): Promise<InboxClaimResult>;

  markInboxMessageProcessed(
    consumerName: string,
    messageId: string,
    processedAt: Date,
  ): Promise<void>;
}

export interface WagerProcessingStore {
  execute<T>(
    work: (
      unitOfWork: WagerProcessingUnitOfWork,
    ) => Promise<T>,
  ): Promise<T>;
}
