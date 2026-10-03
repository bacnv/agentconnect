export {
  isTelegramMembershipServiceMessage,
  normalizeTelegramMessage,
  quotedFromTelegramReply,
  telegramChatMigration,
  telegramMessageUrl,
  telegramThread,
  telegramForumTopicId,
  toTelegramDocumentAttachment as documentToAttachment,
  toTelegramPhotoAttachment as photoToAttachment
} from '@agentconnect.md/message'
export type {
  TelegramChat,
  TelegramDocument,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramPhotoSize,
  TelegramReplyToMessage,
  TelegramTextQuote,
  TelegramUser
} from '@agentconnect.md/message'
