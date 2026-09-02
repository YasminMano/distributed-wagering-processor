import { Migration } from '@mikro-orm/migrations';

export class Migration20260902054944_CreateWallets extends Migration {

  override name = 'Migration20260902054944_CreateWallets';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" varchar(128) not null, "currency" varchar(3) not null, "balance" numeric(38,2) not null, "version" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`alter table "wallets" add constraint "wallets_balance_non_negative" check (balance >= 0);`);
    this.addSql(`alter table "wallets" add constraint "wallets_version_positive" check (version >= 1);`);
    this.addSql(`alter table "wallets" add constraint "wallets_currency_format" check (currency ~ '^[A-Z]{3}$');`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallets" cascade;`);
  }

}
