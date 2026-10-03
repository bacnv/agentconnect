import { describe, expect, it } from 'vitest'
import { channelListSemantics } from '../registry'

describe('telegram channel-list semantics', () => {
  it('offers the reply-aware trigger without losing By decision on groups', () => {
    expect(channelListSemantics('telegram').triggers).toEqual(['off', 'mention', 'mention_topic', 'any', 'decision'])
  })

  it('keeps topic triggers independent of channel decision bindings', () => {
    expect(channelListSemantics('telegram').threadTriggers).toEqual(['off', 'mention', 'mention_topic', 'any'])
  })
})
