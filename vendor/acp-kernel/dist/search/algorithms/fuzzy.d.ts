import type { SearchAlgorithm } from "../types.js";
/**
 * Fuzzy character-bigram matching (Jaccard-style).
 *
 * Decomposes the query into character bigrams and measures overlap with
 * each doc. Robust to typos (tokan≈token), partial words, and works
 * uniformly across all scripts (CJK benefits most).
 *
 * Query-token gate — CJK gets its own length rule; Latin is frozen:
 *   length >= 4 (any script)   typo-tolerant bigram rescue needs a couple of
 *       chars before it means anything; 2-3-char Latin tokens ("to", "of",
 *       "us") are stop-word noise whose bigrams overlap nearly every doc.
 *   length >= 2 && CJK         Chinese/Japanese/Korean words are mostly
 *       2-character atomic units (登录/缓存/図表), so the Latin-style >= 4 rule
 *       would lock the whole CJK query space out of this recall channel
 *       (that gap is what bench "缓存 → nothing" exposed). Single CJK chars
 *       stay excluded — one char cannot form a bigram, nothing to compare.
 *
 * On benchmark: lowest MRR of any single algorithm (0.795 — a hair under
 * substring's 0.797) — precision is weak, but it is the recall boost in the
 * hybrid default.
 */
export declare const fuzzyAlgorithm: SearchAlgorithm;
//# sourceMappingURL=fuzzy.d.ts.map