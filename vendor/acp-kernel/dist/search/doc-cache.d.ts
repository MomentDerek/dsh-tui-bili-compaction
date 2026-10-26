/**
 * Per-doc derived features, memoized across search calls.
 *
 * A search over the compressed history re-scores the SAME immutable docs on
 * every call — compressed block summaries and folded message text never
 * change. Without this cache, every search_context call re-tokenized the
 * entire corpus (segmenter pass ≈ 0.1–0.6s/MB cold, content-dependent) plus
 * re-lowercased it and rebuilt the bigram set for each channel: a 5MB session
 * cost seconds PER CALL, growing linearly with session length. With the cache
 * the corpus is processed once; later searches are O(docs × query-terms).
 *
 * Keyed by doc text (immutable), bounded by total cached SOURCE CHARS. Eviction
 * is least-recently-used: a hit re-inserts the doc at the tail, so the docs a
 * host keeps re-touching are retained. LRU helps when access is HETEROGENEOUS
 * (a hot subset across many queries; a long-lived multi-session process). It
 * does NOT help when every call re-scans the ENTIRE corpus below the cap — no
 * hot subset exists, the window slides past every doc each call, and
 * (corpus − cap) is re-tokenized every time.
 *
 * Sizing consequence: if your corpus exceeds the cap and each search rescans
 * it whole, the ONLY setting that stops re-tokenization is
 * setDocCacheCap(≥ corpus) (or Infinity). Do NOT lower the cap to save memory
 * there — it trades bounded memory for a full re-tokenize of the excess on
 * EVERY call. The default (8MB) suits hosts running many sessions that cannot
 * afford to pin one corpus.
 *
 * The cap is in SOURCE CHARS, a loose proxy for retained heap: feature memory
 * scales with DISTINCT token/bigram count, content-dependent (≈ 2×–49× per
 * source char, latin prose → high-entropy CJK). The cap bounds billed chars,
 * not a hard memory limit.
 *
 * The cap is MODULE-GLOBAL — setDocCacheCap() sets process-wide state shared
 * by every acp-kernel consumer in the process. Fine while one consumer runs
 * per process; a per-scope cache (keyed by doc ref) would let a host scope a
 * cap to one session instead (see #227).
 *
 * Hosts that want to release the memory eagerly on session shutdown/switch
 * can call clearDocFeatures() (optional: the cap already bounds it).
 */
export interface DocFeatures {
    /** Stemmed term frequencies (BM25 channel). */
    tf: Map<string, number>;
    /** Total term count (BM25 length normalization). */
    len: number;
    /** Lower-cased text (substring + fuzzy channels). */
    lower: string;
    /** Unique char bigrams of `lower` (fuzzy channel). */
    grams: Set<string>;
}
export declare function docFeatures(text: string): DocFeatures;
/** Drop all cached features (e.g. on session shutdown/switch). */
export declare function clearDocFeatures(): void;
/**
 * Set the cache cap in source chars. Docs larger than the cap are never
 * cached. Pass a value ≥ the corpus size (or Infinity) to cache the whole
 * corpus — a single-session host then avoids re-tokenizing on every call.
 * Also used by tests to exercise eviction.
 */
export declare function setDocCacheCap(chars: number): void;
/** Cache occupancy — for diagnostics. */
export declare function docCacheInfo(): {
    entries: number;
    chars: number;
};
//# sourceMappingURL=doc-cache.d.ts.map