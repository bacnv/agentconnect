// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { IntegrationChannelList } from './IntegrationChannelList'

const setThreadTrigger = vi.fn()
const setChannelTrigger = vi.fn()

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    setChannelTrigger,
    setThreadTrigger,
    setChannelAgent: vi.fn(),
    forgetChannel: vi.fn(),
    leaveConversation: vi.fn(),
    bots: [],
    agents: [],
    integrations: []
  })
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

/** Mount the list on one channel and open the conversation's trigger menu, returning the
 *  menu's items in host order. An integrationId is required: a row without one is a demo
 *  row and renders the control inert. */
async function openMenu(channels: Parameters<typeof IntegrationChannelList>[0]['channels'], platform: string) {
  await act(async () =>
    root.render(createElement(IntegrationChannelList, { platform, integrationId: 'int-1', gated: false, channels }))
  )
  const trigger = [...document.querySelectorAll('button')].find((b) =>
    b.getAttribute('aria-label')?.startsWith('Trigger for')
  )!
  await act(async () => trigger.click())
  return [...document.querySelectorAll('[role="menuitemradio"]')]
}

const menuFor = async (platform: string): Promise<string[]> =>
  (await openMenu([{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention' }], platform)).map(
    (o) => o.textContent ?? ''
  )

type Topic = { threadId: string; name: string | null; trigger: 'off' | 'mention' | 'mention_topic' | 'any' | null }

/** Mount the list on a Telegram group carrying `threads`, then expand the disclosure and
 *  open ONE topic's trigger menu — the state every topic assertion below starts from. */
async function openTopic(threads: Topic[], channelTrigger: 'off' | 'mention' = 'mention'): Promise<Element[]> {
  await openMenu([{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: channelTrigger, threads }], 'telegram')
  // The conversation's own menu is still open over the row: dismiss it the way a click outside
  // does, through the flyout's own backdrop, so only one menu's items are in the DOM at a time.
  await dismissFlyout()
  await expandTopics()
  // The topic rows render after their conversation's, so the last trigger control IS the topic's
  // on this one-row list.
  const topic = [...document.querySelectorAll('button[aria-label^="Trigger for "]')].at(-1) as HTMLButtonElement
  await act(async () => topic.click())
  return [...document.querySelectorAll('[role="menuitemradio"]')]
}

const expandTopics = async () =>
  act(async () => (document.querySelector('button[aria-label="Topics of deploys"]') as HTMLButtonElement).click())

const dismissFlyout = async () =>
  act(async () => (document.querySelector('[data-anchored-flyout-backdrop]') as HTMLElement).click())

const topicItems = async (threads: Topic[]) => (await openTopic(threads)).map((o) => o.textContent ?? '')

describe('the trigger menu’s platform vocabulary', () => {
  it('offers the reply option on Telegram', async () => {
    expect(await menuFor('telegram')).toEqual(['off', 'any message', '@-mention', '@-mention + reply'])
  })

  it('keeps the three agnostic values where the platform declares no allow-list', async () => {
    // Slack's module declares no `triggers`, so the host default applies — the fourth
    // value must not leak to a platform with no reply-derived continuity.
    expect(await menuFor('slack')).toEqual(['off', 'any message', '@-mention'])
  })

  it('never offers the reply option on Linear', async () => {
    expect(await menuFor('linear')).not.toContain('@-mention + reply')
  })
})

describe('the topic rows a conversation discloses', () => {
  it('offers Follow group ahead of the four values on a topic', async () => {
    expect(await topicItems([{ threadId: '7', name: 'Deploys', trigger: null }])).toEqual([
      'Follow group',
      'off',
      'any message',
      '@-mention',
      '@-mention + reply'
    ])
  })

  it('shows Follow group as the current choice on a topic that inherits, so clearing stays reachable', async () => {
    // The control reads the row's state rather than appearing and disappearing: a topic that
    // already inherits still offers the sentinel, and picking it is the no-op the host suppresses.
    await openTopic([{ threadId: '7', name: 'Deploys', trigger: null }])
    expect(document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe('Follow group')
  })

  it('writes null when Follow group is picked on a topic holding an override', async () => {
    const items = await openTopic([{ threadId: '7', name: 'Deploys', trigger: 'off' }])
    const follow = items.find((o) => o.textContent === 'Follow group') as HTMLButtonElement
    await act(async () => follow.click())
    expect(setThreadTrigger).toHaveBeenCalledWith('int-1', 'C1', '7', null)
  })

  it('names a topic the platform never named by its id, so an unnamed row is still configurable', async () => {
    await openTopic([{ threadId: '9', name: null, trigger: null }])
    expect(document.body.textContent).toContain('Topic 9')
  })

  it('keeps the disclosure reachable under an off group row — off no longer means the group is silent', async () => {
    await openMenu(
      [
        {
          channelId: 'C1',
          name: 'deploys',
          kind: 'channel',
          trigger: 'off',
          threads: [{ threadId: '7', name: null, trigger: null }]
        }
      ],
      'telegram'
    )
    await dismissFlyout()
    await expandTopics()
    expect(document.body.textContent).toContain('Topic 7')
  })

  it('renders no disclosure at all on a platform that declares no threadTriggers', async () => {
    await openMenu([{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention' }], 'slack')
    expect(document.querySelector('button[aria-label="Topics of deploys"]')).toBeNull()
  })
})
