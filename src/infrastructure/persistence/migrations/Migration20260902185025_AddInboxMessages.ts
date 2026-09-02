import { Migration } from '@mikro-orm/migrations';

export class Migration20260902185025_AddInboxMessages extends Migration {
  override name = 'Migration20260902185025_AddInboxMessages';

  override up(): void {
    this.addSql(`
      create table "inbox_messages" (
        "id" uuid not null,
        "consumer_name" varchar(128) not null,
        "message_id" varchar(255) not null,
        "payload_hash" varchar(64) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz null,
        primary key ("id")
      );
    `);

    this.addSql(`
      alter table "inbox_messages"
      add constraint "inbox_messages_consumer_message_unique"
      unique ("consumer_name", "message_id");
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists "inbox_messages";`);
  }
}
