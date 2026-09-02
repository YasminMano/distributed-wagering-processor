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

    openingTransaction.markProcessed(undefined, now, wallet.balance);

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

    const processedEventId = randomUUID();
    const balanceEventId = randomUUID();

    await this.walletCreationStore.create(
      wallet,
      openingTransaction,
      openingLedgerEntry,
      [
        {
          id: processedEventId,
          aggregateId: openingTransaction.id,
          eventType: 'WagerTransactionProcessed',
          occurredAt: now,
          payload: {
            eventId: processedEventId,
            eventType: 'WagerTransactionProcessed',
            aggregateId: openingTransaction.id,
            correlationId: idempotencyKey,
            occurredAt: now.toISOString(),
            version: 1,
            data: {
              transactionId: openingTransaction.id,
              providerId: openingTransaction.providerId,
              externalTransactionId:
                openingTransaction.externalTransactionId,
              walletId,
              playerId: input.playerId,
              roundId: openingTransaction.roundId,
              gameId: openingTransaction.gameId,
              kind: openingTransaction.kind,
              money: initialBalance.toJSON(),
              status: openingTransaction.status,
              failureCode: null,
              referenceExternalTransactionId: null,
            },
          },
        },
        {
          id: balanceEventId,
          aggregateId: walletId,
          eventType: 'WalletBalanceChanged',
          occurredAt: now,
          payload: {
            eventId: balanceEventId,
            eventType: 'WalletBalanceChanged',
            aggregateId: walletId,
            correlationId: idempotencyKey,
            occurredAt: now.toISOString(),
            version: 1,
            data: {
              walletId,
              transactionId,
              direction: LedgerDirection.Credit,
              money: initialBalance.toJSON(),
              balanceBefore:
                Money.zero(initialBalance.currency).toJSON(),
              balanceAfter: initialBalance.toJSON(),
              walletVersion: wallet.version,
            },
          },
        },
      ],
    );

    return wallet;
  }
}
