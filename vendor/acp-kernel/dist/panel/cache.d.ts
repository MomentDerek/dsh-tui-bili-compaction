/** Cache hit-rate math for the /acp status panel.
 *
 *  Hosts feed per-request prompt-cache usage samples (from assistant
 *  messages' provider-reported `usage`); the kernel derives the display
 *  numbers. A request COUNTS only when the provider reported cache
 *  activity for it (`cacheRead + cacheWrite > 0`): providers without
 *  prompt-cache reporting (0/0 with plain `input`) must not drag the
 *  average to a fabricated 0%. */
export interface CacheUsageSample {
    /** Non-cached conversation input tokens billed for the request. */
    input: number;
    /** Conversation tokens served from the prompt cache. */
    cacheRead: number;
    /** Conversation tokens written to the prompt cache (cache creation). */
    cacheWrite: number;
}
export interface CacheHitSummary {
    /** Session hit rate (0..1), weighted by billed prompt tokens.
     *  Undefined when no request reported cache activity. */
    session: number | undefined;
    /** Hit rate (0..1) of the most recent request that reported cache
     *  activity. Undefined when no request reported any. */
    last: number | undefined;
    /** Counted requests (provider reported cache activity). */
    requests: number;
    /** Cumulative tokens served from cache. */
    cacheRead: number;
    /** Cumulative billed prompt tokens (input + cacheRead + cacheWrite). */
    billedPrompt: number;
}
/** Aggregate per-request cache usage into panel display numbers. */
export declare function cacheHitStats(usages: readonly CacheUsageSample[]): CacheHitSummary;
/** Format a 0..1 rate as a percentage with one decimal ("92.3%"). */
export declare function formatHitRate(rate: number): string;
//# sourceMappingURL=cache.d.ts.map