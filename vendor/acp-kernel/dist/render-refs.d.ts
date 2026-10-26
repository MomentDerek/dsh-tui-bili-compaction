import type { CoreMessage, CompressionState } from "./types.js";
import type { PipelineNode } from "./pipeline.js";
/**
 * Controls which messages get an <acp> ref tag injected into their text.
 * Ref assignment (assignRefsNode) is unconditional — every message always
 * receives a ref in state.messageRefs regardless of this setting. This only
 * governs text rendering:
 *  - "all": tag every mapped message (in-process hosts like pai-acp)
 *  - "text-only": tag only user/assistant text; leave tool-call args and
 *    tool-result content pristine (proxy hosts — structured content must not
 *    be polluted)
 *  - "none": leave all text untouched (hosts that read the ref map directly)
 */
export type RenderStrategy = "all" | "text-only" | "none";
export declare function renderVisibleRefs(messages: CoreMessage[], state: CompressionState, countTokens?: (text: string) => number, strategy?: RenderStrategy): CoreMessage[];
export interface RenderWithSnapshotResult {
    messages: CoreMessage[];
    tokenSnapshot: Record<string, number>;
}
/** Render with a stable token snapshot: token counts are written on first
 *  render and reused forever (keyed by ref). The snapshot starts as a shallow
 *  copy of the persisted state so old entries survive; new entries are added
 *  during this render. */
export declare function renderWithSnapshot(messages: CoreMessage[], state: CompressionState, countTokens?: (text: string) => number, strategy?: RenderStrategy): RenderWithSnapshotResult;
/** Factory: build a render-refs node bound to a specific render strategy. */
export declare function createRenderRefsNode(strategy: RenderStrategy): PipelineNode;
/** Backward compat: default render-refs node using strategy "all". */
export declare const renderRefsNode: PipelineNode;
//# sourceMappingURL=render-refs.d.ts.map