import { Migration } from '@mikro-orm/migrations';

export class Migration20260902061654_AddTransactionsAndLedger extends Migration {

  override name = 'Migration20260902061654_AddTransactionsAndLedger';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(128) not null, "external_transaction_id" varchar(128) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(64) not null, "wallet_id" uuid not null, "player_id" varchar(128) not null, "round_id" varchar(128) not null, "game_id" varchar(128) not null, "kind" varchar(16) not null, "amount" numeric(38,2) not null, "currency" varchar(3) not null, "reference_external_transaction_id" varchar(128) null, "reference_transaction_id" uuid null, "status" varchar(32) not null, "failure_code" varchar(64) null, "created_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "wager_transactions_wallet_status_idx" on "wager_transactions" ("wallet_id", "status");`);
    this.addSql(`create index "wager_transactions_reference_external_idx" on "wager_transactions" ("provider_id", "reference_external_transaction_id");`);
    this.addSql(`create index "wager_transactions_status_created_idx" on "wager_transactions" ("status", "created_at");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key");`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" varchar(6) not null, "amount" numeric(38,2) not null, "currency" varchar(3) not null, "balance_before" numeric(38,2) not null, "balance_after" numeric(38,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "wallet_ledger_wallet_created_idx" on "wallet_ledger_entries" ("wallet_id", "created_at");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_wallet_transaction_unique" unique ("wallet_id", "transaction_id");`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete set null;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_amount_positive" check (amount > 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_currency_format" check (currency ~ '^[A-Z]{3}$');`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_kind_valid" check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_valid" check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_required" check ((kind not in ('REFUND', 'ROLLBACK')) or reference_external_transaction_id is not null);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_failure_code_required" check ((status not in ('REJECTED', 'FAILED')) or failure_code is not null);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_processed_at_required" check (status <> 'PROCESSED' or processed_at is not null);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_resolved_reference_required" check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null);`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_direction_valid" check (direction in ('DEBIT', 'CREDIT'));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_amount_positive" check (amount > 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_currency_format" check (currency ~ '^[A-Z]{3}$');`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_balance_before_non_negative" check (balance_before >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_balance_after_non_negative" check (balance_after >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_arithmetic_consistent" check (((direction = 'DEBIT' and balance_before - amount = balance_after) or (direction = 'CREDIT' and balance_before + amount = balance_after)));`);
        this.addSql(`
      create function "prevent_wallet_ledger_mutation"()
      returns trigger
      language plpgsql
      as $function$
      begin
        raise exception 'wallet_ledger_entries is immutable';
      end;
      $function$;
    `);

    this.addSql(`
      create trigger "wallet_ledger_entries_immutable"
      before update or delete or truncate on "wallet_ledger_entries"
      for each statement
      execute function "prevent_wallet_ledger_mutation"();
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      drop trigger if exists "wallet_ledger_entries_immutable"
      on "wallet_ledger_entries";
    `);

    this.addSql(`
      drop function if exists "prevent_wallet_ledger_mutation"();
    `);

    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
  }

}
