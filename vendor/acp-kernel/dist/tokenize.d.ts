export declare function defaultCountTokens(text: string): number;
export declare function estimateMessageTokens(text: string | undefined): number;
/** Guarded contribution of a host-projected thinking payload to the metered
 *  message size. Non-finite or non-positive values are treated as absent (0),
 *  so a bad host value can never poison the accounting. */
export declare function thinkingTokenValue(thinking: number | undefined): number;
/** Total metered size of a core message: visible text plus any host-projected
 *  thinking payload (CoreMessage.thinkingTokens). Every per-message counting
 *  site (range recommendations, block compressedTokens, status reports, context
 *  breakdown) goes through this so all surfaces share one caliber. */
export declare function countMessageTokens(message: {
    text?: string;
    thinkingTokens?: number;
}, countTokens?: TokenCountFn): number;
export declare function estimateTokensFast(text: string): number;
export type TokenCountFn = (text: string) => number;
export declare function createBpeTokenizer(): TokenCountFn;
//# sourceMappingURL=tokenize.d.ts.map