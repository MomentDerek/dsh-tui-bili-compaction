import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginOptions } from './config.js'
import { resolveOptions } from './config.js'
import type {
  DshAgentLike,
  DshAgentPresetsLike,
  DshSessionLike,
  DshTokenMeter,
  DshTokenMeasurement,
  DshToolDefinition,
} from './dsh-types.js'
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
 * Legacy helper for synthesised plugin trees.
 *
 * Do not use this for dsh-tui: `internal/config` is dispatched with a single
 * loader entry's own config, and bundled presets are mounted as `PresetTree`s
 * outside the host loader. Keeping the helper lets callers that already own a
 * composed tree reuse the rewrite, but the live plugin disables native
 * compaction through `installNativeCompactionGuard` instead.
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
  /** Loader base URL, used as a module-resolution anchor for harness packages. */
  readonly baseUrl?: string | URL
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

function asAgentPresets(value: unknown): DshAgentPresetsLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as DshAgentPresetsLike
}

/** Read a preset-realm service from the agent itself when the registry is absent. */
function serviceFromAgent(agent: DshAgentLike, name: string): unknown {
  const agentContext = agent.ctx
  if (typeof agentContext !== 'object' || agentContext === null) return undefined
  const context = agentContext as { get?: (service: string) => unknown; [key: string]: unknown }
  if (typeof context.get === 'function') {
    try {
      const service = context.get(name)
      if (service !== undefined) return service
    } catch {
      // An uninjected service throws; fall through to the property read.
    }
  }
  try {
    return context[name]
  } catch {
    return undefined
  }
}

interface ManualCompactionErrorConstructor {
  new (code: string, message: string, options?: { cause?: unknown }): Error & { code: string; name: string }
}

let cachedManualCompactionError: ManualCompactionErrorConstructor | undefined
let loadingManualCompactionError: Promise<ManualCompactionErrorConstructor | undefined> | undefined

/**
 * Resolve `@deepseek-ai/dsh-compaction` from the profile realm.
 *
 * A profile plugin cannot statically import harness packages (`package.json`
 * dependencies are not the profile's), but the agent context carries the
 * loader base URL. Resolve from that anchor (and a few fallbacks), then import
 * the resolved ESM file. Caching the constructor keeps `/compact` failures
 * classified as `ManualCompactionError` for the life of the plugin.
 */
function moduleAnchors(agent: DshAgentLike, ctx: PluginContext): string[] {
  const anchors: string[] = []
  const base = agent.ctx?.baseUrl ?? ctx.baseUrl
  if (base !== undefined) {
    try {
      if (typeof base === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(base)) {
        anchors.push(pathToFileURL(join(base, '__bili_compaction_probe__.cjs')).href)
      } else {
        const url = typeof base === 'string' ? new URL(base) : base
        anchors.push(url.href)
        const directory = url.href.endsWith('/') ? url : new URL(`${url.href}/`)
        anchors.push(new URL('__bili_compaction_probe__.cjs', directory).href)
      }
    } catch {
      // A malformed base URL only loses this anchor.
    }
  }
  anchors.push(pathToFileURL(join(process.cwd(), '__bili_compaction_probe__.cjs')).href)
  anchors.push(import.meta.url)
  return anchors
}

async function loadManualCompactionError(
  agent: DshAgentLike,
  ctx: PluginContext,
): Promise<ManualCompactionErrorConstructor | undefined> {
  if (cachedManualCompactionError !== undefined) return cachedManualCompactionError
  if (loadingManualCompactionError !== undefined) return loadingManualCompactionError
  loadingManualCompactionError = (async (): Promise<ManualCompactionErrorConstructor | undefined> => {
    for (const anchor of moduleAnchors(agent, ctx)) {
      try {
        const resolver = createRequire(anchor)
        let resolved: string | undefined
        try {
          // `/compact` imports the error from *its own* dsh-compaction copy.
          // Resolving through the command module keeps `instanceof` aligned
          // even when the profile has more than one pnpm instance installed.
          const command = resolver.resolve('@deepseek-ai/dsh-command-compact')
          resolved = createRequire(pathToFileURL(command).href).resolve('@deepseek-ai/dsh-compaction')
        } catch {
          resolved = resolver.resolve('@deepseek-ai/dsh-compaction')
        }
        const loaded = (await import(pathToFileURL(resolved).href)) as { ManualCompactionError?: unknown }
        if (typeof loaded.ManualCompactionError === 'function') {
          cachedManualCompactionError = loaded.ManualCompactionError as ManualCompactionErrorConstructor
          return cachedManualCompactionError
        }
      } catch {
        // Try the next anchor; the profile realm is not required to expose it.
      }
    }
    return undefined
  })()
  try {
    return await loadingManualCompactionError
  } finally {
    loadingManualCompactionError = undefined
  }
}

/** Build an error `/compact` recognizes as an expected cancellation. */
function disabledCompactionError(
  ctor: ManualCompactionErrorConstructor | undefined,
  message: string,
): Error & { code: string; name: string } {
  if (ctor !== undefined) return new ctor('cancelled', message)
  const error = new Error(message) as Error & { code: string; name: string }
  error.name = 'ManualCompactionError'
  error.code = 'cancelled'
  return error
}

interface NativeCompactionGuard {
  /** Disable native surface mutators for this agent's preset realm. */
  patch(agent: DshAgentLike): void
  dispose(): void
}

/**
 * dsh-tui mounts bundled presets as in-memory `PresetTree`s, so a profile-level
 * `internal/config` rewrite can never reach their `compaction-basic` row. The
 * preset registry does expose the live service, though, and the automatic
 * compaction listener dispatches through `this.compactIfNeeded`. Patching that
 * one method is the only seam available to a profile plugin on dsh-tui 0.14.x;
 * without it native compaction keeps folding the surface behind this engine's
 * append-origin view.
 *
 * `compactNow` is the manual `/compact` entry point; it is disabled too so the
 * two compaction systems cannot both write `compaction/summary` checkpoints.
 */
function installNativeCompactionGuard(ctx: PluginContext): NativeCompactionGuard {
  let presets = asAgentPresets(safeGet(ctx, 'agentPresets'))
  const patched = new WeakSet<object>()
  const restores: Array<{ target: Record<string, unknown>; method: string; original: unknown }> = []
  let warned = false
  let warnedMissing = false

  const resolveService = (agent: DshAgentLike, name: string): unknown => {
    if (presets === undefined || typeof presets.serviceFor !== 'function') {
      // The registry can appear after this plugin's `apply`; probe again.
      presets = asAgentPresets(safeGet(ctx, 'agentPresets'))
    }
    if (presets !== undefined && typeof presets.serviceFor === 'function') {
      try {
        const service = presets.serviceFor(agent, name)
        if (service !== undefined) return service
      } catch {
        // Fall through to the agent's preset-scoped context.
      }
    }
    return serviceFromAgent(agent, name)
  }

  const patchService = (
    agent: DshAgentLike,
    name: string,
    replacements: Readonly<Record<string, (...args: unknown[]) => unknown>>,
  ): void => {
    const service = resolveService(agent, name)
    if (service === undefined) {
      if (name === 'compaction' && !warnedMissing) {
        warnedMissing = true
        console.warn('[bili-compaction] compaction service is unavailable; native compaction cannot be disabled and may fold the surface alongside this plugin')
      }
      return
    }
    if (typeof service !== 'object' || service === null || patched.has(service)) return
    patched.add(service)
    const target = service as Record<string, unknown>
    for (const [method, replacement] of Object.entries(replacements)) {
      if (typeof target[method] !== 'function') continue
      const original = target[method]
      try {
        target[method] = replacement
        restores.push({ target, method, original })
      } catch {
        if (!warned) {
          warned = true
          console.warn(`[bili-compaction] could not disable native compaction service method "${method}"; automatic compaction may still run alongside this plugin`)
        }
      }
    }
  }

  const patch = (agent: DshAgentLike): void => {
    patchService(agent, 'compaction', {
      compactIfNeeded: async (): Promise<null> => null,
      compactNow: async (): Promise<never> => {
        const ctor = await loadManualCompactionError(agent, ctx)
        throw disabledCompactionError(
          ctor,
          'native compaction is disabled by bili-compaction; use the compress tool instead',
        )
      },
    })
    // The pruner writes its own durable surface replacements. It is currently
    // disabled inside dsh-compaction-basic, but guard it defensively so a build
    // that re-enables pruning cannot mutate the surface behind this engine.
    patchService(agent, 'toolResultPruner', {
      pruneContent: (): null => null,
      pruneSession: (): { pruned: never[]; charsRemoved: number } => ({ pruned: [], charsRemoved: 0 }),
    })
  }

  return {
    patch,
    dispose(): void {
      for (const { target, method, original } of restores) {
        try {
          target[method] = original
        } catch {
          // The service realm is already gone; nothing to restore.
        }
      }
      restores.length = 0
    },
  }
}

/**
 * Warm the kernel on every step and (optionally) hand the model its nudge.
 *
 * dsh has no ephemeral message channel: anything a `pre-step` listener returns
 * is appended to the durable log by `agent-loop`, so the nudge is opt-in
 * (`injectNudge`). Left off, the same text is reachable through `acp_status`,
 * which costs one tool call and nothing in the log.
 */
function installStepHook(
  ctx: PluginContext,
  engine: CompactionEngine,
  injectNudge: boolean,
  getMeter: () => DshTokenMeter | undefined,
  nativeGuard: NativeCompactionGuard | undefined,
): void {
  const listener = async (payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
    const decision = await next()
    const agent = (payload as { agent?: DshAgentLike } | undefined)?.agent
    const session = agent?.session
    if (session === undefined) return decision
    if (agent !== undefined) nativeGuard?.patch(agent)
    const measurement = getMeter()?.measure(session)
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
  const nativeGuard = options.disableNativeCompaction ? installNativeCompactionGuard(ctx) : undefined
  if (nativeGuard !== undefined) {
    ctx.effect?.(() => () => nativeGuard.dispose())
    // Patch at creation, before the first `agent/pre-step`: the preset's own
    // automatic-compaction listener may be ordered ahead of this plugin's hook,
    // and it would otherwise get one uncompacted step through.
    const onCreated = (payload: unknown): void => {
      const agent = (payload as { agent?: DshAgentLike } | undefined)?.agent
      if (agent !== undefined) nativeGuard.patch(agent)
    }
    ctx.on('agent/created', onCreated as unknown as Listener, { global: true })
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

  installStepHook(ctx, engine, options.injectNudge, () => resolveTokenMeter(ctx), nativeGuard)
}
