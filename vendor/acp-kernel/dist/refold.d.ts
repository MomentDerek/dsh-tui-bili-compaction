import type { CompressionBlock, CompressionState } from "./types.js";
export type RefoldDecision = {
    kind: "refold";
    blocks: CompressionBlock[];
} | {
    kind: "blocked";
    reasons: string[];
};
/** Ref-number span [lo, hi] of a spec boundary: m-refs contribute their
 * number, block refs expand through resolveBlockSpan. */
export declare function requestedRefoldSpan(state: CompressionState, spec: {
    startRef: string;
    endRef: string;
}): {
    lo: number;
    hi: number;
} | null;
/** #398 refold-in-place gate for a consumed range: every active block inside
 * the requested span must be restored-inline (with a fully restored ancestor
 * chain) and at least one must be — then it updates those in place instead of
 * rejecting as "already compressed". Otherwise the blocking blocks are listed
 * by id ("blocked by bN (not restored)" / "partially covered bN"). */
export declare function evaluateRefold(state: CompressionState, spec: {
    startRef: string;
    endRef: string;
}): RefoldDecision;
//# sourceMappingURL=refold.d.ts.map