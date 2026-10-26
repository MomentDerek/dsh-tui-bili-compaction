import type { CoreMessage } from "./types.js";
/**
 * Atomic turn groups for compression integrity (#684).
 *
 * A turn is a reasoning run, the assistant text/tool-call burst that follows
 * it, and every tool-result paired (by toolCallId) to the burst's calls.
 * Strict-echo thinking providers (DeepSeek: "The `reasoning_content` in the
 * thinking mode must be passed back to the API") reject a rebuilt request
 * whose assistant tool-call turn survives without its reasoning, and every
 * OpenAI-wire provider rejects a result whose call is gone. Turns are
 * therefore atomic for folding: all members fold together, or none do.
 *
 * Grouping is adjacency-based, mirroring {@link adjustBoundariesForReasoningPairs}:
 * a reasoning run pairs with the assistant burst immediately following it.
 * Bursts without a preceding reasoning run still group with their sibling
 * calls and results. Messages belonging to no turn (user messages, system,
 * orphan reasoning, summaries) get no group — they carry no pairing
 * constraint. Groups are disjoint.
 *
 * @returns disjoint member-id arrays; a message appears in at most one group.
 */
export declare function computeTurnGroups(messages: CoreMessage[]): string[][];
/** Which folded ids the rebuild cannot keep folded, and how many turns and
 *  call/result pairs that covers. */
export interface IntegrityWithdrawals {
    withdrawn: Set<string>;
    splitTurnCount: number;
    splitPairCount: number;
}
/**
 * Fold-integrity gate (#684): given the ids a fold removes from the visible
 * stream, return the ids that must stay visible instead.
 *
 *   - INV1 — a kept assistant tool-call must keep its reasoning run, so a turn
 *     whose reasoning folds while a call of the same turn stays visible is
 *     withdrawn wholesale (all members stay visible).
 *   - INV2 — a tool-call and its tool-result are one exchange: a pair the fold
 *     would split is withdrawn together.
 *
 * The two invariants feed each other. Withdrawing a call for INV2 leaves a turn
 * whose reasoning still folds while its call now stays visible — exactly the
 * INV1 split — and withdrawing a turn for INV1 can strand a result whose call
 * survived outside the turn. One pass in a fixed order misses both, so the gate
 * repeats until nothing changes; a turn or pair is acted on once and reported
 * once.
 *
 * The reverse direction stays allowed (#564): reasoning and text may stay
 * visible while the call and its result fold, since that leaves a valid stream.
 */
export declare function computeIntegrityWithdrawals(messages: CoreMessage[], foldedIds: ReadonlySet<string>): IntegrityWithdrawals;
//# sourceMappingURL=turn-integrity.d.ts.map