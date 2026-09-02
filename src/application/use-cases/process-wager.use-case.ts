import { createHash, randomUUID } from 'node:crypto';

import {
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
} from '../../domain/entities/wager-transaction';
import { Money } from '../../domain/value-objects/money';

export const WagerFailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  PlayerMismatch: 'PLAYER_MISMATCH',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
} as const;

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
}

export interface ProcessWagerResult {
  transaction: WagerTransaction;
  replayed: boolean;
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

    return this.store.execute(async (unitOfWork) => {
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
    });
  }

  private async persistFinancialMovement(
    unitOfWork: WagerProcessingUnitOfWork,
    wallet: Parameters<
      WagerProcessingUnitOfWork['updateWallet']
    >[0],
    transaction: WagerTransaction,
    ledgerEntry: WalletLedgerEntry,
  ): Promise<void> {
    await unitOfWork.updateWallet(wallet);
    await unitOfWork.insertTransaction(transaction);
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
      kind !== WagerTransactionKind.Loss
    ) {
      throw new Error(
        `${kind} is not supported by this processing flow yet`,
      );
    }
  }
}
