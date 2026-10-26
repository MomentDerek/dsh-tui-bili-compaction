import { type LatestProtected } from "./protected.js";
import type { AbsorbConfig, Config, CompressionState, CoreMessage } from "./types.js";
/**
 * Instant tool-result absorption ("absorb") — the middle layer between
 * "let output pile up until a 50K-token nudge fires" and "the model can't
 * work at a 10K window". When enabled, the kernel appends a FORCED prompt to
 * every eligible large tool result demanding the model immediately distill it
 * via absorb({ ref, summary }); the original tool-call + tool-result pair is
 * then hidden from all subsequent turns, leaving the model's absorb call as
 * the durable record. Absorb calls are ordinary messages: the regular
 * compression pipeline can fold them later (orthogonal by design).
 */
export declare const ABSORB_PROMPT_MARKER = "[ACP absorb]";
export declare const DEFAULT_ABSORB_CONFIG: AbsorbConfig;
export declare function resolveAbsorbConfig(config: Config): AbsorbConfig;
export declare function buildAbsorbPrompt(ref: string, tokens: number, toolName?: string): string;
/** System-prompt section for adapters with absorb enabled. */
export declare function buildAbsorbSystemPrompt(toolName?: string): string;
/** True when a tool-result message is in scope for absorption prompting:
 *  a tool-result of a non-ACP, non-excluded, non-protected tool. */
export declare function isAbsorbCandidate(msg: CoreMessage, config: Config, latest?: LatestProtected, protectedCallIds?: Set<string>, failedCompressCallIds?: Set<string>): boolean;
/** Drop tool-call + tool-result pairs recorded in state.absorbed. Both halves
 *  go together so the provider-visible conversation stays structurally valid;
 *  prune's orphan stripping cleans up any straddling leftovers. */
export declare function hideAbsorbedMessages(messages: CoreMessage[], state: CompressionState): CoreMessage[];
export interface AppendAbsorbPromptsResult {
    messages: CoreMessage[];
    promptedCount: number;
}
/** Append the forced absorb prompt to every eligible, un-absorbed, large
 *  tool result in the visible view. Per-turn view-only text (never persisted
 *  by the kernel): the prompt re-appears each turn until the model absorbs,
 *  and disappears once the pair is hidden by hideAbsorbedMessages. */
export declare function appendAbsorbPrompts(messages: CoreMessage[], state: CompressionState, config: Config, tokenCount: number, countTokens: (text: string) => number): AppendAbsorbPromptsResult;
export interface ParsedAbsorb {
    ref: string;
    summary: string;
    absorbCallId?: string;
}
/** Lenient parse of an absorb tool-call argument object. Accepts `ref`
 *  spellings ref/messageId/of and summary spellings summary/content, plus a
 *  JSON-encoded string payload (stringifying providers). */
export declare function parseAbsorbInput(input: unknown, callId?: string, onWarn?: (message: string) => void): ParsedAbsorb | null;
export interface AbsorbInput {
    ref: string;
    summary: string;
    absorbCallId?: string;
    messages: CoreMessage[];
    state: CompressionState;
    config: Config;
    countTokens?: (text: string) => number;
}
export interface AbsorbOutcome {
    state: CompressionState;
    ok: boolean;
    resultText: string;
}
/** Apply a model-issued absorb call: validate the target tool-result, record
 *  the absorption in state, and report. The pair is hidden on the NEXT
 *  processTurn (hideAbsorbedMessages), never mid-turn. */
export declare function applyAbsorb(input: AbsorbInput): AbsorbOutcome;
//# sourceMappingURL=absorb.d.ts.map