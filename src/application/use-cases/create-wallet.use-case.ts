import { createHash, randomUUID } from 'node:crypto';

import { WalletCreationStore } from '../ports/wallet-creation.store';
import { Wallet } from '../../domain/entities/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/entities/wager-transaction';
import { Money } from '../../domain/value-objects/money';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: {
    amount: string;
    currency: string;
  };
}

export class CreateWalletUseCase {
  constructor(
    private readonly walletCreationStore: WalletCreationStore,
  ) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const initialBalance = Money.from(input.initialBalance);

    const walletId = randomUUID();

    const wallet = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance,
    });

    if (initialBalance.isZero()) {
      await this.walletCreationStore.create(wallet);

      return wallet;
    }

    const now = new Date();
    const transactionId = randomUUID();

    const externalTransactionId = `opening:${walletId}`;
    const idempotencyKey = `internal:${externalTransactionId}`;

    const payloadHash = createHash('sha256')
      .update(
        [
          WagerTransactionKind.Opening,
          walletId,
          input.playerId,
          initialBalance.toJSON().amount,
          initialBalance.currency,
        ].join('|'),
      )
      .digest('hex');

    const openingTransaction = WagerTransaction.create({
      id: transactionId,
      providerId: 'internal',
      externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId,
      playerId: input.playerId,
      roundId: externalTransactionId,
      gameId: 'wallet-opening',
      kind: WagerTransactionKind.Opening,
      money: initialBalance,
      createdAt: now,
    });

    openingTransaction.markProcessed(undefined, now);

    const openingLedgerEntry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId,
      transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: now,
    });

    await this.walletCreationStore.create(
      wallet,
      openingTransaction,
      openingLedgerEntry,
    );

    return wallet;
  }
}
