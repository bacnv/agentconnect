import { describe, it, expect } from 'vitest'
import { ObservedChannelsSync } from '../src/platforms/observed-channels-sync.js'
import type { ObservedChannelsSyncHost } from '../src/platforms/observed-channels-sync.js'
import type { IntegrationChannel } from '@agentconnect.md/protocol'

const INTEGRATION = 'a05ba3a0-9f97-4a2b-9c1f-9f8ff0e6d101'

/** A host with just the seams `observePlatformChats` spends — one integration, one snapshot map. */
function harness() {
  const snapshots = new Map<string, { channels: IntegrationChannel[]; authoritative: boolean }>()
  const reports: { integrationId: string; channels: IntegrationChannel[] }[] = []
  const host = {
    store: () => ({ setDisplayName: async () => {} }),
    channelSnapshots: () => snapshots,
    integrationConfigById: () => ({ id: INTEGRATION, platform: 'linear' }),
    cpClient: () => ({
      emitIntegrationChannels: (s: { integrationId: string; channels: IntegrationChannel[] }) => reports.push(s)
    }),
    emitSessionMetadataSnapshotsForDisplayName: async () => {}
  } as unknown as ObservedChannelsSyncHost
  return { sync: new ObservedChannelsSync(host), snapshots, reports }
}

const rows = (snapshots: Map<string, { channels: IntegrationChannel[] }>): IntegrationChannel[] =>
  snapshots.get(INTEGRATION)?.channels ?? []

/** Telegram's variant: the platform gate has to pass, and the display-name store is
 *  recorded so a topic can be proved never to rename its conversation. */
function telegramHarness() {
  const snapshots = new Map<string, { channels: IntegrationChannel[]; authoritative: boolean }>()
  const reports: { integrationId: string; channels: IntegrationChannel[] }[] = []
  const names: { id: string; name: string }[] = []
  const host = {
    store: () => ({
      setDisplayName: async (id: string, name: string) => {
        names.push({ id, name })
      }
    }),
    channelSnapshots: () => snapshots,
    integrationConfigById: () => ({ id: INTEGRATION, platform: 'telegram' }),
    cpClient: () => ({
      emitIntegrationChannels: (s: { integrationId: string; channels: IntegrationChannel[] }) => reports.push(s)
    }),
    emitSessionMetadataSnapshotsForDisplayName: async () => {}
  } as unknown as ObservedChannelsSyncHost
  return { sync: new ObservedChannelsSync(host), snapshots, reports, names }
}

describe('observeForumTopic — a thread on an observed conversation', () => {
  it('adds a topic to the conversation row and re-emits', async () => {
    const { sync, snapshots } = telegramHarness()
    await sync.observePlatformChats('telegram', [{ id: '-100', name: 'General', isPrivate: false }], [INTEGRATION])
    await sync.observeForumTopic('telegram', { id: '-100', isPrivate: false, threadId: '7' }, [INTEGRATION])

    expect(rows(snapshots)[0]?.threads).toEqual([{ id: '7' }])
  })

  it('reports nothing on a second observation of the same topic', async () => {
    const { sync, snapshots, reports } = telegramHarness()
    await sync.observePlatformChats('telegram', [{ id: '-100', name: 'General', isPrivate: false }], [INTEGRATION])
    await sync.observeForumTopic('telegram', { id: '-100', isPrivate: false, threadId: '7' }, [INTEGRATION])

    const before = reports.length
    await sync.observeForumTopic('telegram', { id: '-100', isPrivate: false, threadId: '7' }, [INTEGRATION])
    expect(reports).toHaveLength(before)
  })

  it('learns a topic name once and never unlearns it from a later nameless sighting', async () => {
    const { sync, snapshots, reports } = telegramHarness()
    await sync.observePlatformChats('telegram', [{ id: '-100', name: 'General', isPrivate: false }], [INTEGRATION])
    await sync.observeForumTopic('telegram', { id: '-100', isPrivate: false, threadId: '7', forumName: 'Deploys' }, [
      INTEGRATION
    ])

    // Traffic names no topic, and this runs on every message: the quiet second sighting must
    // both leave the learned name standing and re-emit nothing.
    const before = reports.length
    await sync.observeForumTopic('telegram', { id: '-100', isPrivate: false, threadId: '7' }, [INTEGRATION])

    expect(rows(snapshots)[0]?.threads).toEqual([{ id: '7', name: 'Deploys' }])
    expect(reports).toHaveLength(before)
  })

  it('never renames the conversation the topic sits in', async () => {
    // `setDisplayName` is keyed by platform id and is latest-wins, so naming it after the topic
    // would rename the GROUP row — and two named topics would flip it between them.
    const { sync, names } = telegramHarness()
    await sync.observePlatformChats('telegram', [{ id: '-100', name: 'General', isPrivate: false }], [INTEGRATION])
    names.length = 0
    await sync.observeForumTopic('telegram', { id: '-100', isPrivate: false, threadId: '7', forumName: 'Deploys' }, [
      INTEGRATION
    ])

    expect(names).toEqual([])
  })

  it('records a topic whose conversation row was never reported, so a topic cannot be lost', async () => {
    const { sync, snapshots } = telegramHarness()
    await sync.observeForumTopic('telegram', { id: '-100', isPrivate: false, threadId: '7' }, [INTEGRATION])

    expect(rows(snapshots)[0]?.threads).toEqual([{ id: '7' }])
  })

  it('ignores an integration of another platform, and does not add a topic to it', async () => {
    const { sync, snapshots } = harness()
    await sync.observeForumTopic('telegram', { id: '-100', isPrivate: false, threadId: '7' }, [INTEGRATION])

    expect(snapshots.size).toBe(0)
  })
})

describe('observePlatformChats — the conversation row a platform reports as observed', () => {
  it('carries the chat’s own glyph onto the row, and leaves it off where there is none', async () => {
    const { sync, snapshots, reports } = harness()
    await sync.observePlatformChats(
      'linear',
      [
        { id: 'team-1', name: 'Acme / Engineering', icon: 'Feather', color: '#5E6AD2', isPrivate: false },
        { id: 'team-2', name: 'Acme / Design', isPrivate: false }
      ],
      [INTEGRATION]
    )
    expect(rows(snapshots)).toEqual([
      {
        id: 'team-1',
        name: 'Acme / Engineering',
        icon: 'Feather',
        color: '#5E6AD2',
        isPrivate: false,
        kind: 'channel'
      },
      { id: 'team-2', name: 'Acme / Design', isPrivate: false, kind: 'channel' }
    ])
    expect(reports).toHaveLength(1)
  })

  it('learns a glyph once and never unlearns it — a later observation without one keeps the row drawn', async () => {
    const { sync, snapshots, reports } = harness()
    const glyphed = { id: 'team-1', name: 'Acme / Engineering', icon: '🚀', color: '#F2994A', isPrivate: false }
    await sync.observePlatformChats('linear', [glyphed], [INTEGRATION])
    await sync.observePlatformChats(
      'linear',
      [{ id: 'team-1', name: 'Acme / Engineering', isPrivate: false }],
      [INTEGRATION]
    )
    expect(rows(snapshots)[0]).toMatchObject({ icon: '🚀', color: '#F2994A' })
    // Nothing changed, so nothing was reported a second time.
    expect(reports).toHaveLength(1)
  })

  it('carries the chat’s handle and link onto the row, learned once like the glyph', async () => {
    const { sync, snapshots, reports } = harness()
    const linked = {
      id: 'team-1',
      name: 'Acme / Engineering',
      key: 'ENG',
      url: 'https://linear.app/example-workspace/team/ENG',
      isPrivate: false
    }
    await sync.observePlatformChats('linear', [linked], [INTEGRATION])
    expect(rows(snapshots)[0]).toMatchObject({ key: 'ENG', url: 'https://linear.app/example-workspace/team/ENG' })
    // A later observation that resolved neither leaves the linked row standing, and reports nothing.
    await sync.observePlatformChats(
      'linear',
      [{ id: 'team-1', name: 'Acme / Engineering', isPrivate: false }],
      [INTEGRATION]
    )
    expect(rows(snapshots)[0]).toMatchObject({ key: 'ENG', url: 'https://linear.app/example-workspace/team/ENG' })
    expect(reports).toHaveLength(1)
  })

  it('reports again when only the glyph changed — a renamed row is not the only thing the console redraws', async () => {
    const { sync, snapshots, reports } = harness()
    const chat = { id: 'team-1', name: 'Acme / Engineering', isPrivate: false }
    await sync.observePlatformChats('linear', [{ ...chat, icon: 'Feather', color: '#5E6AD2' }], [INTEGRATION])
    await sync.observePlatformChats('linear', [{ ...chat, icon: 'Feather', color: '#26B5CE' }], [INTEGRATION])
    expect(rows(snapshots)[0]).toMatchObject({ color: '#26B5CE' })
    expect(reports).toHaveLength(2)
  })
})
