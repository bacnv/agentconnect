// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { IntegrationChannelList } from './IntegrationChannelList'

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    setChannelTrigger: vi.fn(),
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
})

/** Open the row's trigger menu and read its options, in host order. An integrationId is
 *  required: a row without one is a demo row and renders the control inert. */
async function menuFor(platform: string): Promise<string[]> {
  await act(async () =>
    root.render(
      createElement(IntegrationChannelList, {
        platform,
        integrationId: 'int-1',
        gated: false,
        channels: [{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention' }]
      })
    )
  )
  const trigger = [...document.querySelectorAll('button')].find((b) =>
    b.getAttribute('aria-label')?.startsWith('Trigger for')
  )!
  await act(async () => trigger.click())
  return [...document.querySelectorAll('[role="menuitemradio"]')].map((o) => o.textContent ?? '')
}

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
