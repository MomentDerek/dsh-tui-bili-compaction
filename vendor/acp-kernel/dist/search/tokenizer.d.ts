/**
 * Search tokenizer.
 *
 * Handles mixed Latin + CJK content — the single biggest quality lever
 * over plain substring search. Latin is split on non-word boundaries;
 * CJK (no spaces) is word-segmented via Intl.Segmenter (CLDR dictionary),
 * falling back to overlapping bigrams on out-of-vocabulary text so a query
 * like "身份验证" still scores against doc text "身份验证流程".
 *
 * CJK segmentation is a SINGLE segment() pass over the whole text, not one
 * call per CJK run: a segment() call has fixed overhead (~3µs), and
 * run-heavy text (logs: dozens of short runs per line) made per-run calls
 * 10-16× slower than one bulk pass. ICU never merges CJK words across
 * non-CJK boundaries, so bulk segmentation yields the same words per run
 * (differential-verified against the per-run implementation across a
 * mixed-script stress corpus); run boundaries are re-derived below to keep
 * the all-OOV bigram fallback.
 */
export declare const CJK: RegExp;
export interface TokenizeOptions {
    stem?: boolean;
}
export declare function tokenize(text: string, opts?: TokenizeOptions): string[];
/** Character bigrams over arbitrary text — used by fuzzy matching. */
export declare function charBigrams(text: string): string[];
/** Term-frequency map. */
export declare function tfMap(text: string, stem: boolean): Map<string, number>;
//# sourceMappingURL=tokenizer.d.ts.map