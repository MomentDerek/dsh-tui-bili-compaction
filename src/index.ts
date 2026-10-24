import type { PluginOptions } from './config.js'
import { resolveOptions } from './config.js'
import type { DshAgentLike, DshSessionLike, DshTokenMeter, DshTokenMeasurement, DshToolDefinition } from './dsh-types.js'
import { CompactionEngine } from './engine.js'
import { SessionStore } from './store.js'
import { registerTools } from './tools.js'

/**
 * dsh-TUI's compaction engine, backed by billion-context's kernel.
 *
 * dsh's own compression contract is a durable surface replacement: a
 * `user/message` carrying `surfaceOp: {op:'replace', startSeq, endSeq}` shadows
 * the range it covers, and every consumer (the transcript, the token meter, the
 * status line) reads that fold. This plugin drives the kernel's 3-tier LSM
 * against the append-origin log, so blocks/tiers/refs survive across turns while
 * the fold stays dsh's own.
 *
 * Everything dsh-facing is structural: a profile plugin cannot import
 * `@deepseek-ai/*` (the profile realm does not resolve harness packages), so
 * the types below are duck-typed mirrors of the real services.
 */

export const name = 'bili-compaction'

/** Native compaction is disabled first, then tools are registered. */
export const inject: readonly string[] = []

const NATIVE_COMPACTION = new Set([
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
])

interface ConfigRow {
  name?: unknown
  config?: unknown
  group?: unknown
  disabled?: unknown
  [key: string]: unknown
}

interface ComposedConfig {
  plugins?: unknown
  [key: string]: unknown
}

function rewriteRows(rows: readonly unknown[]): { rows: unknown[]; changed: number } {
  let changed = 0
  const out: unknown[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      out.push(row)
      continue
    }
    const entry = row as ConfigRow
    if (typeof entry.name === 'string' && NATIVE_COMPACTION.has(entry.name)) {
      changed += 1
      out.push({ ...entry, disabled: true })
      continue
    }
    if (entry.group === true && Array.isArray(entry.config)) {
      const nested = rewriteRows(entry.config)
      changed += nested.changed
      out.push(nested.changed === 0 ? row : { ...entry, config: nested.rows })
      continue
    }
    out.push(row)
  }
  return { rows: out, changed }
}

/**
 * Fold `@deepseek-ai/dsh-compaction-basic` and `@deepseek-ai/dsh-command-compact`
 * out of the composed plugin tree.
 *
 * dsh composes the preset's plugin rows from the host config, so disabling them
 * here (rather than in a preset file) covers every preset dsh-tui can mount,
 * including custom ones.
 */
export function stripNativeCompaction(config: unknown): { config: unknown; changed: number } {
  if (typeof config !== 'object' || config === null) return { config, changed: 0 }
  const composed = config as ComposedConfig
  if (!Array.isArray(composed.plugins)) return { config, changed: 0 }
  const rewritten = rewriteRows(composed.plugins)
  if (rewritten.changed === 0) return { config, changed: 0 }
  return { config: { ...composed, plugins: rewritten.rows }, changed: rewritten.changed }
}

type Listener = (...args: never[]) => unknown

export interface PluginContext {
  on(event: string, listener: Listener, options?: { global?: boolean }): () => void
  get?(name: string): unknown
  inject?(deps: readonly string[], callback: (ctx: PluginContext) => void): () => void
  effect?(callback: () => void | (() => void)): void
}

/**
 * Read a service without declaring it in `inject`.
 *
 * cordis throws `cannot get property "<name>" without inject` for a plain
 * property read, and declaring `tools`/`tokenMeter` as required would keep the
 * whole plugin pending on profiles that do not mount them. `ctx.get` is the
 * documented way to probe, and a probe must never take the plugin down.
 */
function safeGet(ctx: PluginContext, name: string): unknown {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

function asTokenMeter(value: unknown): DshTokenMeter | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const meter = value as DshTokenMeter
  return typeof meter.measure === 'function' ? meter : undefined
}

function resolveTokenMeter(ctx: PluginContext): DshTokenMeter | undefined {
  return asTokenMeter(safeGet(ctx, 'tokenMeter'))
}

interface AgentsService {
  currentInitiator?(): { session?: DshSessionLike } | undefined
}

interface ToolsService {
  register(definition: DshToolDefinition): () => void
}

function asAgents(value: unknown): AgentsService | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as AgentsService
}

function asTools(value: unknown): ToolsService | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const tools = value as ToolsService
  return typeof tools.register === 'function' ? tools : undefined
}

function resolveSession(ctx: PluginContext): DshSessionLike | undefined {
  return asAgents(safeGet(ctx, 'agents'))?.currentInitiator?.()?.session
}

/**
 * Warm the kernel on every step and (optionally) hand the model its nudge.
 *
 * dsh has no ephemeral message channel: anything a `pre-step` listener returns
 * is appended to the durable log by `agent-loop`, so the nudge is opt-in
 * (`injectNudge`). Left off, the same text is reachable through `acp_status`,
 * which costs one tool call and nothing in the log.
 */
function installStepHook(ctx: PluginContext, engine: CompactionEngine, injectNudge: boolean, meter: DshTokenMeter | undefined): void {
  const listener = async (payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
    const decision = await next()
    const agent = (payload as { agent?: DshAgentLike } | undefined)?.agent
    const session = agent?.session
    if (session === undefined) return decision
    const measurement = meter?.measure(session)
    const refreshed = engine.refresh(session, measurement)
    if (!injectNudge) return decision
    const text = engine.nudgeText(refreshed.decision)
    if (text === null) return decision
    if (typeof decision !== 'object' || decision === null) return decision
    const enter = decision as { kind?: unknown; messages?: unknown }
    if (enter.kind !== 'enter' || !Array.isArray(enter.messages)) return decision
    return {
      ...enter,
      messages: [
        ...enter.messages,
        {
          id: `acp_nudge_${Date.now().toString(36)}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'bili-compaction-nudge' },
        },
      ],
    }
  }
  ctx.on('agent/pre-step', listener as unknown as Listener, { global: true })
}

export function apply(ctx: PluginContext, rawConfig?: PluginOptions): void {
  const options = resolveOptions(rawConfig)
  const engine = new CompactionEngine(options, new SessionStore(options.storageDir))

  if (options.disableNativeCompaction) {
    const listener = (config: unknown, next: () => unknown): unknown => {
      const resolved = next()
      const rewritten = stripNativeCompaction(resolved)
      return rewritten.config
    }
    ctx.on('internal/config', listener as unknown as Listener, { global: true })
  }

  const measureFor = (host: PluginContext): ((session: DshSessionLike) => DshTokenMeasurement) | undefined => {
    const meter = resolveTokenMeter(host)
    return meter === undefined ? undefined : (session) => meter.measure(session)
  }

  const install = (host: PluginContext, tools: ToolsService): void => {
    const measure = measureFor(host)
    const disposers = registerTools(
      { register: (definition) => tools.register(definition) },
      engine,
      {
        currentSession: () => resolveSession(host),
        ...(measure === undefined ? {} : { measure }),
      },
    )
    const dispose = (): void => {
      for (const disposer of disposers) disposer()
    }
    host.effect?.(() => dispose)
  }

  const tools = asTools(safeGet(ctx, 'tools'))
  if (tools !== undefined) {
    install(ctx, tools)
  } else if (typeof ctx.inject === 'function') {
    // The tools service may not exist yet (or may come and go); cordis re-runs
    // this callback whenever it becomes available.
    ctx.inject(['tools'], (inner) => {
      const late = asTools(safeGet(inner, 'tools'))
      if (late !== undefined) install(inner, late)
    })
  } else {
    console.warn('[bili-compaction] no tools service on this context; compress/decompress/acp_status were not registered')
  }

  installStepHook(ctx, engine, options.injectNudge, resolveTokenMeter(ctx))
}
