import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyGatewayModelList, fetchGatewayModelList } from '../src/runtimes/gateway-model-list.js'

/** Spelled out rather than imported: if someone empties the constant, the alias tests must FAIL. */
const ALIASES = ['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable']

const gatewayPayload = {
  data: [
    { id: 'combo-gpt', object: 'model', owned_by: 'combo' },
    { id: 'fci/upstream-thing', object: 'model', owned_by: 'fci' },
    { id: 'combo-haiku', object: 'model', owned_by: 'combo', context_length: 200_000 },
    { id: 'venice/llama', object: 'model', owned_by: 'venice' },
    // The gateway classifies; an id that merely LOOKS like a combo is not one.
    { id: 'ag/claude-opus-4-6-thinking', object: 'model', owned_by: 'ag' },
    { id: 'combo-gpt', object: 'model', owned_by: 'combo' }
  ]
}

function fetchStub(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch
}

describe('fetchGatewayModelList', () => {
  it('keeps only combo ids, deduped and sorted, regardless of what the id looks like', async () => {
    const ids = await fetchGatewayModelList('https://gw.example/v1/', 'tok', {
      fetchImpl: fetchStub(gatewayPayload)
    })
    expect(ids).toEqual(['combo-gpt', 'combo-haiku'])
  })

  it('asks the gateway bearer-authenticated, without doubling the slash', async () => {
    let seen: { url: string; auth: string | undefined } | undefined
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization }
      return new Response(JSON.stringify(gatewayPayload), { status: 200 })
    }) as unknown as typeof fetch
    await fetchGatewayModelList('https://gw.example/v1/', 'tok', { fetchImpl: spy })
    expect(seen).toEqual({ url: 'https://gw.example/v1/models', auth: 'Bearer tok' })
  })

  it('returns undefined rather than throwing when the gateway is unreachable, refuses, or answers junk', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await fetchGatewayModelList('https://gw.example/v1', 'tok', { fetchImpl: boom })).toBeUndefined()
    expect(
      await fetchGatewayModelList('https://gw.example/v1', 'tok', { fetchImpl: fetchStub({}, 500) })
    ).toBeUndefined()
    expect(
      await fetchGatewayModelList('https://gw.example/v1', 'tok', { fetchImpl: fetchStub({ models: [] }) })
    ).toBeUndefined()
    expect(await fetchGatewayModelList('', 'tok', { fetchImpl: fetchStub(gatewayPayload) })).toBeUndefined()
    expect(
      await fetchGatewayModelList('https://gw.example/v1', '  ', { fetchImpl: fetchStub(gatewayPayload) })
    ).toBeUndefined()
  })
})

describe('applyGatewayModelList', () => {
  function settingsFile(contents?: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'ac-gwsettings-'))
    const file = join(dir, '.claude', 'settings.json')
    if (contents !== undefined) {
      mkdirSync(join(dir, '.claude'), { recursive: true })
      writeFileSync(file, contents)
    }
    return file
  }

  it('always carries the built-in alias rows, so a session pinned to `haiku` never falls to default', () => {
    const file = settingsFile()
    expect(applyGatewayModelList(file, ['kimi-k-2-7-code', 'glm-5.3-flash'])).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      availableModels: [...ALIASES, 'kimi-k-2-7-code', 'glm-5.3-flash']
    })
  })

  it('does not repeat an alias the gateway also serves as a combo', () => {
    const file = settingsFile()
    applyGatewayModelList(file, ['haiku', 'combo-gpt'])
    expect(JSON.parse(readFileSync(file, 'utf8')).availableModels).toEqual([...ALIASES, 'combo-gpt'])
  })

  it('preserves every other key an operator put in settings.json', () => {
    const file = settingsFile(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.example/v1' }, model: 'opus' }))
    expect(applyGatewayModelList(file, ['kimi-k-2-7-code'])).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      env: { ANTHROPIC_BASE_URL: 'https://gw.example/v1' },
      model: 'opus',
      availableModels: [...ALIASES, 'kimi-k-2-7-code']
    })
  })

  it('rewrites its own list when the gateway changes, so a refresh is not frozen at first boot', () => {
    const aliases = [...ALIASES]
    const file = settingsFile()
    expect(applyGatewayModelList(file, ['combo-gpt'])).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).availableModels).toEqual([...aliases, 'combo-gpt'])
    expect(applyGatewayModelList(file, ['combo-gpt', 'combo-haiku'])).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).availableModels).toEqual([...aliases, 'combo-gpt', 'combo-haiku'])
    expect(applyGatewayModelList(file, ['combo-gpt'])).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).availableModels).toEqual([...aliases, 'combo-gpt'])
  })

  it('heals a list this daemon wrote before it knew about aliases', () => {
    const file = settingsFile(JSON.stringify({ availableModels: ['combo-gpt'] }))
    writeFileSync(`${file}.agentconnect-models`, 'combo-gpt\n')
    expect(applyGatewayModelList(file, ['combo-gpt'])).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).availableModels).toEqual([...ALIASES, 'combo-gpt'])
  })

  it('rewrites nothing when the gateway answers the list it already wrote', () => {
    const file = settingsFile()
    applyGatewayModelList(file, ['combo-gpt', 'combo-haiku'])
    const before = statSync(file).mtimeMs
    expect(applyGatewayModelList(file, ['combo-gpt', 'combo-haiku'])).toBe(false)
    expect(statSync(file).mtimeMs).toBe(before)
  })

  it('never overrides an operator list, and no-ops on an empty fetch', () => {
    const mine = settingsFile(JSON.stringify({ availableModels: ['opus'] }))
    expect(applyGatewayModelList(mine, ['kimi-k-2-7-code'])).toBe(false)
    expect(JSON.parse(readFileSync(mine, 'utf8')).availableModels).toEqual(['opus'])

    const file = settingsFile()
    expect(applyGatewayModelList(file, [])).toBe(false)
    expect(applyGatewayModelList(file, undefined)).toBe(false)
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('keeps the marker out of settings.json, which belongs to the operator', () => {
    const file = settingsFile(JSON.stringify({ model: 'opus' }))
    applyGatewayModelList(file, ['combo-gpt'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      model: 'opus',
      availableModels: [...ALIASES, 'combo-gpt']
    })
  })

  it('refuses to rewrite a settings.json that is not a JSON object', () => {
    const file = settingsFile('["not", "an", "object"]')
    expect(applyGatewayModelList(file, ['kimi-k-2-7-code'])).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('["not", "an", "object"]')
  })
})
