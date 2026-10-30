import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from '../log.js'

/** The one gateway field separating a combo from a pass-through upstream (`fci/…`) — the gateway classifies, not the id's shape. */
const COMBO_OWNER = 'combo'
const DEFAULT_TIMEOUT_MS = 5_000

/** A stored provider header, as the request must actually carry it.
 *
 *  A provider key saves its headers as name/value rows, but the console's Claude profile also lets an
 *  operator paste the whole `ANTHROPIC_CUSTOM_HEADERS` block into one row — real newlines or the
 *  literal `\n` two characters. Sending that row as-is puts `anthropic_custom_headers:` on the wire
 *  and the headers inside it never reach the gateway, so a Cloudflare Access pair is silently lost. */
export function customHeaderPairs(headers: Record<string, string>): Record<string, string> {
  const pairs: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lines = value
      .split(/\r?\n|\\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const nested = lines.every((line) => {
      const colon = line.indexOf(':')
      return colon > 0 && HEADER_NAME.test(line.slice(0, colon).trim())
    })
    if (!nested) {
      pairs[name] = value
      continue
    }
    for (const line of lines) {
      const colon = line.indexOf(':')
      pairs[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
    }
  }
  return pairs
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Claude Code's alias rows: `availableModels` is an allowlist, so omitting one deletes its picker row.
 *  ponytail: hardcoded — derive from the SDK if Claude Code ever adds a seventh. */
const BUILTIN_MODEL_ALIASES = ['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable']

/** The catalog row the CLI maps an unknown combo id onto: `behavesAs` "changes neither the row's label
 *  nor the model ID sent". A combo the CLI's catalog does not know fails its turn with `Unable to
 *  validate model` until it is mapped, so every fetched combo gets one. */
const BEHAVES_AS_FALLBACK = 'claude-sonnet-5'

/** The combo ids a gateway serves, or undefined when it cannot be asked. Never throws. */
export async function fetchGatewayModelList(
  baseUrl: string | undefined,
  token: string | undefined,
  opts: {
    log?: Logger
    timeoutMs?: number
    fetchImpl?: typeof fetch
    /** Deployment headers the gateway needs before it answers at all (a Cloudflare Access pair). */
    headers?: Record<string, string>
  } = {}
): Promise<string[] | undefined> {
  if (!baseUrl?.trim() || !token?.trim()) return undefined
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      headers: { ...opts.headers, Authorization: `Bearer ${token}` },
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

/** Merge aliases + combos into settings.json, preserving every other key. A settings FILE is the only
 *  channel that reaches the picker, and only a marker-owned list is rewritten, so an operator's survives. */
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
  const next = [...new Set([...BUILTIN_MODEL_ALIASES, ...models])]
  // Both fields, because they do different jobs: `availableModels` is what the adapter advertises,
  // `modelPicker` is what makes the CLI accept an id its catalog does not know. Writing only the
  // former leaves every combo turn failing "Unable to validate model" while the picker looks right.
  const picker = pickerOptions(existing.modelPicker, next)
  if (owned && sameList(existing.availableModels, next) && samePicker(existing.modelPicker, picker)) return false
  mkdirSync(dirname(settingsFile), { recursive: true, mode: 0o700 })
  writeFileSync(
    settingsFile,
    `${JSON.stringify({ ...existing, availableModels: next, ...(picker ? { modelPicker: picker } : {}) }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )
  writeFileSync(marker, `${next.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  return true
}

/** `availableModels` rows with a `behavesAs` mapping, keeping any option fields an operator set. */
function pickerOptions(
  current: unknown,
  models: readonly string[]
): { options: Record<string, unknown>[] } | undefined {
  const kept = new Map<string, Record<string, unknown>>()
  const options = (current as { options?: unknown } | undefined)?.options
  if (Array.isArray(options)) {
    for (const option of options) {
      if (typeof option === 'object' && option !== null && typeof (option as { model?: unknown }).model === 'string') {
        kept.set((option as { model: string }).model, option as Record<string, unknown>)
      }
    }
  }
  // Alias rows are real models the CLI already knows; only the gateway's own ids need mapping.
  const rows = models
    .filter((model) => !BUILTIN_MODEL_ALIASES.includes(model))
    .map((model) => kept.get(model) ?? { model, label: model, behavesAs: BEHAVES_AS_FALLBACK })
  return rows.length > 0 ? { options: rows } : undefined
}

function samePicker(current: unknown, next: { options: Record<string, unknown>[] } | undefined): boolean {
  if (!next) return true
  return JSON.stringify(current) === JSON.stringify(next)
}

function sameList(current: unknown, next: readonly string[]): boolean {
  if (!Array.isArray(current) || current.length !== next.length) return false
  return current.every((id, index) => id === next[index])
}
