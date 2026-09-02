import { defineEntity, p } from '@mikro-orm/core';

export const InboxMessagePersistence = defineEntity({
  name: 'InboxMessagePersistence',
  tableName: 'inbox_messages',

  properties: {
    id: p.uuid().primary(),

    consumerName: p.string().length(128),

    messageId: p.string().length(255),

    payloadHash: p.string().length(64),

    receivedAt: p
      .datetime()
      .columnType('timestamptz'),

    processedAt: p
      .datetime()
      .columnType('timestamptz')
      .nullable(),
  },

  uniques: [
    {
      name: 'inbox_messages_consumer_message_unique',
      properties: ['consumerName', 'messageId'],
    },
  ],
});
