/**
 * Recommendation engine — compression protection + recommendation.
 *
 * Clean-room reimplementation of the recommendation algorithm (MIT, ours).
 * These pure functions answer two questions every turn:
 *
 *  1. **Protection** — which messages must NOT be compressed? (protected tools,
 *     recent messages, recent tokens)
 *  2. **Recommendation** — which remaining ranges are actually WORTH compressing?
 *     (growth-aware threshold; suppress nudges when ranges are too small)
 *
 * Called by the `recommend` pipeline node. No side effects, no state mutation.
 */
import type { CompressibleRange, Config, ContextRanges, CoreMessage } from "./types.js";
import type { CompressionState } from "./types.js";
/**
 * Compute the set of protected message refs (mNNNNN) that form the
 * "soft-protected zone" at the tail of the conversation.
 *
 * Combines three rules:
 *   1. Last N messages (`config.preserveRecentMessages`)
 *   2. Last N tokens expanding backward (`config.preserveRecentTokens`)
 *   3. Last visible user message (couples to Rule 1)
 *
 * Then closes the tool-pair gap (#2886): if either half of a (tool-call,
 * tool-result) pair is protected, both are. Without this, `neverPreserveRecentTools`
 * excludes list-matching results from `visible` while their paired call stays
 * protectable, so the zone can hold the call but not its result — the advisory
 * carve keeps the call visible and folds the result, stranding an orphan
 * function_call that strict Responses validators reject (HTTP 400).
 *
 * Only considers visible, non-synthetic, non-pruned messages that have refs.
 */
export declare function computeProtectedRefs(messages: CoreMessage[], state: CompressionState, config: Config, countTokens?: (text: string) => number): Set<string>;
/**
 * Build compressible and protected range groups from the message list.
 *
 * Messages are classified into:
 *   - **compressible**: normal messages outside the protected zone
 *   - **protected**: messages from protected tools (e.g., skill, task)
 *   - **skipped**: covered by blocks, synthetic, or in the protected zone
 *
 * Compressible messages are grouped into contiguous ranges. The protected
 * zone (from `computeProtectedRefs`) splits groups — the unprotected head
 * survives as its own range.
 */
export declare function buildCompressibleRanges(messages: CoreMessage[], state: CompressionState, config: Config, protectedZoneRefs?: Set<string>, countTokens?: (text: string) => number, 
/** #2663: the array class the fold gate judges at apply time (the full
 *  resent log — compress.ts passes input.messages). Turn grouping and
 *  call/result pairing are array-dependent, so integrity withdrawal must be
 *  computed on it; screening on a pruned view withdraws different messages
 *  than apply does. Defaults to `messages` for direct callers. */
integritySource?: CoreMessage[]): ContextRanges;
/** Merge adjacent ranges into batches that clear `minChars` of REAL text —
 *  the same accounting `applyCompression` uses — so a recommended range is
 *  never below the threshold the kernel would atomically reject. Batching by
 *  token estimates (tokens*4) instead broke whenever the host injected a
 *  tokenizer where tokens != chars/4 (CJK-aware estimators are ~1:1, so
 *  tokens*4 overestimated size ~4x and nudge recommended ranges the apply
 *  side then refused). Invariant: EVERY returned batch alone clears
 *  `minChars`. A sub-threshold tail is folded into the preceding batch
 *  (overshoot allowed); if no batch precedes it, nothing is emitted — the
 *  whole remainder is below the gate, so no selection of it can pass and
 *  offering it only yields guaranteed-rejected calls (billion-context #847). */
export declare function mergeRangesToThreshold(ranges: CompressibleRange[], minChars: number): CompressibleRange[];
/**
 * #3236: re-screen each merged recommended unit through the SAME judgment
 * applySingleRange executes (projectUnit, unit-projection.ts). A unit that
 * would be rejected wholesale — protected-zone-only span, turn/pair split, or
 * nothing new to fold — is demoted to a gap instead of advertised. Without
 * this, global integrity screening passes turns whose partners sit in ANOTHER
 * advertised unit, and every submission of such a range throws "Range would
 * split N turn(s)" — a permanent advertise/reject loop observed in production
 * (billion-context#3236). No re-merge after filtering: re-merging could
 * resurrect a doomed unit under different groupings and oscillate; a dropped
 * unit simply stops being offered until the geometry changes.
 */
export declare function screenRecommendedUnits(units: CompressibleRange[], source: CoreMessage[], state: CompressionState, config: Config, protectedRefs: Set<string>): CompressibleRange[];
//# sourceMappingURL=recommend.d.ts.map