import type { Config } from './kernel.js'
import { defaultConfig } from './kernel.js'

/**
 * Plugin options live in the profile's plugin config; every field is optional
 * and falls back to a value that is safe for a 1M-token model.
 */
export interface PluginOptions {
  /** Route context window. dsh does not hand a plugin the resolved model
   *  metadata, so the operator states it once here. */
  modelContextLimit?: number
  /** Additional kernel config (tiers, nudge, truncate, ccr, ...). */
  kernel?: Partial<Config>
  /** Fold `@deepseek-ai/dsh-compaction-basic` / `dsh-command-compact` out of
   *  the composed config so only this engine compresses. Default true. */
  disableNativeCompaction?: boolean
  /** Directory holding per-session kernel state. Default: the plugin's state
   *  dir under LOCALAPPDATA. */
  storageDir?: string
  /** Append the kernel's language-preservation rule to every summary prompt. */
  languagePreservation?: boolean
  /** Append the kernel's nudge to the durable log on every step. dsh has no
   *  ephemeral message channel, so this writes a real `user/message` event and
   *  is off by default; the same text is available through `acp_status`. */
  injectNudge?: boolean
}

export const DEFAULT_MODEL_CONTEXT_LIMIT = 1_000_000

export interface ResolvedOptions {
  modelContextLimit: number
  kernel: Partial<Config>
  disableNativeCompaction: boolean
  storageDir: string | undefined
  languagePreservation: boolean
  injectNudge: boolean
}

export function resolveOptions(raw: PluginOptions | undefined): ResolvedOptions {
  const limit = raw?.modelContextLimit
  return {
    modelContextLimit: typeof limit === 'number' && limit > 0 ? limit : DEFAULT_MODEL_CONTEXT_LIMIT,
    kernel: raw?.kernel ?? {},
    disableNativeCompaction: raw?.disableNativeCompaction !== false,
    storageDir: typeof raw?.storageDir === 'string' && raw.storageDir.length > 0 ? raw.storageDir : undefined,
    languagePreservation: raw?.languagePreservation === true,
    injectNudge: raw?.injectNudge === true,
  }
}

export function buildKernelConfig(options: ResolvedOptions): Config {
  return defaultConfig(options.modelContextLimit, options.kernel)
}
