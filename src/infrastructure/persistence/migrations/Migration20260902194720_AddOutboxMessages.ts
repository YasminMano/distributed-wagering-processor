import { Migration } from '@mikro-orm/migrations';

export class Migration20260902194720_AddOutboxMessages extends Migration {

  override name = 'Migration20260902194720_AddOutboxMessages';

  override up(): void | Promise<void> {
    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_id" uuid not null, "event_type" varchar(128) not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null, "next_attempt_at" timestamptz null, "published_at" timestamptz null, primary key ("id"));`);

    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_failure_code_required";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_required";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_resolved_reference_required";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_retry_attempts_valid";`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_failure_code_required" check ((status not in ('REJECTED', 'FAILED')) or failure_code is not null);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_required" check ((kind not in ('REFUND', 'ROLLBACK')) or reference_external_transaction_id is not null);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_resolved_reference_required" check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_retry_attempts_valid" check (retry_attempts between 0 and 5);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "outbox_messages" cascade;`);

    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_required";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_failure_code_required";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_resolved_reference_required";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_retry_attempts_valid";`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_required" check ((kind <> ALL (ARRAY['REFUND'::character varying, 'ROLLBACK'::character varying])) OR (reference_external_transaction_id IS NOT NULL));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_failure_code_required" check ((status <> ALL (ARRAY['REJECTED'::character varying, 'FAILED'::character varying])) OR (failure_code IS NOT NULL));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_resolved_reference_required" check ((status <> 'PROCESSED'::text) OR (kind <> ALL (ARRAY['REFUND'::character varying, 'ROLLBACK'::character varying])) OR (reference_transaction_id IS NOT NULL));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_retry_attempts_valid" check ((retry_attempts >= 0) AND (retry_attempts <= 5));`);

  }

}
