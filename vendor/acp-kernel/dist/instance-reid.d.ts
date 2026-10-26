import type { CompressionState, CoreMessage } from "./types.js";
/**
 * Re-mint live messages whose id collides with an already-FOLDED copy of the same
 * content (billion-context #1476), WITHOUT un-covering the folded originals' own
 * resends (#462). Runs as the FIRST pipeline node, before assign-refs and prune,
 * so the re-minted id is what gets ref'd and what prune sees.
 *
 * Two byte-identical shapes carry an exact-covered id and must be told apart:
 *
 * - the folded original's ECHO: stateless hosts resend the full raw history
 *   every turn, so the original re-derives exactly the covered bare id. It was
 *   present in the previous pass's inbound (`state.lastPassIds`) and must KEEP
 *   its id — prune then drops it (it is already summarized) and the first-user
 *   pin keeps a stable ref. Renumbering it (#459) minted a fresh ref and, worse,
 *   made it escape prune's covered check (baseIdOf strips only "#tail", not
 *   "_n"), so folded content rejoined the wire beside its summary every turn.
 * - a genuinely NEW identical instance: absent from the previous pass, present
 *   now. Renumber it to the first "_k" no folded copy claims so assign-refs
 *   mints a distinct ref and prune keeps it (#1476's starvation fix).
 *
 * Ids that are not exactly covered (converter-numbered "_1" second-occurrence
 * forms of a covered root, non-h_ ids, roots without a covered copy) keep the
 * converter's numbering untouched — renumbering those would only churn the
 * prefix cache.
 *
 * INACTIVE blocks (#2695): their covered ids join the dodge set, because a
 * genuinely new instance landing on a dead block's number resurrects the
 * block in sync ("some covered id present") and its summary carrier starts
 * rendering — for content the instance was never part of. Renumbering
 * against a dead block is gated by cluster-root continuity: only when some
 * sibling of the same root was live last pass (the arriving instance is a
 * NEW extension of a continuing cluster). A block that is inactive at
 * pipeline start cannot itself have any covered id in `prior` (sync would
 * have kept it alive otherwise), so "inactive-covered collision + sibling
 * in prior" is exactly the new-extension-onto-dead-block shape. A
 * whole-root arrival that is new to `prior` — a client rewinding to a
 * checkpoint that still holds the folded originals — keeps the converter's
 * ids and the block legitimately resurrects (carrier + prune, the #462
 * economy restored).
 */
export declare function remintCoveredLiveIds(messages: CoreMessage[], state: CompressionState): CoreMessage[];
//# sourceMappingURL=instance-reid.d.ts.map