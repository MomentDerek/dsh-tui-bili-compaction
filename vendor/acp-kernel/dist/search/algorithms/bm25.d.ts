import type { SearchAlgorithm } from "../types.js";
/**
 * BM25 with stemming + CJK bigram tokenization.
 *
 * k1=1.2, b=0.75 (standard IR). IDF down-weights terms common across the
 * corpus; length normalization prevents long summaries from dominating by
 * raw term count. Stemming collapses English morphology
 * (compress/compressed/compression → ~compress).
 *
 * On the 32-block mixed EN/CJK benchmark: MRR 0.833 / R@1 0.833 / R@3 0.833
 * vs 0.797 / 0.792 / 0.792 for substring — better in isolation on every
 * metric, and the precision component of the hybrid default (see hybrid.ts).
 */
export declare const bm25Algorithm: SearchAlgorithm;
//# sourceMappingURL=bm25.d.ts.map