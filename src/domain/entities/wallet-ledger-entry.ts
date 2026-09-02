import { Money } from '../value-objects/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private readonly creationTime: Date;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.creationTime = new Date(createdAt.getTime());
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new Error('Ledger movement amount must be positive');
    }

    WalletLedgerEntry.assertSameCurrency(
      props.money,
      props.balanceBefore,
      props.balanceAfter,
    );

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    if (!entry.isBalanced()) {
      throw new Error('Ledger entry arithmetic is inconsistent');
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.creationTime.getTime());
  }

  isBalanced(): boolean {
    try {
      WalletLedgerEntry.assertSameCurrency(
        this.money,
        this.balanceBefore,
        this.balanceAfter,
      );

      const expectedBalance =
        this.direction === LedgerDirection.Debit
          ? this.balanceBefore.subtract(this.money)
          : this.balanceBefore.add(this.money);

      return expectedBalance.equals(this.balanceAfter);
    } catch {
      return false;
    }
  }

  private static assertSameCurrency(
    money: Money,
    balanceBefore: Money,
    balanceAfter: Money,
  ): void {
    const currency = money.currency;

    if (
      balanceBefore.currency !== currency ||
      balanceAfter.currency !== currency
    ) {
      throw new Error('Ledger entry currencies must match');
    }
  }
}
