import type { CompressionState, CoreMessage } from "./types.js";
export declare const SUMMARY_HEADER = "[Compressed conversation section]";
/**
 * The transient visible id of an active block's rendered summary message.
 * This is a VIEW-ONLY representation: it must never be persisted into
 * `effectiveMessageIds`/`directMessageIds` (the durable coverage is the
 * block's raw message ids).
 */
export declare function summaryMessageId(blockId: string): string;
export declare function isSummaryMessageId(id: string): boolean;
/**
 * Base id of a message id: everything before the first `#`. Sub-id
 * projections (`base#callId`, `base#r0`, …) are alternate renderings of the
 * same original message, so coverage is decided per original message — id
 * comparisons normalize to the base (issue #231).
 */
export declare function baseIdOf(id: string): string;
/**
 * True when `id` falls under any covered original message, regardless of
 * which projection form the block recorded and which the current view emits.
 * `coveredBases` must be the set of `baseIdOf(c)` over the covered ids,
 * built once per pass (O(1) per message instead of a scan). The exact
 * membership test is subsumed: a covered id's own base is in the set.
 */
export declare function isCovered(id: string, coveredBases: Set<string>): boolean;
/**
 * #4316 layer 3: seq-interval coverage claims. A block that recorded an exact
 * ledger interval (startSeq/endSeq) covers ANY message carrying a ledgerSeq
 * stamp inside that interval — id churn (model switch / re-stamp / re-encode
 * re-mints every content-hash id) cannot invalidate the positional claim.
 * Blocks without bounds contribute nothing; messages without stamps are
 * decided by the id path alone. Both paths run in parallel (union): the id
 * path stays byte-identical for unstamped traffic.
 */
export declare function coveredSeqIntervals(state: CompressionState): Array<{
    start: number;
    end: number;
}>;
/** True when `seq` falls inside any active block's exact interval claim. */
export declare function isCoveredBySeq(seq: number | undefined, intervals: Array<{
    start: number;
    end: number;
}>): boolean;
/**
 * True when a message is a rendered block summary (the exact shape prune
 * emits). The id prefix alone is not sufficient — a host-authored message
 * that happens to carry a reserved id must not be treated as a rendered
 * summary (it would be silently dropped from ranges or deleted by rebuild).
 */
export declare function isRenderedSummaryMessage(message: Pick<CoreMessage, "id" | "role" | "contentType">): boolean;
export interface PruneOptions {
    injectSummaries?: boolean;
    /**
     * Chronological head anchoring for views with NO provider prefix cache at
     * stake (session handoff/restore docs). Default (false) is the pin-safe
     * placement: an anchor whose ids are absent from the input parks before
     * the newest user message (never at the tail, #3640), and no summary may
     * precede the first user message — the pin is the provider prefix-cache
     * head (#2733).
     */
    headSummaryAnchors?: boolean;
    /**
     * Names that count as a `compress` call for the pending-call exemption in
     * orphan stripping (same predicate family as Config.isCompressTool). Unset =
     * bare-name only, byte-identical to before; without it an MCP-form compress
     * call still awaiting its result is deleted while its bare-name twin survives.
     */
    isCompressTool?: (toolName: string) => boolean;
}
export declare function prune(messages: CoreMessage[], state: CompressionState, options?: PruneOptions): CoreMessage[];
//# sourceMappingURL=prune.d.ts.map