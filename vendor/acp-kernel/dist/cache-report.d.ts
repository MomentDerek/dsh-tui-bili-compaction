/**
 * Prompt-cache reconciliation (billion-context#800).
 *
 * The provider-reported per-request usage IS the grand ledger (总账) — this
 * module never invents numbers; it splits every request's cache miss into
 * three additive buckets so the totals reconcile exactly by construction:
 *
 *   missed_i = input_i − cached_i
 *            = newContent_i   content newly appended since the previous request
 *                            (legit fresh — not an invalidation at all)
 *            + compRepay_i    re-payment forced by compression folds (the
 *                            prefix diverged at the fold's first start point)
 *            + ttlRepay_i     residual: UNATTRIBUTED misses inside the
 *                            stable prefix → upstream TTL expiry /
 *                            provider-side eviction OR client-side wire
 *                            rewrite — the kernel cannot distinguish
 *
 * No estimate participates in the closure: newContent is clamped to observed
 * growth, compRepay is clamped to BOTH the remaining miss and the structural
 * excess implied by the fold divergence point, ttlRepay is whatever remains.
 * Hence, for ANY inputs:
 *
 *   Σ input = Σ cached + Σ newContent + Σ compRepay + Σ ttlRepay        (exact)
 *
 * `decomposeSample` is the single implementation used both by
 * `buildCacheReport` (batch) and by hosts that stream-record aggregates
 * incrementally — one code path, one accounting semantics.
 */
export interface CacheSample {
    /** Epoch ms when the usage report was observed. */
    at: number;
    /** Total prompt tokens billed for this request — NORMALIZED so cached is
     *  INCLUDED (Anthropic input_tokens excludes cached; OpenAI includes it). */
    input: number;
    /** Provider-reported cache-hit tokens (0 when the provider reports none). */
    cached: number;
    output?: number;
}
export interface FoldEvent {
    /** Epoch ms when the fold was applied (between two requests). */
    at: number;
    /** S: tokens removed from the view by this fold. */
    tokensCompressed: number;
    /** σ: rendered summary size in tokens (or actual summary output tokens). */
    summaryTokens?: number;
    /** X: token offset of the earliest divergence point inside the post-fold
     *  view ≈ expected post-fold hit prefix. Host-computed estimate — used
     *  only as a clamp bound, never in the closure. */
    firstFoldStartTokens?: number;
    /** V: pre-fold view size. */
    viewBefore?: number;
    /** V′: post-fold view size. */
    viewAfter?: number;
}
/** Normalized price multipliers over the input-token unit (p_in = 1).
 *  w = cacheWrite/input, r = cacheRead/input, q = output/input. */
export interface PriceProfile {
    w?: number;
    r?: number;
    q?: number;
}
/** #2929: a fold claims not only its first following sample but the whole
 *  post-fold COLD TAIL — until a warm line proves the provider re-cached or
 *  this many samples have elapsed (#1847 switch discipline, mirrored for
 *  folds). Rationale: the first post-fold request (the proxy's re-request)
 *  is attributed today, but the client-echo re-bill 25–66s later carried no
 *  fold stamp and fell into the unattributed TTL residual, tripping the
 *  cache-seam detector with "no fold attribution". Warm hit that retires
 *  the window (same threshold as the host's WARM_HIT_PCT). */
export declare const FOLD_CLAIM_WARM_HIT_PCT = 85;
export declare const FOLD_CLAIM_COLD_ROUNDS = 4;
export interface SampleDecomposition {
    missed: number;
    newContent: number;
    compRepay: number;
    ttlRepay: number;
    /** Index into `pendingFolds` of the fold credited with compRepay, or null. */
    foldIndex: number | null;
}
/** Split one request's miss into the three buckets.
 *
 * @param prev         previous sample (null for the first observed request)
 * @param cur          current sample
 * @param pendingFolds folds applied after `prev` and no later than `cur`
 */
export declare function decomposeSample(prev: CacheSample | null, cur: CacheSample, pendingFolds: readonly FoldEvent[]): SampleDecomposition;
export interface CacheTotals {
    requests: number;
    input: number;
    cached: number;
    output: number;
    /** cached / input × 100 (0 when input = 0). */
    hitPct: number;
    newContent: number;
    compRepay: number;
    ttlRepay: number;
    /** input − cached − (newContent + compRepay + ttlRepay); 0 by construction. */
    residual: number;
    balanced: boolean;
}
export interface FoldEconomics {
    /** 1-based chronological fold sequence. */
    seq: number;
    at: number;
    /** S: tokens compressed. */
    S: number;
    /** σ: summary tokens (0 when unknown). */
    sigma: number;
    /** V′: post-fold view size (null when unknown). */
    Vprime: number | null;
    /** Measured hit rate (0–100) of the first post-fold request, else null. */
    hPct: number | null;
    /** Measured compression re-pay (tokens) attributed to this fold. */
    T: number;
    /** Requests observed after this fold. */
    requestsAfter: number;
    /** (S−σ) × requestsAfter — tokens not billed because of this fold
     *  (regrowth eats back into it; estimate, not part of the closure). */
    savedSoFar: number;
    /** Sample count until the next fold, null for the last fold. */
    turnsToNextFold: number | null;
    /** Pure token delta (price-independent): T + σ − S. <0 means the fold
     *  removed more raw tokens than it forced us to send back. */
    netTokenDelta: number;
    /** One-time cost in input-token-equivalent units (billion-context#359):
     *  (w−r)·T + q·σ − r·S, using the effective price profile. */
    oneTimeCostUnits: number;
    /** Per-turn saving in input-token-equivalent units: (S−σ)·r. */
    perTurnSavingUnits: number;
    /** Breakeven turns n* = max(0,oneTimeCost)/perTurnSaving; null when S ≤ σ. */
    breakevenTurns: number | null;
    /** paidBack: lifetime payback verdict — post-fold requests observed so far
     *  (requestsAfter) reached the breakeven point n*. Same window as
     *  savedSoFar, so the verdict and the token figures on one row agree
     *  (billion-context#2044). null while unobservable (S ≤ σ). */
    paidBack: boolean | null;
    /** cadenceOk: the original short-window verdict — folds until the NEXT
     *  fold (turnsToNextFold) reached n*. This is an interleave-cadence
     *  signal (folded too soon after the previous one), NOT a payback
     *  verdict; null while there is no next fold. Guard-signal candidate for
     *  billion-context#1280 / #2044. */
    cadenceOk: boolean | null;
}
export interface EconomicsSummary {
    folds: number;
    /** Σ (S−σ)×requestsAfter across folds (additive: each fold removes its own
     *  tokens from every later view). */
    grossSaved: number;
    /** Σ T — measured compression re-pay. */
    repayCost: number;
    /** Σ σ — summary generation cost (output tokens). */
    summaryCost: number;
    /** grossSaved − repayCost − summaryCost. */
    netTokens: number;
    paidBackCount: number;
    notPaidBackCount: number;
    unobservedCount: number;
}
export interface CacheReportLine {
    /** 1-based request sequence. */
    seq: number;
    at: number;
    input: number;
    cached: number;
    output: number;
    hitPct: number;
    missed: number;
    newContent: number;
    compRepay: number;
    ttlRepay: number;
    /** Global fold seq credited with compRepay, or null. */
    foldSeq: number | null;
}
export interface CacheReportOptions {
    priceProfile?: PriceProfile;
    /** Max line items kept in `lines` (newest retained). Default 512. */
    maxLines?: number;
}
export interface CacheReport {
    generatedAt: number;
    /** Effective price profile used for the weighted economics fields. */
    profile: Required<PriceProfile>;
    totals: CacheTotals;
    economics: EconomicsSummary;
    folds: FoldEconomics[];
    lines: CacheReportLine[];
    /** Older lines excluded from `lines` (totals still cover them). */
    linesOmitted: number;
}
/** Measured counters for one fold. Streaming hosts accumulate these
 * incrementally; buildCacheReport derives them from raw samples. */
export interface FoldEconomicsInput {
    seq: number;
    at: number;
    /** S — tokens removed from the view by the fold. */
    S: number;
    /** σ — summary tokens that replaced them (0 when unknown). */
    sigma: number;
    Vprime?: number | null;
    /** Measured hit rate (0-100) of the first post-fold sample. */
    hPct: number | null;
    /** T — measured compRepay attributed to this fold. */
    T: number;
    requestsAfter: number;
    /** Measured turns until the next fold; null while still running. */
    turnsToNextFold: number | null;
}
export declare function computeFoldEconomics(f: FoldEconomicsInput, price?: PriceProfile): FoldEconomics;
export declare function summarizeFoldEconomics(foldEcon: readonly FoldEconomics[]): EconomicsSummary;
export declare function buildCacheReport(samplesIn: readonly CacheSample[], foldsIn: readonly FoldEvent[], opts?: CacheReportOptions): CacheReport;
/** Render options: "summary" (default) distills to totals + verdicts +
 *  notable folds + anomalous lines; "full" keeps the legacy every-fold,
 *  every-line listing. */
export interface FormatCacheReportOptions {
    detail?: "summary" | "full";
}
/** Render the report as compact, model- and human-readable text.
 *  The identity line is always printed so a broken implementation cannot hide.
 *  Default detail is "summary"; pass { detail: "full" } for the legacy
 *  every-fold, every-line listing. */
export declare function formatCacheReport(report: CacheReport, sessionLabel?: string, opts?: FormatCacheReportOptions): string;
//# sourceMappingURL=cache-report.d.ts.map