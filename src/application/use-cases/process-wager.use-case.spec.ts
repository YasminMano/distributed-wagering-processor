import {
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import {
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

  async updateWallet(wallet: Wallet): Promise<void> {
    this.wallet = wallet;
    this.updateWalletCalls += 1;
  }

  async insertTransaction(
    transaction: WagerTransaction,
  ): Promise<void> {
    this.transactions.push(transaction);
  }

  async insertLedgerEntry(
    entry: WalletLedgerEntry,
  ): Promise<void> {
    this.ledgerEntries.push(entry);
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
});
