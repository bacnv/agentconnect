// A schedule's target in a Telegram forum topic is anchored INSIDE that topic, and its session keys on
// the topic id — the coordinate an inbound message there canonicalizes to. Posting without it files the
// anchor under General, a destination the conversation that asked can never reach.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

const AGENT = 'agent-1'
const INT = 'int-tg'
const CHAT = '-1001234'
const TOPIC = '42'
const MSG = '9001'

async function world() {
  const daemon: any = new Daemon({ sandboxMechanism: null })
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  daemon.agents.set(AGENT, {
    id: AGENT,
    name: 'Butler',
    chatActions: 'talk',
    integrations: [
      {
        id: INT,
        platform: 'telegram',
        core: {
          mode: 'direct',
          bindRules: [],
          mutedChannels: [],
          affinityDenied: [],
          overriddenThreads: [],
          gated: false,
          sessionModes: [],
          externalChannels: [],
          decisions: { bindings: [], definitions: [] }
        },
        config: {}
      }
    ]
  })
  const conn = {
    postMessage: vi.fn(async () => MSG),
    getChannelInfo: vi.fn(async (id: string) => ({ id, isIm: false })),
    listMembers: vi.fn(async () => [])
  }
  daemon.tgConnByIntegration.set(INT, conn)
  const cron = {
    msgId: 'cron:c1:t1',
    traceId: 'cron:c1:t1',
    source: 'cron',
    platform: 'telegram',
    channel: CHAT,
    thread: 'cron:c1:t1',
    sender: { id: 'cron:c1', isBot: false },
    text: 'post the standup digest',
    mentionedBots: [],
    isDm: false,
    trigger: 'cron'
  } as NormalizedMessage
  return { daemon, store, conn, cron }
}

describe('a schedule anchored into a Telegram forum topic', () => {
  it('posts the anchor inside the topic and keys the session on that topic id', async () => {
    const w = await world()
    const anchored = await w.daemon
      .githubReviewHost()
      .anchorTrigger(
        AGENT,
        w.cron,
        { channel: CHAT, integrationId: INT, thread: TOPIC },
        'A schedule fired',
        'cron "c1"'
      )
    expect(w.conn.postMessage).toHaveBeenCalledWith(CHAT, 'A schedule fired', TOPIC)
    expect(anchored).toMatchObject({
      postAttempted: true,
      message: { channel: CHAT, thread: TOPIC, transcriptTs: MSG }
    })
    await w.store.close()
  })

  it('posts at the chat root and keys a reply root when the target names no topic', async () => {
    const w = await world()
    const anchored = await w.daemon
      .githubReviewHost()
      .anchorTrigger(AGENT, w.cron, { channel: CHAT, integrationId: INT }, 'A schedule fired', 'cron "c1"')
    expect(w.conn.postMessage).toHaveBeenCalledWith(CHAT, 'A schedule fired', undefined)
    expect(anchored).toMatchObject({ postAttempted: true, message: { thread: `tg:${MSG}` } })
    await w.store.close()
  })
})
