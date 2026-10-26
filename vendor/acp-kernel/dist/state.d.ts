import type { CompressionBlock, CompressionState, CoreMessage } from "./types.js";
export declare function createInitialState(): CompressionState;
export declare function allocateBlockId(state: CompressionState): string;
export declare function allocateRunId(state: CompressionState): string;
export declare function blockById(state: CompressionState, blockId: string): CompressionBlock | undefined;
export declare function activeBlocks(state: CompressionState): CompressionBlock[];
export declare function coveredMessageIds(state: CompressionState): Set<string>;
/** #2663: single source of truth for "live host checkpoint carrier" (#335) —
 *  a message that renders the visible summary of a still-active block. The
 *  selector (recommend.ts) and the applier (compress.ts) must judge this with
 *  the SAME predicate or they advertise spans the apply side structurally
 *  rejects (a plain range bridging a live carrier resolves to zero foldable
 *  messages once the covering block is consumed). Stale carriers — block
 *  inactive or id unknown — are NOT live and fold like ordinary messages. */
export declare function isLiveCheckpointCarrier(message: Pick<CoreMessage, "summaryOfBlockId">, state: CompressionState): boolean;
export declare function highestActiveTier(state: CompressionState): 0 | 1 | 2 | 3;
export declare function advanceSurvival(state: CompressionState, promotionThreshold: number): void;
//# sourceMappingURL=state.d.ts.map