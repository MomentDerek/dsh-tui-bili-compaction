import type { CompressionBlock, CompressionState, CoreMessage } from "./types.js";
export declare function parseBlockIdArg(arg: string): string | null;
export declare function findBlocksOverlappingMessages(state: CompressionState, messageIds: Set<string>): CompressionBlock[];
export declare function findActiveAncestor(state: CompressionState, blockId: string): string | null;
export interface DeactivateOptions {
    deep?: boolean;
}
export declare function deactivateBlock(state: CompressionState, blockIds: string[], options?: DeactivateOptions): CompressionState;
export interface RestoredPreviewResult {
    preview: string;
    restoredCount: number;
}
export declare function buildRestoredContentPreview(messages: CoreMessage[], beforeActiveMessageIds: Set<string>, state: CompressionState): RestoredPreviewResult;
export interface CollectedContentResult {
    /** Rendered, human-readable content string (empty when count is 0). */
    text: string;
    /** Number of items rendered: direct messages + nested summaries (full=false) or all messages (full=true). */
    count: number;
}
export interface CollectContentOptions {
    /** When true, recurse through all nested tiers to original messages. Default: false (one tier up — nested active children stay folded, their summaries shown). */
    full?: boolean;
}
/**
 * Collect a block's content as a readable string WITHOUT modifying state.
 *
 * This is the cache-safe decompress primitive: the block stays compressed
 * (folded), its summary stays in place, and the full content is returned as
 * text for the caller to surface (e.g. as a tool result appended to the
 * conversation). Unlike deactivateBlock + prune, this does not mutate the
 * message-array prefix, so prompt cache is preserved.
 *
 * full=false (default): one tier up. Nested ACTIVE children of this block
 *   stay folded; their summaries are rendered in place of their messages.
 *   The block's own direct messages (not covered by any active child) are
 *   rendered in full.
 * full=true: recurse through all nested tiers; every effective message is
 *   rendered in full.
 *
 * Returns { text: "", count: 0 } when the block covers no messages.
 */
export declare function collectBlockContent(state: CompressionState, block: CompressionBlock, messages: CoreMessage[], options?: CollectContentOptions): CollectedContentResult;
export interface InlineRestoreResult {
    restored: true;
    blockId: string;
    /** m-ref of the block span's first message; omitted when not derivable
     *  (e.g. a multi-segment restore), in which case the adapter degrades to a
     *  generic re-fold hint. */
    restoredStartRef?: string;
    /** m-ref of the block span's last message (see restoredStartRef). */
    restoredEndRef?: string;
}
/** Inline-decompress marker for refold-in-place (#398): flags a block whose
 *  content was restored into the live conversation so compress() may refold it
 *  in place later. The block stays ACTIVE and no refs or ids move — only the
 *  flag flips, so ref immutability holds. Returns metadata for the host's
 *  re-fold guidance; `result` is null when the block does not exist. */
export declare function markBlockRestoredInline(state: CompressionState, blockId: string): {
    state: CompressionState;
    result: InlineRestoreResult | null;
};
/** All ACTIVE ancestors of a block (#398), nearest generation first: a block
 *  P is an ancestor when its directBlockIds (the blocks it folded) reach
 *  blockId; the walk keeps climbing through inactive intermediates up to live
 *  parents. Used to enforce the refold rule that no unrecovered folded tier
 *  sits above a restored block. */
export declare function activeAncestorIds(state: CompressionState, blockId: string): string[];
//# sourceMappingURL=decompress.d.ts.map