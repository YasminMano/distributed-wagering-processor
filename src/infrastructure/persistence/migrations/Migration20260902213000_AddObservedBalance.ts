import { Migration } from '@mikro-orm/migrations';

export class Migration20260902213000_AddObservedBalance extends Migration {
  override name = 'Migration20260902213000_AddObservedBalance';

  override up(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transactions" add column "observed_balance" numeric(38,2) null;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_observed_balance_non_negative" check (observed_balance is null or observed_balance >= 0);`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transactions" drop constraint if exists "wager_transactions_observed_balance_non_negative";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop column if exists "observed_balance";`,
    );
  }
}
