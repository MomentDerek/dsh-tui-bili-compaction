import type { DshMessage, DshSessionLike } from './dsh-types.js';
import type { CoreMessage } from './kernel.js';
/** Source kind stamped on every replacement message this plugin writes. */
export declare const BLOCK_SOURCE_KIND = "bili-compaction";
/** Source kind stamped on an optional nudge message (see `injectNudge`). */
export declare const NUDGE_SOURCE_KIND = "bili-compaction-nudge";
export interface ViewEntry {
    seq: number;
    message: DshMessage;
    ids: string[];
}
export interface KernelView {
    messages: CoreMessage[];
    entries: ViewEntry[];
    /** Kernel sub-id → owning dsh log sequence. */
    seqOf: Map<string, number>;
    /** Sub-ids the kernel must never fold. */
    protectedIds: Set<string>;
}
/**
 * Whether a session event is a message this plugin itself wrote (a block
 * summary or an injected nudge). Those are replacement copies: they are already
 * excluded by the `surfaceOp: 'append'` filter, but the source check keeps the
 * exclusion correct if dsh ever appends one of them instead.
 */
export declare function isOwnMessage(message: DshMessage): boolean;
/**
 * Fold the append-origin events of a session into the kernel's message list.
 *
 * Entries are emitted in log order, which is the order dsh renders them, so the
 * `seqOf` map resolves any kernel sub-id back to the surface node a durable
 * replace has to shadow.
 */
export declare function buildKernelView(session: DshSessionLike): KernelView;
/** The replacement text dsh renders for a block: kernel summary + topic. */
export declare function renderBlockSummary(header: string, summary: string, topic?: string): string;
//# sourceMappingURL=session-view.d.ts.map