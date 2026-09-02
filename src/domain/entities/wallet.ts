import { Money } from '../value-objects/money';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new Error('Wallet initial balance cannot be negative');
    }

    const now = new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  credit(amount: Money): void {
    this.assertSameCurrency(amount);
    this.assertPositiveAmount(amount);

    this._balance = this._balance.add(amount);
    this._version += 1;
    this._updatedAt = new Date();
  }

  debit(amount: Money): void {
    this.assertSameCurrency(amount);
    this.assertPositiveAmount(amount);

    if (this._balance.isLessThan(amount)) {
      throw new Error('Insufficient wallet balance');
    }

    this._balance = this._balance.subtract(amount);
    this._version += 1;
    this._updatedAt = new Date();
  }

  private assertSameCurrency(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new Error(
        `Currency mismatch: wallet uses ${this.currency}, received ${amount.currency}`,
      );
    }
  }

  private assertPositiveAmount(amount: Money): void {
    if (!amount.isPositive()) {
      throw new Error('Wallet movement amount must be positive');
    }
  }
}
