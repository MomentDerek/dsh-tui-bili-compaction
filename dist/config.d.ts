import type { Config } from './kernel.js';
/**
 * Plugin options live in the profile's plugin config; every field is optional
 * and falls back to a value that is safe for a 1M-token model.
 */
export interface PluginOptions {
    /** Pin the route context window. When omitted, the engine prefers the live
     *  session's advertised window and only falls back to 1M. Set this when the
     *  route advertises a window larger than the budget you want to enforce. */
    modelContextLimit?: number;
    /** Additional kernel config (tiers, nudge, truncate, ccr, ...). */
    kernel?: Partial<Config>;
    /** Disable the live preset's `compaction` service (`compactIfNeeded` /
     *  `compactNow`) so only this engine compresses. Default true. */
    disableNativeCompaction?: boolean;
    /** Directory holding per-session kernel state. Default: the plugin's state
     *  dir under LOCALAPPDATA. */
    storageDir?: string;
    /** Append the kernel's language-preservation rule to every summary prompt. */
    languagePreservation?: boolean;
    /** Append the kernel's nudge to the durable log on every step. dsh has no
     *  ephemeral message channel, so this writes a real `user/message` event and
     *  is off by default; the same text is available through `acp_status`. */
    injectNudge?: boolean;
}
export declare const DEFAULT_MODEL_CONTEXT_LIMIT = 1000000;
export interface ResolvedOptions {
    modelContextLimit: number;
    /** True when the operator pinned `modelContextLimit`; otherwise the live
     *  session's advertised `requestContext().contextWindow` may override it. */
    modelContextLimitExplicit: boolean;
    kernel: Partial<Config>;
    disableNativeCompaction: boolean;
    storageDir: string | undefined;
    languagePreservation: boolean;
    injectNudge: boolean;
}
export declare function resolveOptions(raw: PluginOptions | undefined): ResolvedOptions;
export declare function buildKernelConfig(options: ResolvedOptions): Config;
//# sourceMappingURL=config.d.ts.map