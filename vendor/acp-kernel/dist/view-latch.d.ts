import type { CompressionState } from "./types.js";
import type { NodeIO, PipelineNode, PipelineContext } from "./pipeline.js";
/** Stash the post-prune, pre-transform view (#3939 ⑤). The view-latch node
 *  replays latched bytes from this array — the transform nodes have already
 *  dropped or rewritten their targets by the time the latch runs, so the
 *  source-of-truth resent bytes live here. */
export declare const preTransformSnapshotNode: PipelineNode;
/** Fold-gated view latch (#3939 ⑤/#3805): replay post-transform bytes
 *  verbatim on quiet turns; refresh latches only at fold boundaries. Runs
 *  after every opt-in transform node (ccr-store, absorb-hide, crush,
 *  absorb-prompt, filter) and after hide-compress-calls (its own #3784 fold
 *  gate stays authoritative — the latch only records its output), before
 *  recommend/nudge/emergency-truncate/render so downstream nodes judge the
 *  same view the model actually sees. */
export declare const viewLatchNode: PipelineNode;
/** Transform-relevant config slices — a change here is a user action
 *  boundary (①): the latch releases so enable/disable applies immediately
 *  instead of waiting for a fold. tokenCount is deliberately NOT included
 *  (pressure fluctuation is what the latch exists to gate). */
export declare function viewLatchConfigDigest(ctx: PipelineContext): string;
export declare function applyViewLatch(io: NodeIO, ctx?: PipelineContext): NodeIO;
/** #3939 ⑤: a successful fold rewrote history — the latch refresh rides it. */
export declare function resetViewLatches(state: CompressionState): CompressionState;
//# sourceMappingURL=view-latch.d.ts.map