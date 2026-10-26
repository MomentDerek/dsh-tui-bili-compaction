import type { CompressionState } from "../types.js";
/**
 * Forward-compat: merge a parsed state with a fresh one so fields added in
 * later kernel versions get sane defaults instead of `undefined`. Nested
 * groups (nudge, stats) are shallow-merged per field so older snapshots
 * keep their values while newer counters default in.
 *
 * Lifted verbatim in behavior from billion-context's proxy mergeState.
 */
export declare function mergeCompressionState(parsed: CompressionState): CompressionState;
//# sourceMappingURL=state-merge.d.ts.map