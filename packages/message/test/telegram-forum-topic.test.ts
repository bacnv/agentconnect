import { describe, expect, it } from 'vitest'
import { telegramForumTopicId, type TelegramMessage } from '../src/telegram-message.js'

const topicMessage = (over: Partial<TelegramMessage> = {}): TelegramMessage => ({
  message_id: 10,
  chat: { id: -100, type: 'supergroup' },
  message_thread_id: 7,
  is_topic_message: true,
  ...over
})

describe('telegramForumTopicId', () => {
  it('reads a topic id off a forum service record', () => {
    expect(telegramForumTopicId(topicMessage({ forum_topic_created: { name: 'Deploys' } }))).toBe('7')
    expect(telegramForumTopicId(topicMessage({ forum_topic_edited: { name: 'Releases' } }))).toBe('7')
  })

  it('reads a topic id off any message in a topic', () => {
    expect(telegramForumTopicId(topicMessage())).toBe('7')
  })

  it('reads nothing off a plain supergroup reply root — that is a session coordinate', () => {
    expect(
      telegramForumTopicId({ message_id: 10, chat: { id: -100, type: 'supergroup' }, message_thread_id: 10 })
    ).toBe(undefined)
  })

  it('reads nothing off a topic service record with no thread id', () => {
    expect(
      telegramForumTopicId({ message_id: 10, chat: { id: -100, type: 'supergroup' }, forum_topic_created: {} })
    ).toBe(undefined)
  })
})
