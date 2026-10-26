import type { CompressionState, CoreMessage } from "./types.js";
export interface HideConsumedResult {
    messages: CoreMessage[];
    hidden: number;
    /** Padded refs of ALL currently-hidden orphan compress call/result messages
     *  (the persistent swept set, not just this pass). Consumed by boundary
     *  resolution to snap a range endpoint onto a hidden-but-intact orphan (#396). */
    hiddenOrphanRefs: string[];
    /** Orphan call ids newly swept by THIS pass (only when a fold was pending);
     *  the node unions these into state.sweptOrphanCallIds. Empty on quiet turns. */
    newlySweptCallIds: string[];
}
export declare function refNum(ref: string | undefined): number | null;
export declare function hideConsumedCompressCalls(state: CompressionState, messages: CoreMessage[], isCompressTool?: (toolName: string) => boolean): HideConsumedResult;
//# sourceMappingURL=hide-consumed.d.ts.map