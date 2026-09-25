import { describe, expect, it } from 'vitest'
import { channelListSemantics } from '../registry'

describe('telegram channel-list semantics', () => {
  it('offers the reply-aware trigger — it is the only platform with transcript continuity', () => {
    expect(channelListSemantics('telegram').triggers).toEqual(['off', 'mention', 'mention_topic', 'any'])
  })
})
