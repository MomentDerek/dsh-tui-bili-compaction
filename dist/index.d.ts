import type { PluginOptions } from './config.js';
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
export declare const name = "bili-compaction";
export declare const inject: readonly string[];
/**
 * Legacy helper for synthesised plugin trees.
 *
 * Do not use this for dsh-tui: `internal/config` is dispatched with a single
 * loader entry's own config, and bundled presets are mounted as `PresetTree`s
 * outside the host loader. Keeping the helper lets callers that already own a
 * composed tree reuse the rewrite, but the live plugin disables native
 * compaction through `installNativeCompactionGuard` instead.
 */
export declare function stripNativeCompaction(config: unknown): {
    config: unknown;
    changed: number;
};
type Listener = (...args: never[]) => unknown;
export interface PluginContext {
    /** Loader base URL, used as a module-resolution anchor for harness packages. */
    readonly baseUrl?: string | URL;
    on(event: string, listener: Listener, options?: {
        global?: boolean;
    }): () => void;
    get?(name: string): unknown;
    inject?(deps: readonly string[], callback: (ctx: PluginContext) => void): () => void;
    effect?(callback: () => void | (() => void)): void;
}
export declare function apply(ctx: PluginContext, rawConfig?: PluginOptions): void;
export {};
//# sourceMappingURL=index.d.ts.map