import { defineEntity, p } from '@mikro-orm/core';

export const OutboxMessagePersistence = defineEntity({
  name: 'OutboxMessagePersistence',
  tableName: 'outbox_messages',

  properties: {
    id: p.uuid().primary(),

    aggregateId: p.uuid(),

    eventType: p.string().length(128),

    payload: p.json(),

    occurredAt: p
      .datetime()
      .columnType('timestamptz'),

    attempts: p.integer(),

    nextAttemptAt: p
      .datetime()
      .columnType('timestamptz')
      .nullable(),

    publishedAt: p
      .datetime()
      .columnType('timestamptz')
      .nullable(),
  },
});
