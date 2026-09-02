import { Migration } from '@mikro-orm/migrations';

export class Migration20260902070000_AddPendingReferenceRetries extends Migration {

  override name = 'Migration20260902070000_AddPendingReferenceRetries';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add column "retry_attempts" int not null default 0, add column "next_retry_at" timestamptz null;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_retry_attempts_valid" check (retry_attempts between 0 and 5);`);
    this.addSql(`create index "wager_transactions_pending_reference_retry_idx" on "wager_transactions" ("status", "next_retry_at");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index if exists "wager_transactions_pending_reference_retry_idx";`);
    this.addSql(`alter table "wager_transactions" drop constraint if exists "wager_transactions_retry_attempts_valid";`);
    this.addSql(`alter table "wager_transactions" drop column if exists "next_retry_at", drop column if exists "retry_attempts";`);
  }
}
