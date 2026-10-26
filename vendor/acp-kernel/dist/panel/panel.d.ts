import type { CompressionState, NudgeDecision } from "../types.js";
import { type CacheUsageSample } from "./cache.js";
export interface StatusPanelInput {
    /** Adapter identifier for the header, e.g. "billion-context-omp@0.1.6".
     *  Omit to hide the version line. */
    version?: string;
    /** Host session accounting — the SAME number the host footer displays.
     *  It includes compressed originals (summaries stay in the window), so it
     *  shrinks slower than the sent view when compression prunes the
     *  per-request projection. */
    tokenCount: number;
    /** Measured token count of the host system prompt (host-specific to
     *  obtain; the kernel breakdown does not see it). */
    systemPromptTokens: number;
    /** Kernel state (blocks drive the Blocks section). */
    state: CompressionState;
    /** The nudge decision from core.processTurn for this turn, if any. The
     *  panel applies the viability filter to compressibleRanges itself. */
    nudge: NudgeDecision | undefined;
    /** Configured model context window, in tokens. */
    modelContextLimit: number;
    /** Estimate of the FULL (unpruned) core-message projection, computed
     *  with the SAME countTokens the core uses (kernel default = CJK-aware
     *  defaultCountTokens) — the same estimation scale as the kernel
     *  breakdown. When provided, the panel derives `Session-only` on that
     *  scale (unpruned − sent). Without it the line is omitted: subtracting
     *  the host's provider-scale number from an estimate-scale number
     *  invents a third, meaningless scale (issue #18 "看板统计的和拆分的有差异"). */
    unprunedTokens?: number;
    /** One-line human-readable storage-mode label (e.g. "storage: full
     *  (unified-first reads, dual-write)"). Pre-rendered by the host from the
     *  effective mode — the kernel never guesses. Omit to hide the line. */
    storage?: string;
    /** Per-request prompt-cache usage (from assistant messages' provider-
     *  reported `usage`). Requests without cache reporting are excluded by
     *  cacheHitStats; when no counted request remains, the section is
     *  omitted entirely. Omit the field to hide the section. */
    cacheUsages?: ReadonlyArray<CacheUsageSample>;
    /** Token formatter override (defaults to formatCompactTokens). */
    fmtTokens?: (n: number) => string;
    /** Block ids whose summaries were written by an out-of-band executor
     *  (e.g. the host's external summary service) rather than the model
     *  itself. Purely cosmetic: the panel marks these lines with "⚡ext".
     *  Omit to render without markers. */
    externalBlockIds?: ReadonlySet<string>;
}
/** Render the /acp status panel. Three token numbers, each labeled with
 *  its own scale, never mixed in arithmetic:
 *  - Session accounting (host footer scale): the host's reported context
 *    size INCLUDING compressed originals (summaries stay in the window), so
 *    it shrinks slower than the sent view when compression prunes the
 *    per-request projection.
 *  - Sent view (estimated, kernel countTokens scale): what actually
 *    reaches the LLM after compression (kernel's classification over the
 *    pruned projection + measured system prompt). This is the number
 *    compression controls.
 *  - Session-only (estimated, kernel countTokens scale): unpruned
 *    projection − sent view; the compressed originals pruned from every
 *    request.
 *  Subtracting the host number from an estimate produced numbers that
 *  reconciled with neither scale ("Framework 390K", "session-only 29k vs
 *  112k compressed") — that is what issue #18 reported. */
export declare function buildStatusPanel(input: StatusPanelInput): string;
//# sourceMappingURL=panel.d.ts.map