import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from './wallet-ledger-entry';
import { Money } from '../value-objects/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

const createdAt = new Date('2026-09-02T15:00:00.000Z');

function baseProps(kind: WagerTransactionKind) {
  return {
    id: 'transaction-1',
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    idempotencyKey: 'idem-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: Money.from({
      amount: '25.00',
      currency: 'BRL',
    }),
    createdAt,
  };
}

function createTransaction(
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): WagerTransaction {
  return WagerTransaction.create({
    ...baseProps(kind),
    referenceExternalTransactionId,
  });
}

describe('WagerTransaction creation and queries', () => {
  it('creates a BET transaction in PENDING status', () => {
    const transaction = WagerTransaction.create(
      baseProps(WagerTransactionKind.Bet),
    );

    expect(transaction.id).toBe('transaction-1');
    expect(transaction.providerId).toBe('provider-1');
    expect(transaction.externalTransactionId).toBe('external-1');
    expect(transaction.idempotencyKey).toBe('idem-1');
    expect(transaction.payloadHash).toBe('hash-1');
    expect(transaction.walletId).toBe('wallet-1');
    expect(transaction.playerId).toBe('player-1');
    expect(transaction.roundId).toBe('round-1');
    expect(transaction.gameId).toBe('game-1');
    expect(transaction.kind).toBe(WagerTransactionKind.Bet);
    expect(transaction.money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
    expect(transaction.referenceExternalTransactionId).toBeUndefined();
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
  });

  it('requires an external reference for REFUND', () => {
    expect(() =>
      WagerTransaction.create(
        baseProps(WagerTransactionKind.Refund),
      ),
    ).toThrow();
  });

  it('requires an external reference for ROLLBACK', () => {
    expect(() =>
      WagerTransaction.create(
        baseProps(WagerTransactionKind.Rollback),
      ),
    ).toThrow();
  });

  it('accepts REFUND when the external reference is provided', () => {
    const transaction = WagerTransaction.create({
      ...baseProps(WagerTransactionKind.Refund),
      referenceExternalTransactionId: 'original-bet-1',
    });

    expect(transaction.referenceExternalTransactionId).toBe(
      'original-bet-1',
    );
    expect(transaction.requiresReference()).toBe(true);
  });

  it('only requires references for REFUND and ROLLBACK', () => {
    const kindsWithoutRequiredReference = [
      WagerTransactionKind.Opening,
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
    ];

    for (const kind of kindsWithoutRequiredReference) {
      const transaction = WagerTransaction.create(baseProps(kind));

      expect(transaction.requiresReference()).toBe(false);
    }

    const refund = WagerTransaction.create({
      ...baseProps(WagerTransactionKind.Refund),
      referenceExternalTransactionId: 'external-reference-1',
    });

    const rollback = WagerTransaction.create({
      ...baseProps(WagerTransactionKind.Rollback),
      referenceExternalTransactionId: 'external-reference-2',
    });

    expect(refund.requiresReference()).toBe(true);
    expect(rollback.requiresReference()).toBe(true);
  });

  it('reports whether the transaction affects the wallet balance', () => {
    const balanceAffectingKinds = [
      WagerTransactionKind.Opening,
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ];

    for (const kind of balanceAffectingKinds) {
      const transaction = WagerTransaction.create({
        ...baseProps(kind),
        referenceExternalTransactionId:
          kind === WagerTransactionKind.Refund ||
          kind === WagerTransactionKind.Rollback
            ? 'external-reference'
            : undefined,
      });

      expect(transaction.affectsBalance()).toBe(true);
    }

    const loss = WagerTransaction.create(
      baseProps(WagerTransactionKind.Loss),
    );

    expect(loss.affectsBalance()).toBe(false);
  });

  it('matches only the exact canonical payload hash', () => {
    const transaction = WagerTransaction.create(
      baseProps(WagerTransactionKind.Bet),
    );

    expect(transaction.matchesPayload('hash-1')).toBe(true);
    expect(transaction.matchesPayload('different-hash')).toBe(false);
  });

  it('rejects zero or negative transaction amounts', () => {
    expect(() =>
      WagerTransaction.create({
        ...baseProps(WagerTransactionKind.Bet),
        money: Money.zero('BRL'),
      }),
    ).toThrow();

    expect(() =>
      WagerTransaction.create({
        ...baseProps(WagerTransactionKind.Win),
        money: Money.from({
          amount: '-10.00',
          currency: 'BRL',
        }),
      }),
    ).toThrow();
  });

  it('rehydrates persisted state without replaying creation rules', () => {
    const processedAt = new Date('2026-09-02T15:05:00.000Z');

    const transaction = WagerTransaction.rehydrate({
      ...baseProps(WagerTransactionKind.Refund),
      referenceExternalTransactionId: undefined,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: 'internal-transaction-99',
      failureCode: undefined,
      processedAt,
      retryAttempts: 0,
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceExternalTransactionId).toBeUndefined();
    expect(transaction.referenceTransactionId).toBe(
      'internal-transaction-99',
    );
    expect(transaction.processedAt).toEqual(processedAt);
  });
});

describe('WagerTransaction state transitions', () => {
  it('marks a pending transaction as processed', () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);
    const processedAt = new Date('2026-09-02T15:05:00.000Z');

    transaction.markProcessed(undefined, processedAt);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.processedAt).toEqual(processedAt);
    expect(transaction.isTerminal()).toBe(true);
  });

  it('marks a transaction as pending reference', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Refund,
      'missing-bet',
    );

    transaction.markPendingReference(new Date());

    expect(transaction.status).toBe(
      WagerTransactionStatus.PendingReference,
    );
    expect(transaction.isTerminal()).toBe(false);
  });

  it('processes a transaction after it was pending reference', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Refund,
      'original-bet',
    );
    const processedAt = new Date('2026-09-02T15:10:00.000Z');

    transaction.markPendingReference(new Date());
    transaction.markProcessed('internal-bet-id', processedAt);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe('internal-bet-id');
    expect(transaction.processedAt).toEqual(processedAt);
  });

  it('rejects a transaction with a stable failure code', () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);

    transaction.reject('INSUFFICIENT_BALANCE');

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(transaction.isTerminal()).toBe(true);
  });

  it('fails a transaction with a stable failure code', () => {
    const transaction = createTransaction(WagerTransactionKind.Win);

    transaction.fail('PERSISTENCE_FAILURE');

    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(transaction.failureCode).toBe('PERSISTENCE_FAILURE');
    expect(transaction.isTerminal()).toBe(true);
  });

  it('does not allow transitions after a terminal state', () => {
    const processed = createTransaction(WagerTransactionKind.Bet);
    processed.markProcessed(
      undefined,
      new Date('2026-09-02T15:05:00.000Z'),
    );

    expect(() =>
      processed.reject('SHOULD_NOT_CHANGE'),
    ).toThrow();

    const rejected = createTransaction(WagerTransactionKind.Bet);
    rejected.reject('INSUFFICIENT_BALANCE');

    expect(() =>
      rejected.markProcessed(
        undefined,
        new Date('2026-09-02T15:05:00.000Z'),
      ),
    ).toThrow();

    const failed = createTransaction(WagerTransactionKind.Win);
    failed.fail('PERSISTENCE_FAILURE');

    expect(() => failed.markPendingReference(new Date())).toThrow();
  });
});

describe('WagerTransaction ledger direction', () => {
  it('maps OPENING, BET, WIN and REFUND to their ledger directions', () => {
    expect(
      createTransaction(
        WagerTransactionKind.Opening,
      ).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);

    expect(
      createTransaction(
        WagerTransactionKind.Bet,
      ).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Debit);

    expect(
      createTransaction(
        WagerTransactionKind.Win,
      ).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);

    expect(
      createTransaction(
        WagerTransactionKind.Refund,
        'original-bet',
      ).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  it('does not produce a ledger direction for LOSS', () => {
    const loss = createTransaction(WagerTransactionKind.Loss);

    expect(() => loss.ledgerDirectionFor()).toThrow();
  });

  it('inverts the referenced transaction direction for ROLLBACK', () => {
    const rollback = createTransaction(
      WagerTransactionKind.Rollback,
      'reference',
    );

    const bet = createTransaction(WagerTransactionKind.Bet);
    const win = createTransaction(WagerTransactionKind.Win);
    const refund = createTransaction(
      WagerTransactionKind.Refund,
      'original-bet',
    );

    expect(rollback.ledgerDirectionFor(bet)).toBe(
      LedgerDirection.Credit,
    );
    expect(rollback.ledgerDirectionFor(win)).toBe(
      LedgerDirection.Debit,
    );
    expect(rollback.ledgerDirectionFor(refund)).toBe(
      LedgerDirection.Debit,
    );
  });

  it('requires the referenced transaction to calculate ROLLBACK direction', () => {
    const rollback = createTransaction(
      WagerTransactionKind.Rollback,
      'reference',
    );

    expect(() => rollback.ledgerDirectionFor()).toThrow();
  });
});
