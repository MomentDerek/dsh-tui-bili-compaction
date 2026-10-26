import type { CompressionState, CoreMessage } from "./types.js";
export interface HandoffMeta {
    title?: string;
    label?: string;
    sessionId: string;
    contextTokens?: number;
    extraBullets?: string[];
}
export interface HandoffBlockFull {
    blockId: string;
    topic?: string;
    count: number;
    fullText: string;
}
export interface HandoffInput {
    coreMessages: CoreMessage[];
    state: CompressionState;
    full: boolean;
    /** coreMessages is an already-pruned persisted snapshot (#401 bounded
     *  folded tail): render it as-is instead of re-running prune() — its
     *  message ids no longer align with the state ranges, so pruning would
     *  resurrect dropped summaries at index 0. */
    folded?: boolean;
    /** Original messages per active block, recovered from the block content
     *  cache. Appended after the conversation when full && folded — the
     *  folded snapshot itself no longer carries the folded ranges' originals. */
    blocksFull?: HandoffBlockFull[];
    meta: HandoffMeta;
}
export declare function renderMessage(m: CoreMessage): string;
export declare function renderHandoff(input: HandoffInput): string;
export declare function matchSession<T extends {
    id: string;
}>(sessions: T[], selector: string, labelOf: (s: T) => string | undefined): T[];
//# sourceMappingURL=handoff.d.ts.map