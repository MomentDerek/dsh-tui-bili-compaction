import type { CcrConfig, Config, CompressionState, CoreMessage } from "./types.js";
import type { MessageContentStore, StoredEntry } from "./content-store.js";
import type { PipelineNode } from "./pipeline.js";
/**
 * CCR — content-cached retrieval (issue #352 / billion-context#1097).
 *
 * Lossless alternative to absorb's lossy distillation: oversized tool results
 * are stored once at arrival in the per-session MessageContentStore, and the
 * visible copy is replaced with a deterministic placeholder carrying enough
 * signal (kind, size, command/head preview, ref) to judge relevance without
 * retrieving. The model pulls the original back via the retrieve tool; the
 * original rides back IN THE TOOL RESULT ITSELF — plain tool output, the
 * lowest trust tier, exactly where the content came from (no host-synthesized
 * system/user message channel exists). Originals at or above the inline
 * threshold are exported to a host-managed file (an effect the host writes;
 * the kernel performs no I/O) and returned as a pointer the model pages
 * through with its own file-read tool.
 *
 * Replace-once-at-arrival: after the first replacement the visible bytes
 * never change again → prefix-cache stable. The node enforces this even when
 * a host re-sends the original raw (raw retransmission): a stored ref meeting
 * its raw bytes again gets the arrival-time placeholder re-projected instead
 * of leaking the raw payload back onto the wire (#1460).
 */
export declare const RETRIEVE_TOOL_NAME = "acp_retrieve";
/** Default inline threshold for applyRetrieve when the caller passes no
 *  inlineTokenLimit: originals at or above this many tokens are exported to a
 *  file (when the host provides an export dir) instead of inlined into the
 *  tool result, so retrieval never re-inflates the conversation by more than
 *  the pointer. Mirrors the arrival-time store threshold. */
export declare const RETRIEVE_INLINE_TOKENS_DEFAULT = 4000;
export declare const DEFAULT_CCR_CONFIG: CcrConfig;
export declare function resolveCcrConfig(config: Config): CcrConfig;
/** Marker embedded in every placeholder. Exclusion signal for absorb
 *  (ID-reference wins over distill); recognition is via the STRICT parser
 *  below, never a substring scan (billion-context#1456). */
export declare const STORED_PLACEHOLDER_MARKER = "[acp-stored";
/** Reserved id prefix for ephemeral retrieval injections (mirrors
 *  acp_summary_): no ref is ever assigned, fold-space collection skips them. */
export declare const RETRIEVED_ID_PREFIX = "acp_retrieved_";
export declare function classifyKind(toolName?: string): string;
/** Collapse whitespace to single spaces and cap length. Deterministic — the
 *  preview is baked into the placeholder at arrival and must be byte-stable. */
export declare function normalizeHead(text: string, maxChars: number): string;
/** Best-effort extraction of the call's subject (command/path/query) from the
 *  paired tool-call args JSON. Returns undefined when args are not JSON or no
 *  known field holds a short string — the head preview covers that case. */
export declare function extractCommand(toolCallText: string | undefined, maxChars: number): string | undefined;
export interface StoredPlaceholderInput {
    ref: string;
    kind: string;
    tokens: number;
    head: string;
    command?: string;
    retrieveToolName: string;
}
/** Deterministic two-line placeholder. No timestamps, no randomness — the
 *  same inputs always produce identical bytes (prefix-cache friendly). */
export declare function buildStoredPlaceholder(input: StoredPlaceholderInput): string;
export declare function stripLeadingTag(text: string): string;
/** Parsed canonical CCR placeholder (whole-body shape of
 *  buildStoredPlaceholder output). */
export interface ParsedStoredPlaceholder {
    ref: string;
    kind: string;
    tokens: number;
    retrieveToolName: string;
    /** Backtick title from line 1 (command/head preview), when present. */
    title?: string;
}
/** Parse a WHOLE-BODY canonical CCR placeholder; null otherwise.
 *
 *  Accepts exactly the two-line structure emitted by buildStoredPlaceholder,
 *  modulo one trusted leading render tag (hosts round-trip rendered output)
 *  and one optional trailing newline. Ordinary source, docs or logs that
 *  merely MENTION the marker — including embedded full placeholder examples
 *  with surrounding text — parse to null. The residual ambiguity is only user
 *  content byte-equal to a canonical placeholder, which no pure-text protocol
 *  can disambiguate (structured provenance is the long-term fix; deliberately
 *  out of scope here). Callers that know the message's own ref MUST compare
 *  `parsed.ref === ownRef` before trusting the result as an internal
 *  placeholder. */
export declare function parseStoredPlaceholder(text: string): ParsedStoredPlaceholder | null;
/** True iff the WHOLE body is a canonical CCR placeholder — i.e. the kernel
 *  already replaced this tool result and it must not be stored, re-compressed
 *  or absorbed again. Replaces the former `includes("[acp-stored")` substring
 *  check that misclassified ordinary text merely mentioning the marker
 *  (billion-context#1456). */
export declare function isStoredPlaceholderText(text: string): boolean;
export declare function retrievedMessageId(ref: string): string;
export declare function isRetrievedMessage(message: CoreMessage): boolean;
/** Frame an inline retrieved original as untrusted data: labelled header
 *  plus a delimited body. A closing tag inside the body is neutralized so
 *  content cannot end the delimiter early. This is the inline branch of
 *  applyRetrieve — the returned string becomes the acp_retrieve tool result
 *  itself. */
export declare function frameRetrievedOriginal(ref: string, entry: StoredEntry, text: string): string;
/** Pointer tool result for the export branch of applyRetrieve: the model
 *  reads the exported file with its own file-read tool (offset/limit
 *  paging). Deterministic for the same ref/path/entry. */
export declare function buildRetrievalPointer(ref: string, entry: StoredEntry, path: string, lines: number): string;
/** Host effect for the export branch of applyRetrieve: write `text` to
 *  `path` before replying to the model with the pointer tool result. The
 *  kernel performs no I/O (DESIGN.md); the path is deterministic per ref so
 *  re-retrieval writes identical bytes (idempotent). */
export interface RetrievalExport {
    /** Absolute path under the host-provided export directory. */
    path: string;
    /** Exact bytes to write. */
    text: string;
} /** Re-project the arrival-time placeholder for a stored ref whose original
 *  bytes arrived again raw (host retransmission). Frozen entry fields keep
 *  the wire byte-stable; entries persisted before `command` existed fall back
 *  to re-extracting from the paired call args, then to the head preview —
 *  matching what arrival produced in each case (#1460). */
export declare function restoreStoredPlaceholderText(ref: string, entry: StoredEntry, retrieveToolName: string, callArgsText: string | undefined, maxHeadChars: number): string;
export interface ApplyRetrieveInput {
    store: MessageContentStore;
    ref: string;
    /** Host-managed directory for exported originals. When set, originals
     *  with entry.tokens >= inlineTokenLimit are exported to
     *  `<dir>/<ref>.txt` (an effect the host writes; the kernel performs no
     *  I/O) and the tool result carries a pointer instead of the full bytes.
     *  Absent = always inline. */
    exportDir?: string;
    /** Inline threshold in tokens. Hosts typically pass
     *  resolveCcrConfig(config).retrieveInlineTokens; defaults to
     *  RETRIEVE_INLINE_TOKENS_DEFAULT (4000). */
    inlineTokenLimit?: number;
}
export type ApplyRetrieveResult = {
    ok: true;
    /** The original bytes (identical to export.text when exported). */
    text: string;
    /** The complete acp_retrieve tool result: the framed original
     *  (inline) or a pointer to the exported file. Untrusted-data framing
     *  either way. */
    toolResultText: string;
    entry: StoredEntry;
    /** Present when the original was exported instead of inlined: hosts
     *  write this file before sending the tool result. */
    export?: RetrievalExport;
} | {
    ok: false;
    reason: "not-found";
    toolResultText: string;
};
/** Kernel primitive behind acp_retrieve: resolve a ref to the tool result
 *  that returns its stored original. Retrieval is a plain tool call — the
 *  payload rides back in the tool-result slot itself (lowest trust tier,
 *  exactly where the content came from), never as a host-synthesized system
 *  or user message. Originals at or above the inline threshold are exported
 *  to a file and pointed to, so retrieval never re-inflates the conversation
 *  by more than the pointer. Hallucinated refs → not-found (cost: one tool
 *  call, by design). */
export declare function applyRetrieve(input: ApplyRetrieveInput): ApplyRetrieveResult;
export interface StoreLargeResultsInput {
    messages: CoreMessage[];
    state: CompressionState;
    store: MessageContentStore;
    config: Config;
    countTokens: (text: string) => number;
}
export interface StoreLargeResultsResult {
    messages: CoreMessage[];
    store: MessageContentStore;
    storedCount: number;
}
/** Core transform: store oversized tool-result originals and replace their
 *  visible text with placeholders. Pure over its inputs; returns new arrays.
 *  Only shrinks tool-result content in place — message ids, roles, toolCallId
 *  and the assistant tool_calls half are untouched (tool-pair integrity). */
export declare function storeLargeResults(input: StoreLargeResultsInput): StoreLargeResultsResult;
/** Effect shape carried in NodeIO.effects.ccr by ccrStoreNode. */
export interface CcrEffect {
    store: MessageContentStore;
    storedCount: number;
}
/** Pipeline node: runs after prune (new results live in the preserved tail,
 *  already referenced by assign-refs) and before absorb (placeholder-marked
 *  text is not an absorb candidate → ID-reference priority). */
export declare const ccrStoreNode: PipelineNode;
/** Adapter glue for v2 groundwork: persist originals of newly covered
 *  messages after applyCompression succeeds, so retrieve-by-ref works for
 *  folded content. First-write-wins keeps earlier CCR arrivals authoritative.
 *  Reasoning messages are skipped (thinking content is not retrievable). */
export declare function storeCoveredOriginals(store: MessageContentStore, messages: CoreMessage[], state: CompressionState, blockIds: readonly string[], countTokens: (text: string) => number, maxHeadChars?: number): MessageContentStore;
/** Bump the cumulative retrieval counter (host calls after a successful
 *  applyRetrieve; feeds the status report's retrieve-rate metric). */
export declare function noteRetrieval(state: CompressionState): CompressionState;
//# sourceMappingURL=ccr.d.ts.map