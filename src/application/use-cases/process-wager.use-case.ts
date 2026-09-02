import { createHash, randomUUID } from 'node:crypto';

import {
  InboxMessageInput,
  WagerProcessingStore,
  WagerProcessingUnitOfWork,
} from '../ports/wager-processing.store';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import { Money } from '../../domain/value-objects/money';

export const WagerFailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  PlayerMismatch: 'PLAYER_MISMATCH',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed: 'ALREADY_REVERSED',
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
} as const;

export const PENDING_REFERENCE_MAX_ATTEMPTS = 5;
export const PENDING_REFERENCE_BASE_DELAY_MS = 100;

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used with a different payload');
    this.name = 'IdempotencyConflictError';
  }
}

export class ExternalTransactionConflictError extends Error {
  constructor() {
    super('Provider transaction already exists');
    this.name = 'ExternalTransactionConflictError';
  }
}

export class InboxMessageConflictError extends Error {
  constructor() {
    super('Inbox message id was already used with a different payload');
    this.name = 'InboxMessageConflictError';
  }
}

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} was not found`);
    this.name = 'WalletNotFoundError';
  }
}

export interface ProcessWagerInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerResult {
  transaction: WagerTransaction;
  replayed: boolean;
}

export interface ProcessWagerFromInboxResult
  extends ProcessWagerResult {
  inboxDuplicate: boolean;
}

export class ProcessWagerUseCase {
  constructor(
    private readonly store: WagerProcessingStore,
  ) {}

  async execute(
    input: ProcessWagerInput,
  ): Promise<ProcessWagerResult> {
    this.assertSupportedKind(input.kind);

    const money = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    const payloadHash = this.createPayloadHash(
      input,
      money,
    );

    return this.store.execute((unitOfWork) =>
      this.processInsideTransaction(
        unitOfWork,
        input,
        money,
        payloadHash,
      ),
    );
  }

  async executeFromInbox(
    input: ProcessWagerInput,
    inbox: InboxMessageInput,
  ): Promise<ProcessWagerFromInboxResult> {
    this.assertSupportedKind(input.kind);

    const money = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    const payloadHash = this.createPayloadHash(
      input,
      money,
    );

    return this.store.execute(async (unitOfWork) => {
      const claim =
        await unitOfWork.claimInboxMessage(inbox);

      if (claim === 'CONFLICT') {
        throw new InboxMessageConflictError();
      }

      const result =
        await this.processInsideTransaction(
          unitOfWork,
          input,
          money,
          payloadHash,
        );

      if (claim === 'CLAIMED') {
        await unitOfWork.markInboxMessageProcessed(
          inbox.consumerName,
          inbox.messageId,
          new Date(),
        );
      }

      return {
        ...result,
        inboxDuplicate: claim === 'DUPLICATE',
      };
    });
  }

  private async processInsideTransaction(
    unitOfWork: WagerProcessingUnitOfWork,
    input: ProcessWagerInput,
    money: Money,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const existing =
      await unitOfWork.findTransactionByIdempotencyKey(
        input.idempotencyKey,
      );

    if (existing) {
      return this.handleExisting(
        existing,
        payloadHash,
      );
    }

    const wallet = await unitOfWork.findWalletForUpdate(
      input.walletId,
    );

    if (!wallet) {
      throw new WalletNotFoundError(input.walletId);
    }

    /*
     * Re-check after acquiring the wallet lock.
     *
     * Two concurrent requests can both observe that the
     * idempotency key does not exist before one of them
     * obtains the wallet lock.
     */
    const existingAfterLock =
      await unitOfWork.findTransactionByIdempotencyKey(
        input.idempotencyKey,
      );

    if (existingAfterLock) {
      return this.handleExisting(
        existingAfterLock,
        payloadHash,
      );
    }

    const existingExternal =
      await unitOfWork.findTransactionByProviderAndExternalId(
        input.providerId,
        input.externalTransactionId,
      );

    if (existingExternal) {
      throw new ExternalTransactionConflictError();
    }

    const now = new Date();

    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: input.providerId,
      externalTransactionId:
        input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      referenceExternalTransactionId:
        input.referenceExternalTransactionId,
      createdAt: now,
    });

    if (wallet.playerId !== input.playerId) {
      transaction.reject(
        WagerFailureCode.PlayerMismatch,
      );

      await unitOfWork.insertTransaction(transaction);

      return {
        transaction,
        replayed: false,
      };
    }

    if (wallet.currency !== money.currency) {
      transaction.reject(
        WagerFailureCode.CurrencyMismatch,
      );

      await unitOfWork.insertTransaction(transaction);

      return {
        transaction,
        replayed: false,
      };
    }

    if (
      input.kind === WagerTransactionKind.Refund ||
      input.kind === WagerTransactionKind.Rollback
    ) {
      return this.processReversal(
        unitOfWork,
        wallet,
        transaction,
        money,
        now,
      );
    }

    if (
      input.kind === WagerTransactionKind.Bet &&
      wallet.balance.isLessThan(money)
    ) {
      transaction.reject(
        WagerFailureCode.InsufficientFunds,
      );

      await unitOfWork.insertTransaction(transaction);

      return {
        transaction,
        replayed: false,
      };
    }

    if (input.kind === WagerTransactionKind.Loss) {
      transaction.markProcessed(undefined, now);

      await unitOfWork.insertTransaction(transaction);

      return {
        transaction,
        replayed: false,
      };
    }

    const balanceBefore = wallet.balance;

    const direction =
      input.kind === WagerTransactionKind.Bet
        ? LedgerDirection.Debit
        : LedgerDirection.Credit;

    if (direction === LedgerDirection.Debit) {
      wallet.debit(money);
    } else {
      wallet.credit(money);
    }

    transaction.markProcessed(undefined, now);

    const ledgerEntry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction,
      money,
      balanceBefore,
      balanceAfter: wallet.balance,
      createdAt: now,
    });

    await this.persistFinancialMovement(
      unitOfWork,
      wallet,
      transaction,
      ledgerEntry,
    );

    return {
      transaction,
      replayed: false,
    };
  }

  async retryPendingReference(
    transactionId: string,
    now: Date,
  ): Promise<ProcessWagerResult | null> {
    return this.store.execute(async (unitOfWork) => {
      const transaction =
        await unitOfWork.lockTransactionForPendingReferenceRetry(
          transactionId,
        );

      if (
        !transaction ||
        transaction.status !==
          WagerTransactionStatus.PendingReference
      ) {
        return null;
      }

      const wallet = await unitOfWork.findWalletForUpdate(
        transaction.walletId,
      );

      if (!wallet) {
        throw new WalletNotFoundError(transaction.walletId);
      }

      return this.processReversal(
        unitOfWork,
        wallet,
        transaction,
        transaction.money,
        now,
        true,
      );
    });
  }

  private async processReversal(
    unitOfWork: WagerProcessingUnitOfWork,
    wallet: Parameters<
      WagerProcessingUnitOfWork['updateWallet']
    >[0],
    transaction: WagerTransaction,
    money: Money,
    now: Date,
    isRetry = false,
  ): Promise<ProcessWagerResult> {
    const referenceExternalTransactionId =
      transaction.referenceExternalTransactionId;

    if (!referenceExternalTransactionId) {
      throw new Error(
        `${transaction.kind} requires referenceExternalTransactionId`,
      );
    }

    const reference =
      await unitOfWork.findTransactionByProviderAndExternalId(
        transaction.providerId,
        referenceExternalTransactionId,
      );

    /*
    * A operação dependente chegou antes da transação
    * referenciada. Ela precisa permanecer auditável para
    * um worker tentar novamente posteriormente.
    */

    if (!reference) {
      this.schedulePendingReference(
        transaction,
        now,
        isRetry,
      );

      await this.persistReversalTransaction(
        unitOfWork,
        transaction,
        isRetry,
      );

      return {
        transaction,
        replayed: false,
      };
    }

    if (
      reference.providerId !== transaction.providerId ||
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.roundId !== transaction.roundId ||
      reference.money.currency !== money.currency ||
      !reference.money.equals(money)
    ) {
      transaction.reject(
        WagerFailureCode.ReferenceMismatch,
      );

      await this.persistReversalTransaction(unitOfWork, transaction, isRetry);

      return {
        transaction,
        replayed: false,
      };
    }

    if (!this.isAllowedReference(transaction, reference)) {
      transaction.reject(
        WagerFailureCode.InvalidReferenceKind,
      );

      await this.persistReversalTransaction(unitOfWork, transaction, isRetry);

      return {
        transaction,
        replayed: false,
      };
    }

    const previousReversal =
      await unitOfWork.findProcessedReversalByReferenceTransactionId(
        reference.id,
        transaction.kind,
      );

    if (previousReversal) {
      transaction.reject(
        WagerFailureCode.AlreadyReversed,
      );

      await this.persistReversalTransaction(unitOfWork, transaction, isRetry);

      return {
        transaction,
        replayed: false,
      };
    }

    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status ===
        WagerTransactionStatus.PendingReference
    ) {
      this.schedulePendingReference(
        transaction,
        now,
        isRetry,
      );

      await this.persistReversalTransaction(
        unitOfWork,
        transaction,
        isRetry,
      );

      return {
        transaction,
        replayed: false,
      };
    }

    if (
      reference.status !==
      WagerTransactionStatus.Processed
    ) {
      transaction.reject(
        WagerFailureCode.ReferenceNotProcessed,
      );

      await this.persistReversalTransaction(unitOfWork, transaction, isRetry);

      return {
        transaction,
        replayed: false,
      };
    }

    const direction =
      transaction.ledgerDirectionFor(reference);

    if (
      direction === LedgerDirection.Debit &&
      wallet.balance.isLessThan(money)
    ) {
      transaction.reject(
        WagerFailureCode.ReversalInsufficientFunds,
      );

      await this.persistReversalTransaction(unitOfWork, transaction, isRetry);

      return {
        transaction,
        replayed: false,
      };
    }

    const balanceBefore = wallet.balance;

    if (direction === LedgerDirection.Debit) {
      wallet.debit(money);
    } else {
      wallet.credit(money);
    }

    transaction.markProcessed(reference.id, now);

    const ledgerEntry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction,
      money,
      balanceBefore,
      balanceAfter: wallet.balance,
      createdAt: now,
    });

    await this.persistFinancialMovement(
      unitOfWork,
      wallet,
      transaction,
      ledgerEntry,
      isRetry,
    );

    return {
      transaction,
      replayed: false,
    };
  }

  private schedulePendingReference(
    transaction: WagerTransaction,
    now: Date,
    isRetry: boolean,
  ): void {
    if (!isRetry) {
      transaction.markPendingReference(
        this.nextRetryAt(now, 0),
      );
      return;
    }

    const retryAttempts = transaction.retryAttempts + 1;

    if (retryAttempts >= PENDING_REFERENCE_MAX_ATTEMPTS) {
      transaction.reject(WagerFailureCode.ReferenceNotFound);
      return;
    }

    transaction.scheduleNextReferenceRetry(
      retryAttempts,
      this.nextRetryAt(now, retryAttempts),
    );
  }

  private nextRetryAt(now: Date, retryAttempts: number): Date {
    const delay =
      PENDING_REFERENCE_BASE_DELAY_MS *
      2 ** retryAttempts;

    return new Date(now.getTime() + delay);
  }

  private async persistReversalTransaction(
    unitOfWork: WagerProcessingUnitOfWork,
    transaction: WagerTransaction,
    isRetry: boolean,
  ): Promise<void> {
    if (isRetry) {
      await unitOfWork.updateTransaction(transaction);
      return;
    }

    await unitOfWork.insertTransaction(transaction);
  }

  private isAllowedReference(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): boolean {
    if (
      transaction.kind === WagerTransactionKind.Refund
    ) {
      return reference.kind === WagerTransactionKind.Bet;
    }

    if (
      transaction.kind === WagerTransactionKind.Rollback
    ) {
      return (
        reference.kind === WagerTransactionKind.Bet ||
        reference.kind === WagerTransactionKind.Win ||
        reference.kind === WagerTransactionKind.Refund
      );
    }

    return false;
  }

  private async persistFinancialMovement(
    unitOfWork: WagerProcessingUnitOfWork,
    wallet: Parameters<
      WagerProcessingUnitOfWork['updateWallet']
    >[0],
    transaction: WagerTransaction,
    ledgerEntry: WalletLedgerEntry,
    updateExistingTransaction = false,
  ): Promise<void> {
    await unitOfWork.updateWallet(wallet);
    if (updateExistingTransaction) {
      await unitOfWork.updateTransaction(transaction);
    } else {
      await unitOfWork.insertTransaction(transaction);
    }
    await unitOfWork.insertLedgerEntry(ledgerEntry);
  }

  private handleExisting(
    existing: WagerTransaction,
    payloadHash: string,
  ): ProcessWagerResult {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError();
    }

    return {
      transaction: existing,
      replayed: true,
    };
  }

  private createPayloadHash(
    input: ProcessWagerInput,
    money: Money,
  ): string {
    const canonicalPayload = JSON.stringify([
      input.providerId,
      input.externalTransactionId,
      input.walletId,
      input.playerId,
      input.roundId,
      input.gameId,
      input.kind,
      input.referenceExternalTransactionId ?? null,
      money.toJSON().amount,
      money.currency,
    ]);

    return createHash('sha256')
      .update(canonicalPayload)
      .digest('hex');
  }

  private assertSupportedKind(
    kind: WagerTransactionKind,
  ): void {
    if (
      kind !== WagerTransactionKind.Bet &&
      kind !== WagerTransactionKind.Win &&
      kind !== WagerTransactionKind.Loss &&
      kind !== WagerTransactionKind.Refund &&
      kind !== WagerTransactionKind.Rollback
    ) {
      throw new Error(
        `${kind} is not supported by this processing flow`,
      );
    }
  }
}
