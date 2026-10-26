import type { Config, CoreMessage } from "./types.js";
export interface TruncateOptions {
    minOutputTokens?: number;
    keepPrefixChars?: number;
    keepSuffixChars?: number;
    protectRecentMessages?: number;
    /** Also consider user/assistant text messages as LAST-RESORT candidates,
     *  applied only after tool-result truncation fails to reach the target
     *  (#300). Rendered block summaries are never touched. */
    includeTextMessages?: boolean;
}
export interface TruncateResult {
    messages: CoreMessage[];
    truncatedCount: number;
    savedTokens: number;
    /** Size-qualified candidates found (pre-truncation). 0 explains a silent
     *  no-op at/above threshold — hosts should warn-log (#300). */
    candidatesFound: number;
    /** Ids of the messages actually clipped this pass (#3939 ③ latch). Empty
     *  when truncatedCount is 0. */
    truncatedIds?: string[];
}
export declare function truncateLargeToolOutputs(messages: CoreMessage[], tokenCount: number, config: Config, countTokens: (text: string) => number, options?: TruncateOptions): TruncateResult;
//# sourceMappingURL=truncate-tools.d.ts.map