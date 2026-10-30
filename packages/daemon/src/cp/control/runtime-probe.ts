import type { AnyFrame } from '@agentconnect.md/protocol'
import type { ControlHandler } from './context.js'

/** `daemon/runtimes/probe` — the console's "reload models" for one provider.
 *
 *  Two sources feed a picker, so one request refreshes both: the runtime probe re-launches each
 *  adapter and re-reads what it advertises (`openai` — a codex model list is the adapter's own),
 *  and the gateway fetch re-reads `/v1/models` for the stored `anthropic` key, which the adapter
 *  never sees because those combos reach it through `availableModels`. */
export interface RuntimeProbeDeps {
  /** Undefined unless this daemon takes requests; the probe itself runs in the background. */
  runtimeProbe?: () => void
  /** Re-read the gateway's combo list for the stored Anthropic key. */
  reloadGatewayModels?: () => Promise<void>
}

export const runtimeProbe: ControlHandler<RuntimeProbeDeps> = (frame: AnyFrame, deps, wire) => {
  if (!deps.runtimeProbe) {
    wire.reply(frame, 'ack', { ok: false, reason: 'this daemon does not take runtime probe requests' })
    return
  }
  deps.runtimeProbe()
  void deps.reloadGatewayModels?.().catch(() => undefined)
  wire.reply(frame, 'ack', { ok: true })
}
