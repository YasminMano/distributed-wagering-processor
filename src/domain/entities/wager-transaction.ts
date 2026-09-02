import { Money } from '../value-objects/money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export type FailureCode = string;

export class InvalidTransactionStateError extends Error {
  constructor(
    currentStatus: WagerTransactionStatus,
    transition: string,
  ) {
    super(
      `Cannot ${transition} wager transaction from ${currentStatus}`,
    );
    this.name = 'InvalidTransactionStateError';
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState
  extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private readonly creationTime: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId?: string,
    failureCode?: FailureCode,
    processedAt?: Date,
  ) {
    this.creationTime = new Date(createdAt.getTime());
    this._status = status;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
    this._processedAt = processedAt
      ? new Date(processedAt.getTime())
      : undefined;
  }

  static create(
    props: CreateWagerTransactionProps,
  ): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new Error('Wager transaction amount must be positive');
    }

    if (
      WagerTransaction.kindRequiresReference(props.kind) &&
      !props.referenceExternalTransactionId
    ) {
      throw new Error(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(
    state: WagerTransactionState,
  ): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.creationTime.getTime());
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt.getTime())
      : undefined;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
  ): void {
    this.assertNotTerminal('mark as processed');

    if (this.requiresReference() && !referenceTransactionId) {
      throw new Error(
        `${this.kind} requires a resolved reference transaction`,
      );
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = undefined;
    this._processedAt = new Date(at.getTime());
  }

  markPendingReference(): void {
    this.assertNotTerminal('mark as pending reference');

    if (!this.requiresReference()) {
      throw new Error(
        `${this.kind} does not require a reference transaction`,
      );
    }

    this._status = WagerTransactionStatus.PendingReference;
    this._referenceTransactionId = undefined;
    this._failureCode = undefined;
    this._processedAt = undefined;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal('reject');
    this.assertFailureCode(code);

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this.assertFailureCode(code);

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = undefined;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return WagerTransaction.kindRequiresReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Loss:
        throw new Error('LOSS does not produce a ledger entry');

      case WagerTransactionKind.Rollback:
        return this.rollbackDirectionFor(reference);
    }
  }

  private rollbackDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection {
    if (!reference) {
      throw new Error(
        'ROLLBACK requires the referenced transaction to determine ledger direction',
      );
    }

    switch (reference.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Debit;

      default:
        throw new Error(
          `ROLLBACK cannot reference ${reference.kind}`,
        );
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        this._status,
        transition,
      );
    }
  }

  private assertFailureCode(code: FailureCode): void {
    if (code.trim().length === 0) {
      throw new Error('Failure code must not be empty');
    }
  }

  private static kindRequiresReference(
    kind: WagerTransactionKind,
  ): boolean {
    return (
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback
    );
  }
}
