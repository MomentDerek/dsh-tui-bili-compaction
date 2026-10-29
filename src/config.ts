import type { Config } from './kernel.js'
import { defaultConfig } from './kernel.js'

/**
 * Plugin options live in the profile's plugin config; every field is optional.
 * The defaults are the standing operating policy: nudge from 20% of the
 * window, auto-fold at 40%, fold back down to 20%.
 */
export interface PluginOptions {
  /** Pin the route context window. When omitted, the engine prefers the live
   *  session's advertised window and only falls back to 1M. Set this when the
   *  route advertises a window larger than the budget you want to enforce. */
  modelContextLimit?: number
  /** Additional kernel config (tiers, nudge, truncate, ccr, ...). Merged over
   *  the plugin defaults below, which are merged over the kernel's own. */
  kernel?: Partial<Config>
  /** Disable the live preset's `compaction` service (`compactIfNeeded` /
   *  `compactNow`) so only this engine compresses. Default true. */
  disableNativeCompaction?: boolean
  /** Directory holding per-session kernel state. Default: the plugin's state
   *  dir under LOCALAPPDATA. */
  storageDir?: string
  /** Append the kernel's language-preservation rule to every summary prompt. */
  languagePreservation?: boolean
  /** Append the kernel's nudge to the durable log on every step. dsh has no
   *  ephemeral message channel, so this writes a real `user/message` event.
   *  Default true; set it to false for a silent engine driven by `acp_status`. */
  injectNudge?: boolean
  /** Automatic folding without a model call: when the measured surface passes
   *  `triggerPct` of the window, the plugin condenses the oldest visible
   *  messages into one durable checkpoint with a mechanical digest. Default
   *  enabled at 40% → 20%; folding replaces surface content, so a profile that
   *  wants to keep the raw surface can switch it off deliberately. */
  autoFold?: AutoFoldOptions
}

/** Thresholds for the model-free `autoFold` path. */
export interface AutoFoldOptions {
  enabled?: boolean
  /** Fold once the measured surface exceeds this fraction of the window. */
  triggerPct?: number
  /** Keep folding until the surface is back under this fraction. */
  targetPct?: number
}

export const DEFAULT_MODEL_CONTEXT_LIMIT = 1_000_000

/** Fold once the surface passes 40% of the window, back down to 20%. */
const DEFAULT_TRIGGER_PCT = 0.4
const DEFAULT_TARGET_PCT = 0.2

/** Nudge cadence the plugin runs on: warn from 20%, press from 40%, emergency
 *  at 50%, with a 20K-token growth floor so short turns do not re-nudge. The
 *  kernel's own defaults are 0.45 / 0.75 / 0.95 with 50K floors. */
const DEFAULT_NUDGE = {
  minContextLimitPct: 0.2,
  maxContextLimitPct: 0.4,
  emergencyThresholdPct: 0.5,
  growthFloor: 2e4,
  growthCap: 2e4,
} satisfies Partial<Config['nudge']>

export interface ResolvedOptions {
  modelContextLimit: number
  /** True when the operator pinned `modelContextLimit`; otherwise the live
   *  session's advertised `requestContext().contextWindow` may override it. */
  modelContextLimitExplicit: boolean
  kernel: Partial<Config>
  disableNativeCompaction: boolean
  storageDir: string | undefined
  languagePreservation: boolean
  injectNudge: boolean
  autoFold: Required<AutoFoldOptions>
}

function ratio(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback
}

export function resolveOptions(raw: PluginOptions | undefined): ResolvedOptions {
  const limit = raw?.modelContextLimit
  const explicitLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined
  const triggerPct = ratio(raw?.autoFold?.triggerPct, DEFAULT_TRIGGER_PCT)
  const targetPct = Math.min(ratio(raw?.autoFold?.targetPct, DEFAULT_TARGET_PCT), triggerPct)
  return {
    modelContextLimit: explicitLimit ?? DEFAULT_MODEL_CONTEXT_LIMIT,
    modelContextLimitExplicit: explicitLimit !== undefined,
    kernel: raw?.kernel ?? {},
    disableNativeCompaction: raw?.disableNativeCompaction !== false,
    storageDir: typeof raw?.storageDir === 'string' && raw.storageDir.length > 0 ? raw.storageDir : undefined,
    languagePreservation: raw?.languagePreservation === true,
    injectNudge: raw?.injectNudge !== false,
    autoFold: { enabled: raw?.autoFold?.enabled !== false, triggerPct, targetPct },
  }
}

export function buildKernelConfig(options: ResolvedOptions): Config {
  const config = defaultConfig(options.modelContextLimit, options.kernel)
  // The plugin defaults sit between the kernel's own and the profile's
  // explicit `kernel.nudge`, so any field the profile sets still wins.
  return { ...config, nudge: { ...config.nudge, ...DEFAULT_NUDGE, ...options.kernel.nudge } }
}
