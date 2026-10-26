import type { BlockSpan, CompressionBlock, CompressionState, MessageRefMap } from "./types.js";
/** Resolve a block's current ref span. Prefers the stored startRef/endRef
 *  (assigned at creation from the requested range); falls back to the
 *  min/max of effectiveMessageIds' refs for blocks persisted before those
 *  fields existed. Stored refs are only trusted when both are message refs —
 *  block-boundary specs (startId "bN") are stored verbatim on tier-distilled
 *  blocks and must not render as spans. Returns null when nothing resolves. */
export declare function resolveBlockSpan(block: CompressionBlock, byRaw: MessageRefMap["byRaw"]): {
    startRef: string;
    endRef: string;
} | null;
export declare function activeBlockSpans(state: CompressionState): BlockSpan[];
/** Format newly created blocks for tool-result display, e.g.
 *  `blocks: b3=m00044–m00097, b4=m00103–m00123`. Adapters append this to their
 *  compress result line so the model's block ledger comes from the kernel
 *  instead of being inferred from its own arguments (#376). Empty string when
 *  no blocks were created. */
export declare function formatCreatedBlocks(state: CompressionState, newBlocks: CompressionBlock[]): string;
//# sourceMappingURL=block-map.d.ts.map