/**
 * The unified routing-rule model. Two layers produce `RoutingRule`s — the local
 * layer (from agent.json bindRules) and the CP layer (from route/*). The router
 * (`routeRules`) consumes the merged, resolved set.
 *
 * A `CpRule` is the stored CP-layer shape (no integration yet); `resolveCpRule`
 * resolves it to a `RoutingRule` at merge time (so a hot-added agent makes a
 * previously-unservable rule servable). `agent.id` IS the CP `agentId`.
 */
import type { Agent, BindMatch, BindRuleConfig, Integration } from '../agents/agent-schema.js'
import { configuredBotSelfId, integrationCore } from '../platforms/integration-config.js'
import {
  resolveDecisionBundle,
  type ResolvedDecisionBundle,
  type ResolvedDecisionGate,
  type ResolvedRoutedChannel
} from '../decisions/bundle.js'
import type { ActivationRule } from '@agentconnect.md/activation-policy'
import type { ChannelSessionMode, RouteAssign, RouteUpdate, ScopeRef, ThreadRef } from '@agentconnect.md/protocol'

export type RoutingMatch = BindMatch

/**
 * The daemon's resolved routing rule — the policy package's `ActivationRule`
 * (field docs live there) with the daemon's own `BindMatch` as the match
 * vocabulary. `extends` is the compile-time guarantee that what this module
 * BUILDS stays consumable by the pure ladder without adaptation; if either
 * shape drifts, this declaration breaks instead of the routing behavior.
 */
export interface RoutingRule extends ActivationRule {
  match: RoutingMatch
}

/** The platform-independent routing bits of an Integration (§6.4 core envelope) plus the bot's own id. */
export function integrationRouting(int: Integration): {
  staticBotUserId?: string
  bindRules: BindRuleConfig[]
  mutedChannels: ScopeRef[]
  affinityDenied: ScopeRef[]
  overriddenThreads: ThreadRef[]
  gated: boolean
  /** The enabled By decision gate for a channel with its resolved definition, or undefined. */
  decisionBindingFor(channel: string): ResolvedDecisionGate | undefined
  /** Whether the channel is By decision: a bundle binding (enabled or not) or a decision bind rule covering it. */
  decisionBound(channel: string): boolean
  /** The channel's shared-bot router binding, with the routing config only where this daemon is the host. */
  routingFor(channel: string): ResolvedRoutedChannel | undefined
  /** The bot router this daemon hosts for this integration, if any. */
  sharedBotRouting(): ResolvedDecisionBundle['sharedBotRouting']
} {
  const { bindRules, mutedChannels, affinityDenied, overriddenThreads, gated, decisions } = integrationCore(int)
  const bundle = resolveDecisionBundle(decisions)
  return {
    staticBotUserId: configuredBotSelfId(int),
    bindRules,
    mutedChannels,
    affinityDenied,
    overriddenThreads,
    gated,
    decisionBindingFor: (channel) => bundle.gates.get(channel),
    routingFor: (channel) => bundle.routed.get(channel),
    sharedBotRouting: () => bundle.sharedBotRouting,
    // A decision rule with no bundle entry is held, never Any: a hand-authored agent.json can carry one.
    decisionBound: (channel) =>
      bundle.bound.has(channel) ||
      bindRules.some(
        (rule) => rule.match.kind === 'decision' && (rule.channel === undefined || rule.channel === channel)
      )
  }
}

/** How this integration keys sessions in one conversation (channel-session-mode.md §4).
 *  Absent from the sparse wire list ⇒ `createNew`, which is what every conversation had
 *  before the setting existed and what an older CP's spec still means. */
export function conversationSessionMode(int: Integration, channel: string): ChannelSessionMode {
  return integrationCore(int).sessionModes.find((entry) => entry.channel === channel)?.mode ?? 'createNew'
}

/**
 * Is this conversation open to `int` at all? Three fences, all applying to the
 * channel coordinate (the enclosing configurable channel on every platform):
 *
 *  - Off — the operator muted this conversation. Applies to every integration.
 *  - A thread override — the topic carries its own trigger, so the channel's
 *    channel-wide fences stop at it while a thread-shaped one still reaches.
 *  - Gating (resource-visibility.md §14) — a restricted agent's integration admits
 *    ONLY conversations that carry a scoped rule, so an unknown one is refused too.
 *
 * The routing ladder enforces both through the rule set itself; this is for the
 * paths that resolve a target OUTSIDE it (control commands, message shortcuts, the
 * relay's pre-addressed hand-off), which would otherwise reach a silenced channel.
 */
export function conversationAdmitted(
  routing: Pick<ReturnType<typeof integrationRouting>, 'bindRules' | 'mutedChannels' | 'overriddenThreads' | 'gated'>,
  channel: string,
  thread: string | undefined
): boolean {
  const own = !routing.overriddenThreads.some((t) => refCovers(t, channel, thread, true))
  if (routing.mutedChannels.some((muted) => refCovers(muted, channel, thread, own))) return false
  if (!routing.gated) return true
  // Gating is fail-closed whatever the override: a channel-scoped rule is the conversation's OWN
  // statement, so it stops at a topic that carries its own trigger — without this, a gated
  // integration's `off` topic (which compiles to NO rule of its own) is admitted by the group's grant.
  return routing.bindRules.some(
    (rule) => rule.channel === channel && (rule.thread === undefined ? own : rule.thread === thread)
  )
}

/** Stored CP-layer rule — integration resolved lazily at merge time. */
export interface CpRule {
  agentId: string
  scope: { channel?: string; thread?: string }
  match: RoutingMatch
  epoch?: number
}

/** Does a fence ref reach this message? A channel-wide ref IS the channel's own statement,
 *  so it stops at a thread that carries its own trigger; a thread-shaped ref always reaches
 *  the thread it names. Mirrors the policy package's `refCovers`. */
function refCovers(ref: ScopeRef, channel: string, thread: string | undefined, own: boolean): boolean {
  if (typeof ref === 'string') return own && ref === channel
  return ref.channel === channel && ref.thread === thread
}


/**
 * Resolve an agent to an integration's `{ integrationId, botUserId, platform }`. When
 * `platform` is given, prefer the integration on that platform (a multi-platform agent may
 * bridge Slack + Telegram); otherwise — or if none matches — use the first integration.
 * Pure: `botUserIds` (integrationId → resolved bot user id / Telegram @username) overrides
 * the static config id. Returns null when there is no agent or no integration (unservable).
 */
export function resolveAgentIntegration(
  agent: Agent | undefined,
  botUserIds: Record<string, string>,
  platform?: string
): {
  integrationId: string
  botUserId: string
  platform: string
  mutedChannels: ScopeRef[]
  affinityDenied: ScopeRef[]
  overriddenThreads: ThreadRef[]
} | null {
  // Prefer an integration on the requested platform — an agent may bridge several (e.g.
  // Slack + Telegram). Delivering a reply/wake into a session on platform X must use X's
  // integration; otherwise the turn's output posts through the wrong platform's client
  // (e.g. a Telegram chat id sent via the Slack client → channel_not_found). Fall back to
  // the first integration only when the platform is unspecified or unmatched.
  //
  // This comparison STAYS platform-keyed on purpose (audit Appendix A,
  // router/routing-rule.ts:124, classified "routing"): it is a platform-vs-platform
  // equality with no literal in it, so it is already correct for every platform an
  // open `PlatformId` can name and there is nothing here to extract.
  const int =
    (platform ? agent?.integrations.find((i) => i.platform === platform) : undefined) ?? agent?.integrations[0]
  if (!int) return null
  const { staticBotUserId, mutedChannels, affinityDenied, overriddenThreads } = integrationRouting(int)
  return {
    integrationId: int.id,
    botUserId: botUserIds[int.id] ?? staticBotUserId ?? '',
    platform: int.platform,
    mutedChannels,
    affinityDenied,
    affinityDenied
  }
}

/** Local layer: one resolved RoutingRule per bindRule of EACH integration (any
 *  platform), tagged with its platform so cross-platform messages can't collide. */
export function rulesFromAgent(agent: Agent, botUserIds: Record<string, string>): RoutingRule[] {
  const out: RoutingRule[] = []
  for (const int of agent.integrations) {
    const { staticBotUserId, bindRules, mutedChannels, affinityDenied, overriddenThreads } = integrationRouting(int)
    const botUserId = botUserIds[int.id] ?? staticBotUserId ?? ''
    for (const br of bindRules) {
      out.push({
        agentId: agent.id,
        integrationId: int.id,
        botUserId,
        scope: { ...(br.channel ? { channel: br.channel } : {}), ...(br.thread ? { thread: br.thread } : {}) },
        match: br.match,
        mutedChannels,
    affinityDenied,
        affinityDenied,
        overriddenThreads,
        source: 'config',
        platform: int.platform
      })
    }
  }
  return out
}

/** Resolve a stored CP rule to a RoutingRule; null if the agent is unservable. */
export function resolveCpRule(
  cp: CpRule,
  resolve: (agentId: string) => {
    integrationId: string
    botUserId: string
    platform: string
    mutedChannels?: ScopeRef[]
    affinityDenied?: ScopeRef[]
    overriddenThreads?: ThreadRef[]
  } | null
): RoutingRule | null {
  const r = resolve(cp.agentId)
  if (!r) return null
  return {
    agentId: cp.agentId,
    integrationId: r.integrationId,
    botUserId: r.botUserId,
    scope: cp.scope,
    match: cp.match,
    // A CP session placement is scoped to a conversation the operator may since have
    // switched off; it carries its integration's fence for the same reason a local rule does.
    ...(r.mutedChannels ? { mutedChannels: r.mutedChannels } : {}),
    ...(r.affinityDenied ? { affinityDenied: r.affinityDenied } : {}),
    ...(r.overriddenThreads ? { overriddenThreads: r.overriddenThreads } : {}),
    source: 'cp',
    platform: r.platform,
    ...(cp.epoch !== undefined ? { epoch: cp.epoch } : {})
  }
}

/** Canonical sessionKey string — matches the protocol's `${platform}:${channel}:${thread ?? "-"}`. */
export function sessionKeyStr(sk: { platform: string; channel: string; thread?: string }): string {
  return `${sk.platform}:${sk.channel}:${sk.thread ?? '-'}`
}

/** route/assign → stored CP rules scoped to its sessionKey (integration resolved later). */
export function cpRulesFromAssign(a: RouteAssign, epoch?: number): CpRule[] {
  return a.bindRules.map((br) => ({
    agentId: a.agentId,
    scope: { channel: a.sessionKey.channel, ...(a.sessionKey.thread ? { thread: a.sessionKey.thread } : {}) },
    match: br.match,
    ...(epoch !== undefined ? { epoch } : {})
  }))
}

/** route/update → global (unscoped) CP rules. Malformed match entries are skipped. */
export function cpRulesFromUpdate(u: RouteUpdate): CpRule[] {
  const out: CpRule[] = []
  for (const r of u.rules) {
    const m = r.match as { kind?: string; value?: unknown }
    if (m?.kind === 'mention' || m?.kind === 'dm' || m?.kind === 'auto') {
      out.push({ agentId: r.agentId, scope: {}, match: { kind: m.kind } as RoutingMatch, epoch: u.routingEpoch })
    } else if (m?.kind === 'keyword' && typeof m.value === 'string') {
      out.push({ agentId: r.agentId, scope: {}, match: { kind: 'keyword', value: m.value }, epoch: u.routingEpoch })
    }
  }
  return out
}
