/**
 * Tool-result valuator + deterministic compression ("crush") channel (#354):
 * the two-tier absorb gate owned by the kernel. Tier 1: mechanical size
 * reduction of eligible oversized tool results via registered crush plugins;
 * tier 2: model distillation (the existing `[ACP absorb]` prompt path) only
 * when a result is still over threshold after crushing. Pure function of
 * (payload, config) — identical bytes on every turn a result is re-sent
 * (prefix-cache stable); view-only like the absorb prompt, no kernel state
 * is mutated.
 *
 * Plugin contract (CrushPluginDef.run): pure & deterministic, input never
 * mutated, fail-open on any anomaly, sub-minimum-size inputs untouched. The
 * kernel enforces what plugins must not each own: dispatch guards (JSON /
 * source / log payloads never reach a strategy for another kind), the
 * minReduction floor, and — for lossy log output — that every ERROR/FAIL line
 * of the input survives in the output verbatim, else the result is rejected
 * and the payload passes through unchanged.
 *
 * Default strategies (dispatched by content sniffing):
 *  - json-fold: field-variance folding (concept adapted from headroom
 *    SmartCrusher, headroomlabs-ai/headroom, Apache-2.0; implementation
 *    original TS). LOSSLESS BY CONSTRUCTION. Annotation vocabulary (reserved
 *    key `__acp_crush`):
 *      {"__acp_crush":"rows","rows":N,"const":{k:v,...},"items":[...]}
 *        array of N rows; every row = `const` merged with its `items` entry
 *        (same order); `items` omitted iff no row has a non-constant field.
 *      {"__acp_crush":"identical-run","count":N,"item":X}
 *        N consecutive identical elements X.
 *    Payloads legitimately containing a `__acp_crush` key cannot be told apart
 *    from crushed output — disable crush for them.
 *  - code-trim: structural trimmer (Python, JavaScript/TypeScript; sound for
 *    other // -comment languages). LOSSY: full-line comments, docstrings and
 *    blank-line runs are elided into one marker line (`# [acp-crush: elided N
 *    lines]` / `// [acp-crush: elided N lines]`) and NOT retained. Code lines,
 *    string literals and trailing comments stay byte-exact. A stronger AST
 *    implementation can register under kinds ["code"] to replace it.
 *  - log-select: build/test log condenser (ported from headroom LogCompressor,
 *    Apache-2.0): classifies every line (level / summary / stack-trace
 *    membership), keeps errors+fails first (within a keep budget; the kernel
 *    invariant above rejects any lossy result that drops an error line),
 *    deduped warnings, bounded stack traces (runtime frames collapsed to a
 *    marker), summary lines and ±3 context, caps the rest by score. LOSSY:
 *    noise lines are dropped, not retained. Upstream deviations: no CCR store
 *    — the omission footer carries honest counts instead of a retrieve hash;
 *    the keep budget is the fixed 100-line cap instead of headroom's adaptive
 *    Kneedle sizing (the cap only bounds output; the absorb gate and model
 *    compression already bound cost downstream). Only attempted when the
 *    payload is neither JSON-shaped nor confidently detected source code.
 *
 * Fail-open: parse errors, scanner bails (unterminated string/comment/
 * template), low-confidence language detection, plugin exceptions, or
 * reduction below the configured minimum leave the payload byte-identical.
 * Query-aware relevance selection (headroom layer b) is deliberately not
 * ported: hosts re-send tool results every turn, so the crush must stay
 * query-independent or provider prefix caches churn.
 */
import { type TokenCountFn } from "./tokenize.js";
import type { AbsorbConfig, Config, CoreMessage, CrushConfig } from "./types.js";
export declare const DEFAULT_CRUSH_CONFIG: CrushConfig;
export type CrushKind = "json" | "code" | "log";
/** Caller context handed to every plugin run (tool identity etc.). */
export interface CrushMeta {
    toolName?: string;
}
export interface CrushOutput {
    text: string;
    strategy: string;
    lossy: boolean;
    stats?: Record<string, unknown>;
}
/** Narrow synchronous compression contract. `null` = pass-through. */
export interface CrushPluginDef {
    readonly id: string;
    /** Content kinds this plugin may be dispatched on; the kernel refuses others. */
    readonly kinds: readonly CrushKind[];
    run(text: string, meta: CrushMeta): Omit<CrushOutput, "strategy"> | null;
}
export interface CrushOptions {
    minReduction?: number;
    countTokens?: TokenCountFn;
    meta?: CrushMeta;
    /** Plugins to try, in order. Default: all registered, registry order. */
    plugins?: readonly CrushPluginDef[];
}
export type CrushDecisionKind = "skip" | "crushed" | "distill";
/** Valuator decision for one tool-result payload. */
export interface CrushEvaluation {
    kind: CrushDecisionKind;
    /** Final text: original for skip, crushed otherwise. */
    text: string;
    rawTokens: number;
    newTokens?: number;
    reduction?: number;
    strategy?: string;
    lossy?: boolean;
}
export declare function classifyCrushText(text: string): CrushKind;
/** Single-call entry shared by the arrival path (processTurn crush node) and
 *  the future retrieve path (#1097): classify, dispatch in order to the first
 *  kind-matched plugin that produces an accepted result. `null` = pass-through. */
export declare function crushText(text: string, options?: CrushOptions): CrushOutput | null;
export declare function crushJson(text: string): string | null;
export declare function crushCode(text: string): string | null;
export declare function crushLog(text: string): string | null;
export declare const jsonFoldPlugin: CrushPluginDef;
export declare const codeTrimPlugin: CrushPluginDef;
export declare const logSelectPlugin: CrushPluginDef;
export declare function registerCrushPlugin(def: CrushPluginDef): void;
export declare function unregisterCrushPlugin(id: string): void;
export declare function listCrushPlugins(): Array<Pick<CrushPluginDef, "id" | "kinds">>;
/** Test support: restore the built-in set exactly, in built-in order. */
export declare function resetCrushPlugins(): void;
export declare function resolveCrushConfig(config: Config): CrushConfig;
export interface EvaluateCrushInput {
    text: string;
    absorb: AbsorbConfig;
    crush: CrushConfig;
    /** Current context token count (context-pressure signal). */
    tokenCount: number;
    modelContextLimit: number;
    meta?: CrushMeta;
    countTokens?: TokenCountFn;
}
/** Two-tier gate decision for one tool-result payload. Pure: same input ⇒
 *  same bytes. `skip` = under the absorb gates; `crushed` = deterministic
 *  compression brought it under minToolTokens (no model round-trip);
 *  `distill` = still over (or uncrushable) — hand `text` to the absorb prompt
 *  path; when crushing succeeded `text` is the crushed payload. */
export declare function evaluateToolResult(input: EvaluateCrushInput): CrushEvaluation;
export interface ApplyCrushResult {
    messages: CoreMessage[];
    /** Results crushed below minToolTokens (no model round-trip). */
    crushedCount: number;
    /** Results forwarded to the absorb prompt path with crushed text. */
    distilledCount: number;
}
/** Pipeline-facing application: view-only, deterministic per turn. Runs
 *  between absorb-hide and absorb-prompt so the prompt node re-decides on
 *  post-crush sizes in the same turn (atomic two-tier gate). Returns the
 *  input array unchanged when nothing qualifies. */
export declare function applyCrushToMessages(messages: CoreMessage[], config: Config, tokenCount: number, countTokens: TokenCountFn): ApplyCrushResult;
//# sourceMappingURL=crush.d.ts.map