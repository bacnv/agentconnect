import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from '../log.js'

/** The one gateway field separating a combo (AgentConnect-owned) entry from a pass-through
 *  upstream (`fci/…`, `venice/…`) — the gateway owns the classification, not the id's shape. */
const COMBO_OWNER = 'combo'
const DEFAULT_TIMEOUT_MS = 5_000

/** The combo ids a gateway serves, or undefined when it cannot be asked. `availableModels` is the
 *  only channel that yields the combo set WHOLE — the discovery flag filters /models by the literal
 *  "claude" in the id, dropping `kimi-k-2-7-code` and leaking `ag/claude-opus-4-6-thinking`.
 *  Never throws: an unreachable gateway keeps the list it already had. */
export async function fetchGatewayModelList(
  baseUrl: string | undefined,
  token: string | undefined,
  opts: { log?: Logger; timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<string[] | undefined> {
  if (!baseUrl?.trim() || !token?.trim()) return undefined
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    })
    if (!res.ok) {
      opts.log?.warn(`gateway models: ${url} answered ${res.status}; keeping the current list`)
      return undefined
    }
    const payload = (await res.json()) as { data?: unknown }
    if (!Array.isArray(payload?.data)) {
      opts.log?.warn(`gateway models: ${url} did not answer an OpenAI-shaped model list; ignoring it`)
      return undefined
    }
    const ids: string[] = []
    for (const entry of payload.data) {
      if (typeof entry !== 'object' || entry === null) continue
      const { id, owned_by: owner } = entry as { id?: unknown; owned_by?: unknown }
      if (typeof id !== 'string' || !id.trim() || owner !== COMBO_OWNER) continue
      ids.push(id.trim())
    }
    return [...new Set(ids)].sort()
  } catch (err) {
    opts.log?.warn(`gateway models: ${url} failed — ${err instanceof Error ? err.message : 'unknown error'}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Merge the fetched list into a Claude Code settings.json, preserving every other key. The FILE is
 *  the only channel that reaches the picker — `CLAUDE_MODEL_CONFIG` lands in the SDK's flag tier,
 *  while the `configOptions` a session and the probe advertise come from `settingsManager
 *  .getSettings()`, which resolves settings FILES alone (measured: env → `["default"]`, file →
 *  every id). Rewrites while the sidecar marker says this daemon owns the list, so a refreshed
 *  gateway is followed; a hand-written list carries no marker and is never overridden. */
export function applyGatewayModelList(settingsFile: string, models: readonly string[] | undefined): boolean {
  if (!models || models.length === 0) return false
  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    existing = parsed as Record<string, unknown>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  const marker = `${settingsFile}.agentconnect-models`
  // The marker lives beside the file, not inside it: settings.json is the operator's, and its
  // schema is Claude Code's to define.
  const owned = existsSync(marker)
  if (Array.isArray(existing.availableModels) && existing.availableModels.length > 0 && !owned) return false
  const next = [...models]
  if (owned && sameList(existing.availableModels, next)) return false
  mkdirSync(dirname(settingsFile), { recursive: true, mode: 0o700 })
  writeFileSync(settingsFile, `${JSON.stringify({ ...existing, availableModels: next }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  writeFileSync(marker, `${next.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  return true
}

function sameList(current: unknown, next: readonly string[]): boolean {
  if (!Array.isArray(current) || current.length !== next.length) return false
  return current.every((id, index) => id === next[index])
}
