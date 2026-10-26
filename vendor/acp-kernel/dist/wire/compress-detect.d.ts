/**
 * Compress-call detection and replay-guard on the wire/core stream
 * (Phase K2, moved from billion-context-omp `src/wire-fold.ts`).
 *
 * Two layers:
 *  - Detection: `compressToolArgs` accepts the two call shapes that exist in
 *    the wild (direct `compress`; legacy `write` to `xd://compress`, args
 *    JSON-encoded one or two levels deep), `findCompressCalls` /
 *    `findCompressCallsCore` turn a stream tool-call into validated ranges.
 *  - Guard: when compression state is REPLAYED against a rebuilt stream
 *    (restart, mirror divergence, host re-serialization), every recorded
 *    range must prove it still covers the same content — fingerprint match
 *    (first/last piece content key), position fallback for drifted
 *    boundaries, remap for dangling m-refs.
 *
 * Pure functions over BiliMessage/CoreMessage — no host types, no I/O.
 */
import type { CoreMessage } from "../types.js";
import type { BiliMessage } from "./bili-message.js";
/** A compress call carried by a stream tool-call, normalized to validated
 *  ranges. `id` is the tool-call id (replay dedup key). */
export interface StreamCompressCall {
    id: string;
    ranges: {
        startRef: string;
        endRef: string;
        summary: string;
        topic?: string;
        summaryMaxChars?: number;
        compressCallId: string;
    }[];
}
/** Extract a compress tool's arguments from a stream toolCall. Two call
 *  shapes exist: (1) top-level — the tools are registered with
 *  loadMode:"essential" so hosts do NOT mount them as xd:// devices; the
 *  stream shows name:"compress" directly. (2) legacy xd:// — sessions
 *  recorded before that change (or hosts forcing discoverable mounting)
 *  invoked compress through the write tool with path "xd://compress" and
 *  the tool args JSON-encoded in the content field. Both shapes must replay
 *  from the stream. Returns normalized compress args (content array plus
 *  optional topic / summaryMaxChars from wherever they live). */
export declare function compressToolArgs(call: {
    name: string;
    arguments?: unknown;
}): {
    content: unknown[];
    topic?: unknown;
    summaryMaxChars?: unknown;
} | null;
/** toolCallId → toolName for every tool-call piece (protected-piece
 *  detection: compress + configured tools are never folded). */
export declare function toolCallNames(msgs: BiliMessage[]): Map<string, string>;
/** toolCallId → result text for every tool-result piece (compress result
 *  rendering inside rebuilt payloads). */
export declare function toolResultTextsCore(msgs: BiliMessage[]): Map<string, string>;
/** Compress calls carried by a core tool-call piece. Same two shapes as the
 *  AgentMessage stream (direct compress; legacy xd://compress via write),
 *  with the arguments JSON-encoded in the piece's text. */
export declare function findCompressCallsCore(msg: BiliMessage): StreamCompressCall[];
/** Content key of a core piece for span fingerprints (issue #91): role,
 *  contentType, toolName and the FIRST 4096 chars of text. The 4096 cap is
 *  deliberate: a host re-serialization that drifts only the tail (beyond
 *  char 4096, e.g. truncation of a long tool output) keeps the key intact,
 *  so the replay guard tells a benign tail drift from a genuine rewrite. */
export declare function corePieceKey(cm: CoreMessage): string;
/** Span fingerprint in content-hash space: hash the content keys of the
 *  exact first/last covered pieces. Boundary ids are pre-resolved (byRef /
 *  block lookup) — unlike the pN-space spanFingerprint there is no position
 *  parsing, ids are unique per piece. */
export declare function spanFingerprintCore(coreMessages: CoreMessage[], startId: string, endId: string): string;
/** Index-based span fingerprint (issue #91 replay fallback): hash the content
 *  keys of the pieces AT the given stream positions. The stored fp still
 *  decides keep/drop — the position is only a recovery hint for a drifted
 *  boundary whose content-hash id no longer matches, so a benign tail drift
 *  (first-4096 intact) is kept while a real rewrite mismatches. */
export declare function spanFingerprintCoreIdx(coreMessages: CoreMessage[], startIdx: number, endIdx: number): string;
/** Structural subset the boundary resolvers need from a compression block
 *  (kernel CompressionBlock satisfies this; keeps the guard usable from
 *  downstreams that carry lighter block records). */
export interface BlockLike {
    blockId: string;
    effectiveMessageIds: string[];
}
/** Resolve a range boundary to the exact id of the piece it names, in
 *  content-hash space. Message refs go through byRef; block refs resolve to
 *  the earliest (min) or latest (max) covered piece by STREAM ORDER
 *  (index in coreMessages — the hash ids carry no position). */
export declare function boundaryRawCore(ref: string, byRef: Record<string, string>, blocks: BlockLike[], coreMessages: CoreMessage[], pick: "min" | "max"): string;
/** Resolve a range boundary to its STREAM INDEX in content-hash space. byRef /
 *  block lookup first (the exact piece it names, by array order); on a missed
 *  id (a drift re-hashed the piece so its carried ref dangles) fall back to
 *  the compress-time recorded index — the position hint, issue #91. -1 =
 *  unresolvable. */
export declare function boundaryIndexCore(ref: string, byRef: Record<string, string>, blocks: BlockLike[], coreMessages: CoreMessage[], pick: "min" | "max", fallbackIdx?: number): number;
/** Structured replay-guard verdict (issue #91, rework): the position
 *  fallback recovers the STREAM INDEX of a drifted boundary, but the kernel
 *  resolves ranges by REF — so when a recorded m-ref dangles, the replay
 *  must re-apply that boundary under the CURRENT ref of the recovered piece.
 *  `remap` carries exactly that (only dangling m-refs are remapped; block
 *  refs resolve themselves inside the kernel and are never touched). */
export type ReplayRangeVerdict = {
    /** Stale: the range must be dropped (master semantics, unchanged). */
    reject?: string;
    /** Dangling m-refs recovered by position, remapped to current refs. */
    remap?: {
        startRef?: string;
        endRef?: string;
    };
    /** True when the result text carried a [pos=] pair for this range —
     *  with `reject` set it marks a RECOVERY FAILURE (always logged). */
    hint?: boolean;
    /** Diagnostics — always logged when a recovery happens. */
    recovered?: {
        pos: string;
        startIdx: number;
        endIdx: number;
    };
};
/** Current m-ref of the piece at stream index idx (inverse byRef scan).
 *  "" when the piece has no ref (protected) — the replay must fail closed
 *  rather than hand the kernel a ref it does not know. Replay-time only
 *  (replayed compress calls), so the O(refs) scan stays off the hot path. */
export declare function refOfPieceCore(coreMessages: BiliMessage[], idx: number, byRef: Record<string, string>): string;
export declare function staleRangeCore(r: {
    startRef: string;
    endRef: string;
}, rangeIndex: number, resultText: string, coreMessages: BiliMessage[], callIndex: number, byRef: Record<string, string>, blocks: BlockLike[]): ReplayRangeVerdict;
/** One fingerprint per range for the replay guard, content-hash space
 *  (mirrors rangeFingerprints for the pN space). */
export declare function rangeFingerprintsCore(ranges: Array<{
    startRef: string;
    endRef: string;
}>, coreMessages: BiliMessage[], byRef: Record<string, string>, blocks: BlockLike[]): string[];
/** One boundary-index pair per range for the replay fallback (issue #91),
 *  aligned with rangeFingerprintsCore: the stream index of each range's exact
 *  first/last covered piece at record time ("-1" pair when a boundary can't
 *  be positioned), so the replay can recover a drifted boundary by position. */
export declare function rangePositionsCore(ranges: Array<{
    startRef: string;
    endRef: string;
}>, coreMessages: CoreMessage[], byRef: Record<string, string>, blocks: BlockLike[]): string[];
//# sourceMappingURL=compress-detect.d.ts.map