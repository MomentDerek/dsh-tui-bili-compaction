import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveOptions } from './config.js';
import { CompactionEngine } from './engine.js';
import { SessionStore } from './store.js';
import { registerTools } from './tools.js';
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
export const name = 'bili-compaction';
export const inject = [];
const NATIVE_COMPACTION = new Set([
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-command-compact',
]);
function rewriteRows(rows) {
    let changed = 0;
    const out = [];
    for (const row of rows) {
        if (typeof row !== 'object' || row === null) {
            out.push(row);
            continue;
        }
        const entry = row;
        if (typeof entry.name === 'string' && NATIVE_COMPACTION.has(entry.name)) {
            changed += 1;
            out.push({ ...entry, disabled: true });
            continue;
        }
        if (entry.group === true && Array.isArray(entry.config)) {
            const nested = rewriteRows(entry.config);
            changed += nested.changed;
            out.push(nested.changed === 0 ? row : { ...entry, config: nested.rows });
            continue;
        }
        out.push(row);
    }
    return { rows: out, changed };
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
export function stripNativeCompaction(config) {
    if (typeof config !== 'object' || config === null)
        return { config, changed: 0 };
    const composed = config;
    if (!Array.isArray(composed.plugins))
        return { config, changed: 0 };
    const rewritten = rewriteRows(composed.plugins);
    if (rewritten.changed === 0)
        return { config, changed: 0 };
    return { config: { ...composed, plugins: rewritten.rows }, changed: rewritten.changed };
}
/**
 * Read a service without declaring it in `inject`.
 *
 * cordis throws `cannot get property "<name>" without inject` for a plain
 * property read, and declaring `tools`/`tokenMeter` as required would keep the
 * whole plugin pending on profiles that do not mount them. `ctx.get` is the
 * documented way to probe, and a probe must never take the plugin down.
 */
function safeGet(ctx, name) {
    try {
        return ctx.get?.(name);
    }
    catch {
        return undefined;
    }
}
function asTokenMeter(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const meter = value;
    return typeof meter.measure === 'function' ? meter : undefined;
}
function resolveTokenMeter(ctx) {
    return asTokenMeter(safeGet(ctx, 'tokenMeter'));
}
function asAgents(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    return value;
}
function asTools(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const tools = value;
    return typeof tools.register === 'function' ? tools : undefined;
}
function resolveSession(ctx) {
    return asAgents(safeGet(ctx, 'agents'))?.currentInitiator?.()?.session;
}
function asAgentPresets(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    return value;
}
/** Read a preset-realm service from the agent itself when the registry is absent. */
function serviceFromAgent(agent, name) {
    const agentContext = agent.ctx;
    if (typeof agentContext !== 'object' || agentContext === null)
        return undefined;
    const context = agentContext;
    if (typeof context.get === 'function') {
        try {
            const service = context.get(name);
            if (service !== undefined)
                return service;
        }
        catch {
            // An uninjected service throws; fall through to the property read.
        }
    }
    try {
        return context[name];
    }
    catch {
        return undefined;
    }
}
let cachedManualCompactionError;
let loadingManualCompactionError;
/**
 * Resolve `@deepseek-ai/dsh-compaction` from the profile realm.
 *
 * A profile plugin cannot statically import harness packages (`package.json`
 * dependencies are not the profile's), but the agent context carries the
 * loader base URL. Resolve from that anchor (and a few fallbacks), then import
 * the resolved ESM file. Caching the constructor keeps `/compact` failures
 * classified as `ManualCompactionError` for the life of the plugin.
 */
function moduleAnchors(agent, ctx) {
    const anchors = [];
    const base = agent.ctx?.baseUrl ?? ctx.baseUrl;
    if (base !== undefined) {
        try {
            if (typeof base === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(base)) {
                anchors.push(pathToFileURL(join(base, '__bili_compaction_probe__.cjs')).href);
            }
            else {
                const url = typeof base === 'string' ? new URL(base) : base;
                anchors.push(url.href);
                const directory = url.href.endsWith('/') ? url : new URL(`${url.href}/`);
                anchors.push(new URL('__bili_compaction_probe__.cjs', directory).href);
            }
        }
        catch {
            // A malformed base URL only loses this anchor.
        }
    }
    anchors.push(pathToFileURL(join(process.cwd(), '__bili_compaction_probe__.cjs')).href);
    anchors.push(import.meta.url);
    return anchors;
}
async function loadManualCompactionError(agent, ctx) {
    if (cachedManualCompactionError !== undefined)
        return cachedManualCompactionError;
    if (loadingManualCompactionError !== undefined)
        return loadingManualCompactionError;
    loadingManualCompactionError = (async () => {
        for (const anchor of moduleAnchors(agent, ctx)) {
            try {
                const resolver = createRequire(anchor);
                let resolved;
                try {
                    // `/compact` imports the error from *its own* dsh-compaction copy.
                    // Resolving through the command module keeps `instanceof` aligned
                    // even when the profile has more than one pnpm instance installed.
                    const command = resolver.resolve('@deepseek-ai/dsh-command-compact');
                    resolved = createRequire(pathToFileURL(command).href).resolve('@deepseek-ai/dsh-compaction');
                }
                catch {
                    resolved = resolver.resolve('@deepseek-ai/dsh-compaction');
                }
                const loaded = (await import(pathToFileURL(resolved).href));
                if (typeof loaded.ManualCompactionError === 'function') {
                    cachedManualCompactionError = loaded.ManualCompactionError;
                    return cachedManualCompactionError;
                }
            }
            catch {
                // Try the next anchor; the profile realm is not required to expose it.
            }
        }
        return undefined;
    })();
    try {
        return await loadingManualCompactionError;
    }
    finally {
        loadingManualCompactionError = undefined;
    }
}
/** Build an error `/compact` recognizes as an expected cancellation. */
function disabledCompactionError(ctor, message) {
    if (ctor !== undefined)
        return new ctor('cancelled', message);
    const error = new Error(message);
    error.name = 'ManualCompactionError';
    error.code = 'cancelled';
    return error;
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
function installNativeCompactionGuard(ctx) {
    let presets = asAgentPresets(safeGet(ctx, 'agentPresets'));
    const patched = new WeakSet();
    const restores = [];
    let warned = false;
    let warnedMissing = false;
    const resolveService = (agent, name) => {
        if (presets === undefined || typeof presets.serviceFor !== 'function') {
            // The registry can appear after this plugin's `apply`; probe again.
            presets = asAgentPresets(safeGet(ctx, 'agentPresets'));
        }
        if (presets !== undefined && typeof presets.serviceFor === 'function') {
            try {
                const service = presets.serviceFor(agent, name);
                if (service !== undefined)
                    return service;
            }
            catch {
                // Fall through to the agent's preset-scoped context.
            }
        }
        return serviceFromAgent(agent, name);
    };
    const patchService = (agent, name, replacements) => {
        const service = resolveService(agent, name);
        if (service === undefined) {
            if (name === 'compaction' && !warnedMissing) {
                warnedMissing = true;
                console.warn('[bili-compaction] compaction service is unavailable; native compaction cannot be disabled and may fold the surface alongside this plugin');
            }
            return;
        }
        if (typeof service !== 'object' || service === null || patched.has(service))
            return;
        patched.add(service);
        const target = service;
        for (const [method, make] of Object.entries(replacements)) {
            if (typeof target[method] !== 'function')
                continue;
            const original = target[method];
            try {
                target[method] = make(original);
                restores.push({ target, method, original });
            }
            catch {
                if (!warned) {
                    warned = true;
                    console.warn(`[bili-compaction] could not disable native compaction service method "${method}"; automatic compaction may still run alongside this plugin`);
                }
            }
        }
    };
    const patch = (agent) => {
        patchService(agent, 'compaction', {
            // Context-overflow recovery is the only path that can rescue a session
            // that is already past the model window, and it prunes oversized tool
            // results before summarizing. Suppressing it turns a recoverable
            // overflow into a raw provider 400, so that trigger always delegates.
            compactIfNeeded: (original) => async (...args) => {
                const trigger = args[1];
                if (trigger === 'context-overflow')
                    return original(...args);
                return null;
            },
            // Manual `/compact` stays redirected: two systems writing summary
            // checkpoints from one keystroke is never what the operator meant.
            compactNow: () => async () => {
                const ctor = await loadManualCompactionError(agent, ctx);
                throw disabledCompactionError(ctor, 'native compaction is disabled by bili-compaction; use the compress tool instead');
            },
        });
        // `toolResultPruner` is deliberately left untouched: it only runs when
        // compaction runs, and its prune-before-summarize pass is what lets the
        // overflow path above bring an over-window session back under the limit
        // without a model call.
    };
    return {
        patch,
        dispose() {
            for (const { target, method, original } of restores) {
                try {
                    target[method] = original;
                }
                catch {
                    // The service realm is already gone; nothing to restore.
                }
            }
            restores.length = 0;
        },
    };
}
/**
 * Warm the kernel on every step and (optionally) hand the model its nudge.
 *
 * dsh has no ephemeral message channel: anything a `pre-step` listener returns
 * is appended to the durable log by `agent-loop`, so the nudge is opt-in
 * (`injectNudge`). Left off, the same text is reachable through `acp_status`,
 * which costs one tool call and nothing in the log.
 */
function installStepHook(ctx, engine, injectNudge, getMeter, nativeGuard) {
    const listener = async (payload, next) => {
        const decision = await next();
        const agent = payload?.agent;
        const session = agent?.session;
        if (session === undefined)
            return decision;
        if (agent !== undefined)
            nativeGuard?.patch(agent);
        const measurement = getMeter()?.measure(session);
        // Only advance the kernel's "already told the model" watermark when the
        // nudge is actually delivered below; otherwise a silent pre-step would eat
        // the nudge and compression would never be suggested.
        const refreshed = engine.refresh(session, measurement, { advanceNudge: injectNudge });
        if (!injectNudge)
            return decision;
        const text = engine.nudgeText(refreshed.decision);
        if (text === null)
            return decision;
        if (typeof decision !== 'object' || decision === null)
            return decision;
        const enter = decision;
        if (enter.kind !== 'enter' || !Array.isArray(enter.messages))
            return decision;
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
        };
    };
    ctx.on('agent/pre-step', listener, { global: true });
}
export function apply(ctx, rawConfig) {
    const options = resolveOptions(rawConfig);
    const engine = new CompactionEngine(options, new SessionStore(options.storageDir));
    const nativeGuard = options.disableNativeCompaction ? installNativeCompactionGuard(ctx) : undefined;
    if (nativeGuard !== undefined) {
        ctx.effect?.(() => () => nativeGuard.dispose());
        // Patch at creation, before the first `agent/pre-step`: the preset's own
        // automatic-compaction listener may be ordered ahead of this plugin's hook,
        // and it would otherwise get one uncompacted step through.
        const onCreated = (payload) => {
            const agent = payload?.agent;
            if (agent !== undefined)
                nativeGuard.patch(agent);
        };
        ctx.on('agent/created', onCreated, { global: true });
    }
    const measureFor = (host) => {
        const meter = resolveTokenMeter(host);
        return meter === undefined ? undefined : (session) => meter.measure(session);
    };
    const install = (host, tools) => {
        const measure = measureFor(host);
        const disposers = registerTools({ register: (definition) => tools.register(definition) }, engine, {
            currentSession: () => resolveSession(host),
            ...(measure === undefined ? {} : { measure }),
        });
        const dispose = () => {
            for (const disposer of disposers)
                disposer();
        };
        host.effect?.(() => dispose);
    };
    const tools = asTools(safeGet(ctx, 'tools'));
    if (tools !== undefined) {
        install(ctx, tools);
    }
    else if (typeof ctx.inject === 'function') {
        // The tools service may not exist yet (or may come and go); cordis re-runs
        // this callback whenever it becomes available.
        ctx.inject(['tools'], (inner) => {
            const late = asTools(safeGet(inner, 'tools'));
            if (late !== undefined)
                install(inner, late);
        });
    }
    else {
        console.warn('[bili-compaction] no tools service on this context; compress/decompress/acp_status were not registered');
    }
    installStepHook(ctx, engine, options.injectNudge, () => resolveTokenMeter(ctx), nativeGuard);
}
//# sourceMappingURL=index.js.map