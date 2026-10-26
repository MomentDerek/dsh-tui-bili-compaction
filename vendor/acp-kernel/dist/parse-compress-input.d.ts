import type { CompressRangeSpec } from "./types.js";
export type CompressParseKind = "ok" | "empty-input" | "not-object" | "missing-content" | "content-not-array" | "malformed-json" | "truncated" | "no-valid-ranges";
export interface CompressParseDiagnostics {
    /** true only when at least one range was recovered. */
    ok: boolean;
    /** Why the input parsed the way it did. */
    kind: CompressParseKind;
    /** True when the winning parse came from single→double quote repair. */
    quoteSalvage?: boolean;
    /** True when a flat single-range call carried its summary text in the
     * `content` STRING alongside top-level refs ({content, startId, endId})
     * — the two schema-advertised shapes merged — and was recovered. */
    flatSummarySalvage?: boolean;
    /** True when a non-array `content` value (single entry object or nested
     *  `ranges` array) was recovered into the canonical array form (#470). */
    contentSalvage?: boolean;
    /** First 800 chars of the raw string input (string inputs only). */
    rawPrefix?: string;
    /** Raw string input length (string inputs only). */
    length?: number;
    /** Top-level keys of the parsed object — catches `content` vs `ranges` drift. */
    keys?: string[];
    /** Entries dropped because they were not valid ranges. */
    invalidItems: number;
    /** One human-readable reason per dropped entry (index-prefixed). */
    invalidReasons?: string[];
}
export interface ParsedCompressInput {
    ranges: CompressRangeSpec[];
    diagnostics: CompressParseDiagnostics;
}
/**
 * Parse compress tool arguments in any host wire shape.
 *
 * Accepts a decoded object, a JSON string (possibly fenced, trailing-comma,
 * raw-newline, or double-stringified), or a truncated JSON prefix (salvage
 * mode). Invalid entries are skipped, never fatal; the reason is in
 * `diagnostics.kind`.
 */
export declare function parseCompressArgs(input: unknown, opts?: {
    callId?: string;
}): ParsedCompressInput;
/** Display/retrieval label for line-form entries without an explicit topic:
 *  the summary's first markdown heading, else its first non-empty line,
 *  truncated. The topic is metadata (panels, T2 source headers, search) —
 *  never load-bearing for correctness. */
export declare function deriveTopicFromSummary(summary: string): string | undefined;
//# sourceMappingURL=parse-compress-input.d.ts.map