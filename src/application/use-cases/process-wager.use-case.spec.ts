import {
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  InboxClaimResult,
  InboxMessageInput,
  OutboxMessageInput,
  WagerProcessingStore,
  WagerProcessingUnitOfWork,
} from '../ports/wager-processing.store';
import { Wallet } from '../../domain/entities/wallet';
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
import {
  IdempotencyConflictError,
  ProcessWagerInput,
  ProcessWagerUseCase,
  WagerFailureCode,
} from './process-wager.use-case';

class FakeWagerProcessingUnitOfWork
  implements WagerProcessingUnitOfWork
{
  readonly transactions: WagerTransaction[] = [];
  readonly ledgerEntries: WalletLedgerEntry[] = [];
  readonly outboxMessages: OutboxMessageInput[] = [];
  updateWalletCalls = 0;

  constructor(public wallet: Wallet | null) {}

  async findWalletForUpdate(
    id: string,
  ): Promise<Wallet | null> {
    if (!this.wallet || this.wallet.id !== id) {
      return null;
    }

    return this.wallet;
  }

  async findTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.transactions.find(
        (transaction) =>
          transaction.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async findTransactionByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.transactions.find(
        (transaction) =>
          transaction.providerId === providerId &&
          transaction.externalTransactionId ===
            externalTransactionId,
      ) ?? null
    );
  }

  async findProcessedReversalByReferenceTransactionId(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null> {
    return (
      this.transactions.find(
        (transaction) =>
          transaction.referenceTransactionId ===
            referenceTransactionId &&
          transaction.kind === kind &&
          transaction.status ===
            WagerTransactionStatus.Processed,
      ) ?? null
    );
  }

  async findDuePendingReferenceTransactionIds(
    now: Date,
  ): Promise<string[]> {
    return this.transactions
      .filter(
        (transaction) =>
          transaction.status ===
            WagerTransactionStatus.PendingReference &&
          transaction.nextRetryAt !== undefined &&
          transaction.nextRetryAt <= now,
      )
      .map((transaction) => transaction.id);
  }

  async lockTransactionForPendingReferenceRetry(
    transactionId: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.transactions.find(
        (transaction) => transaction.id === transactionId,
      ) ?? null
    );
  }

  async updateWallet(wallet: Wallet): Promise<void> {
    this.wallet = wallet;
    this.updateWalletCalls += 1;
  }

  async insertTransaction(
    transaction: WagerTransaction,
  ): Promise<void> {
    this.transactions.push(transaction);
  }

  async updateTransaction(
    transaction: WagerTransaction,
  ): Promise<void> {
    const index = this.transactions.findIndex(
      (existing) => existing.id === transaction.id,
    );

    if (index === -1) {
      throw new Error('Transaction does not exist');
    }

    this.transactions[index] = transaction;
  }

  async claimInboxMessage(
    _message: InboxMessageInput,
  ): Promise<InboxClaimResult> {
    return 'CLAIMED';
  }

  async markInboxMessageProcessed(
    _consumerName: string,
    _messageId: string,
    _processedAt: Date,
  ): Promise<void> {}

  async insertLedgerEntry(
    entry: WalletLedgerEntry,
  ): Promise<void> {
    this.ledgerEntries.push(entry);
  }

  async insertOutboxMessage(
    message: OutboxMessageInput,
  ): Promise<void> {
    this.outboxMessages.push(message);
  }
}

class FakeWagerProcessingStore
  implements WagerProcessingStore
{
  constructor(
    readonly unitOfWork: FakeWagerProcessingUnitOfWork,
  ) {}

  async execute<T>(
    work: (
      unitOfWork: WagerProcessingUnitOfWork,
    ) => Promise<T>,
  ): Promise<T> {
    return work(this.unitOfWork);
  }
}

describe('ProcessWagerUseCase', () => {
  let unitOfWork: FakeWagerProcessingUnitOfWork;
  let useCase: ProcessWagerUseCase;

  beforeEach(() => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    unitOfWork =
      new FakeWagerProcessingUnitOfWork(wallet);

    useCase = new ProcessWagerUseCase(
      new FakeWagerProcessingStore(unitOfWork),
    );
  });

  function input(
    overrides: Partial<ProcessWagerInput> = {},
  ): ProcessWagerInput {
    return {
      idempotencyKey: 'idem-1',
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      amount: '80.00',
      currency: 'BRL',
      ...overrides,
    };
  }

  test('processes a BET by debiting the wallet and creating one ledger entry', async () => {
    const result = await useCase.execute(input());

    expect(result.replayed).toBe(false);
    expect(result.transaction.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });
    expect(unitOfWork.wallet?.version).toBe(2);

    expect(unitOfWork.transactions).toHaveLength(1);
    expect(unitOfWork.ledgerEntries).toHaveLength(1);
    expect(unitOfWork.updateWalletCalls).toBe(1);

    const ledger = unitOfWork.ledgerEntries[0];

    expect(ledger.direction).toBe(
      LedgerDirection.Debit,
    );
    expect(ledger.balanceBefore.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(ledger.balanceAfter.toJSON()).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });
  });

  test('rejects a BET when the wallet has insufficient funds', async () => {
    const result = await useCase.execute(
      input({
        amount: '120.00',
      }),
    );

    expect(result.transaction.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(result.transaction.failureCode).toBe(
      WagerFailureCode.InsufficientFunds,
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(unitOfWork.wallet?.version).toBe(1);
    expect(unitOfWork.ledgerEntries).toHaveLength(0);
    expect(unitOfWork.updateWalletCalls).toBe(0);
  });

  test('processes a WIN by crediting the wallet', async () => {
    const result = await useCase.execute(
      input({
        kind: WagerTransactionKind.Win,
        amount: '25.00',
      }),
    );

    expect(result.transaction.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '125.00',
      currency: 'BRL',
    });

    expect(unitOfWork.ledgerEntries).toHaveLength(1);
    expect(unitOfWork.ledgerEntries[0].direction).toBe(
      LedgerDirection.Credit,
    );
  });

  test('processes LOSS without changing the wallet or creating a ledger entry', async () => {
    const result = await useCase.execute(
      input({
        kind: WagerTransactionKind.Loss,
      }),
    );

    expect(result.transaction.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(unitOfWork.wallet?.version).toBe(1);
    expect(unitOfWork.ledgerEntries).toHaveLength(0);
    expect(unitOfWork.updateWalletCalls).toBe(0);
  });

  test('replays the same idempotency key without applying the financial effect twice', async () => {
    const first = await useCase.execute(input());
    const second = await useCase.execute(input());

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);

    expect(second.transaction.id).toBe(
      first.transaction.id,
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });

    expect(unitOfWork.transactions).toHaveLength(1);
    expect(unitOfWork.ledgerEntries).toHaveLength(1);
    expect(unitOfWork.updateWalletCalls).toBe(1);
  });

  test('rejects reuse of an idempotency key with a different payload', async () => {
    await useCase.execute(input());

    await expect(
      useCase.execute(
        input({
          amount: '70.00',
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });
    expect(unitOfWork.transactions).toHaveLength(1);
    expect(unitOfWork.ledgerEntries).toHaveLength(1);
  });

  test('rejects a player mismatch without changing the balance', async () => {
    const result = await useCase.execute(
      input({
        playerId: 'another-player',
      }),
    );

    expect(result.transaction.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(result.transaction.failureCode).toBe(
      WagerFailureCode.PlayerMismatch,
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(unitOfWork.ledgerEntries).toHaveLength(0);
  });

  test('rejects a currency mismatch without changing the balance', async () => {
    const result = await useCase.execute(
      input({
        currency: 'USD',
      }),
    );

    expect(result.transaction.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(result.transaction.failureCode).toBe(
      WagerFailureCode.CurrencyMismatch,
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(unitOfWork.ledgerEntries).toHaveLength(0);
  });

  test('processes a REFUND of a processed BET by crediting the wallet', async () => {
    const bet = await useCase.execute(
      input({
        idempotencyKey: 'bet-idem',
        externalTransactionId: 'bet-external',
        kind: WagerTransactionKind.Bet,
        amount: '80.00',
        roundId: 'round-refund',
      }),
    );

    expect(bet.transaction.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });

    const refund = await useCase.execute(
      input({
        idempotencyKey: 'refund-idem',
        externalTransactionId: 'refund-external',
        kind: WagerTransactionKind.Refund,
        amount: '80.00',
        roundId: 'round-refund',
        referenceExternalTransactionId: 'bet-external',
      }),
    );

    expect(refund.transaction.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(refund.transaction.referenceTransactionId).toBe(
      bet.transaction.id,
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });

    expect(unitOfWork.wallet?.version).toBe(3);

    expect(unitOfWork.ledgerEntries).toHaveLength(2);
    expect(unitOfWork.ledgerEntries[1].direction).toBe(
      LedgerDirection.Credit,
    );
  });

  test('processes a ROLLBACK of a processed BET by crediting the wallet', async () => {
    const bet = await useCase.execute(
      input({
        idempotencyKey: 'rollback-bet-idem',
        externalTransactionId: 'rollback-bet-external',
        kind: WagerTransactionKind.Bet,
        amount: '80.00',
        roundId: 'round-rollback-bet',
      }),
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });

    const rollback = await useCase.execute(
      input({
        idempotencyKey: 'rollback-idem',
        externalTransactionId: 'rollback-external',
        kind: WagerTransactionKind.Rollback,
        amount: '80.00',
        roundId: 'round-rollback-bet',
        referenceExternalTransactionId:
          'rollback-bet-external',
      }),
    );

    expect(rollback.transaction.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(rollback.transaction.referenceTransactionId).toBe(
      bet.transaction.id,
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });

    expect(unitOfWork.ledgerEntries).toHaveLength(2);
    expect(unitOfWork.ledgerEntries[1].direction).toBe(
      LedgerDirection.Credit,
    );
  });

  test('processes a ROLLBACK of a processed WIN by debiting the wallet', async () => {
    const win = await useCase.execute(
      input({
        idempotencyKey: 'win-idem',
        externalTransactionId: 'win-external',
        kind: WagerTransactionKind.Win,
        amount: '25.00',
        roundId: 'round-rollback-win',
      }),
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '125.00',
      currency: 'BRL',
    });

    const rollback = await useCase.execute(
      input({
        idempotencyKey: 'win-rollback-idem',
        externalTransactionId: 'win-rollback-external',
        kind: WagerTransactionKind.Rollback,
        amount: '25.00',
        roundId: 'round-rollback-win',
        referenceExternalTransactionId: 'win-external',
      }),
    );

    expect(rollback.transaction.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(rollback.transaction.referenceTransactionId).toBe(
      win.transaction.id,
    );

    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });

    expect(unitOfWork.ledgerEntries).toHaveLength(2);
    expect(unitOfWork.ledgerEntries[1].direction).toBe(
      LedgerDirection.Debit,
    );
  });

  test('rejects a second REFUND of the same reference', async () => {
    await useCase.execute(
      input({
        idempotencyKey: 'refund-bet-idem',
        externalTransactionId: 'refund-bet-external',
        kind: WagerTransactionKind.Bet,
        amount: '80.00',
        roundId: 'round-second-refund',
      }),
    );

    await useCase.execute(
      input({
        idempotencyKey: 'first-refund-idem',
        externalTransactionId: 'first-refund-external',
        kind: WagerTransactionKind.Refund,
        amount: '80.00',
        roundId: 'round-second-refund',
        referenceExternalTransactionId: 'refund-bet-external',
      }),
    );

    const secondRefund = await useCase.execute(
      input({
        idempotencyKey: 'second-refund-idem',
        externalTransactionId: 'second-refund-external',
        kind: WagerTransactionKind.Refund,
        amount: '80.00',
        roundId: 'round-second-refund',
        referenceExternalTransactionId: 'refund-bet-external',
      }),
    );

    expect(secondRefund.transaction.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(secondRefund.transaction.failureCode).toBe(
      WagerFailureCode.AlreadyReversed,
    );
    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(unitOfWork.wallet?.version).toBe(3);
    expect(unitOfWork.ledgerEntries).toHaveLength(2);
  });

  test('rejects a second ROLLBACK of the same reference', async () => {
    await useCase.execute(
      input({
        idempotencyKey: 'rollback-bet-idem',
        externalTransactionId: 'rollback-bet-external',
        kind: WagerTransactionKind.Bet,
        amount: '80.00',
        roundId: 'round-second-rollback',
      }),
    );

    await useCase.execute(
      input({
        idempotencyKey: 'first-rollback-idem',
        externalTransactionId: 'first-rollback-external',
        kind: WagerTransactionKind.Rollback,
        amount: '80.00',
        roundId: 'round-second-rollback',
        referenceExternalTransactionId: 'rollback-bet-external',
      }),
    );

    const secondRollback = await useCase.execute(
      input({
        idempotencyKey: 'second-rollback-idem',
        externalTransactionId: 'second-rollback-external',
        kind: WagerTransactionKind.Rollback,
        amount: '80.00',
        roundId: 'round-second-rollback',
        referenceExternalTransactionId: 'rollback-bet-external',
      }),
    );

    expect(secondRollback.transaction.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(secondRollback.transaction.failureCode).toBe(
      WagerFailureCode.AlreadyReversed,
    );
    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(unitOfWork.wallet?.version).toBe(3);
    expect(unitOfWork.ledgerEntries).toHaveLength(2);
  });

  test('rejects a ROLLBACK of a WIN when the wallet no longer has sufficient funds', async () => {
    await useCase.execute(
      input({
        idempotencyKey: 'rollback-win-idem',
        externalTransactionId: 'rollback-win-external',
        kind: WagerTransactionKind.Win,
        amount: '80.00',
        roundId: 'round-rollback-insufficient',
      }),
    );

    await useCase.execute(
      input({
        idempotencyKey: 'later-bet-idem',
        externalTransactionId: 'later-bet-external',
        kind: WagerTransactionKind.Bet,
        amount: '150.00',
        roundId: 'round-later-bet',
      }),
    );

    const rollback = await useCase.execute(
      input({
        idempotencyKey: 'insufficient-rollback-idem',
        externalTransactionId: 'insufficient-rollback-external',
        kind: WagerTransactionKind.Rollback,
        amount: '80.00',
        roundId: 'round-rollback-insufficient',
        referenceExternalTransactionId: 'rollback-win-external',
      }),
    );

    expect(rollback.transaction.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(rollback.transaction.failureCode).toBe(
      WagerFailureCode.ReversalInsufficientFunds,
    );
    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '30.00',
      currency: 'BRL',
    });
    expect(unitOfWork.wallet?.version).toBe(3);
    expect(unitOfWork.ledgerEntries).toHaveLength(2);
  });

  test('keeps a reversal pending when its reference is missing', async () => {
    const refund = await useCase.execute(
      input({
        idempotencyKey: 'missing-reference-idem',
        externalTransactionId: 'missing-reference-external',
        kind: WagerTransactionKind.Refund,
        amount: '80.00',
        referenceExternalTransactionId: 'absent-external',
      }),
    );

    expect(refund.transaction.status).toBe(
      WagerTransactionStatus.PendingReference,
    );
    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(unitOfWork.wallet?.version).toBe(1);
    expect(unitOfWork.updateWalletCalls).toBe(0);
    expect(unitOfWork.ledgerEntries).toHaveLength(0);
  });

  test('rejects a REFUND that references a WIN', async () => {
    await useCase.execute(
      input({
        idempotencyKey: 'reference-win-idem',
        externalTransactionId: 'reference-win-external',
        kind: WagerTransactionKind.Win,
        amount: '25.00',
        roundId: 'round-invalid-refund',
      }),
    );

    const refund = await useCase.execute(
      input({
        idempotencyKey: 'invalid-refund-idem',
        externalTransactionId: 'invalid-refund-external',
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        roundId: 'round-invalid-refund',
        referenceExternalTransactionId: 'reference-win-external',
      }),
    );

    expect(refund.transaction.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(refund.transaction.failureCode).toBe(
      WagerFailureCode.InvalidReferenceKind,
    );
    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '125.00',
      currency: 'BRL',
    });
    expect(unitOfWork.wallet?.version).toBe(2);
    expect(unitOfWork.ledgerEntries).toHaveLength(1);
  });

  test('rejects a reversal when its reference scope does not match', async () => {
    await useCase.execute(
      input({
        idempotencyKey: 'mismatch-bet-idem',
        externalTransactionId: 'mismatch-bet-external',
        kind: WagerTransactionKind.Bet,
        amount: '80.00',
        roundId: 'round-reference',
      }),
    );

    const refund = await useCase.execute(
      input({
        idempotencyKey: 'mismatch-refund-idem',
        externalTransactionId: 'mismatch-refund-external',
        kind: WagerTransactionKind.Refund,
        amount: '80.00',
        roundId: 'round-different',
        referenceExternalTransactionId: 'mismatch-bet-external',
      }),
    );

    expect(refund.transaction.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(refund.transaction.failureCode).toBe(
      WagerFailureCode.ReferenceMismatch,
    );
    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });
    expect(unitOfWork.wallet?.version).toBe(2);
    expect(unitOfWork.ledgerEntries).toHaveLength(1);
  });

  test('replays an identical reversal without applying its financial effect twice', async () => {
    await useCase.execute(
      input({
        idempotencyKey: 'replay-bet-idem',
        externalTransactionId: 'replay-bet-external',
        kind: WagerTransactionKind.Bet,
        amount: '80.00',
        roundId: 'round-replay-refund',
      }),
    );

    const refundInput = input({
      idempotencyKey: 'replay-refund-idem',
      externalTransactionId: 'replay-refund-external',
      kind: WagerTransactionKind.Refund,
      amount: '80.00',
      roundId: 'round-replay-refund',
      referenceExternalTransactionId: 'replay-bet-external',
    });

    const first = await useCase.execute(refundInput);
    const replay = await useCase.execute(refundInput);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(unitOfWork.wallet?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(unitOfWork.wallet?.version).toBe(3);
    expect(unitOfWork.ledgerEntries).toHaveLength(2);
  });
});
