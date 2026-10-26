/**
 * Content-addressed message store (CCR foundation).
 *
 * Pure data + pure functions — zero I/O (DESIGN.md: "the core holds no state
 * and performs no I/O"). The host persists this structure with its own
 * mechanism (StateStore envelope, same path as block-level original caches);
 * it deliberately does NOT live inside CompressionState so multi-megabyte
 * originals don't get rewritten on every per-turn state save.
 *
 * Invariants:
 * - Content-addressed dedup: identical text is stored once (byHash).
 * - Append-only per ref: first write wins, entries are never removed or
 *   overwritten by fold/edit/truncate. Refs are never reissued by the kernel
 *   (id-never-reused contract), so ref → original is a stable function for
 *   the life of the session generation.
 * - The ref → rawId alias is frozen at store time, so retrieval keeps working
 *   even after a host compaction archive prunes messageRefs (the store's own
 *   byRef index is the source of truth for retrieval).
 * - Generation boundary: when a host rebase resets refs to m00001 (full-state
 *   rebase), the host resets the store with the state — otherwise old and new
 *   generations would share one ref namespace. Session-scoped compaction that
 *   keeps state (refs continue) leaves the store untouched on purpose.
 * - Retention (cleanup/eviction) is a downstream policy decision, like all
 *   persisted state.
 */
export interface StoredEntry {
    /** sha256 hex of the stored original text (key into byHash). */
    hash: string;
    /** Raw message id at store time. Frozen alias — survives ref-map pruning. */
    rawId: string;
    /** Placeholder kind label ("shell output", "file read", ...). */
    kind: string;
    /** Tool name at arrival, if any. */
    toolName?: string;
    /** Token count of the original, fixed at arrival (deterministic metadata). */
    tokens: number;
    /** Character length of the original. */
    chars: number;
    /** Deterministic head preview embedded in the placeholder. */
    head: string;
    /** Call subject (command/path/query) frozen at arrival, if extractable —
     *  needed to re-project a byte-identical placeholder on raw retransmission. */
    command?: string;
}
export interface MessageContentStore {
    version: 1;
    /** Content-addressed originals: sha256(text) → text. Dedup lives here. */
    byHash: Record<string, string>;
    /** Per-ref index: ref → entry. Append-only; first write wins. */
    byRef: Record<string, StoredEntry>;
}
export interface StoreSpec {
    ref: string;
    rawId: string;
    text: string;
    kind: string;
    toolName?: string;
    tokens: number;
    head: string;
    command?: string;
}
export declare function createContentStore(): MessageContentStore;
export declare function hashContent(text: string): string;
/** Append-only insert. Returns the input unchanged when the ref is already
 *  stored (first write wins); otherwise adds the entry, deduping content by
 *  hash. Immutably styled like the rest of the kernel. */
export declare function storeOriginal(store: MessageContentStore, spec: StoreSpec): MessageContentStore;
export type RetrieveResult = {
    ok: true;
    text: string;
    entry: StoredEntry;
} | {
    ok: false;
    reason: "not-found";
};
/** Fetch an original by ref. Unknown/hallucinated refs → not-found (the cost
 *  is one tool call, by design). Resolves through the store's own byRef index
 *  — independent of messageRefs, which hosts may prune. */
export declare function retrieveByRef(store: MessageContentStore, ref: string): RetrieveResult;
export declare function hasStoredRef(store: MessageContentStore, ref: string): boolean;
export interface ContentStoreStats {
    /** Number of stored refs. */
    entries: number;
    /** Number of unique contents after dedup. */
    uniqueContents: number;
    /** Total characters held across unique contents. */
    totalChars: number;
}
export declare function contentStoreStats(store: MessageContentStore): ContentStoreStats;
//# sourceMappingURL=content-store.d.ts.map