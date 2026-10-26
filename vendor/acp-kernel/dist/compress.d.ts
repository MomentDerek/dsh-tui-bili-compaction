import { createInitialState } from "./state.js";
import type { ApplyRetrieveResult } from "./ccr.js";
import type { MessageContentStore } from "./content-store.js";
import type { RenderStrategy } from "./render-refs.js";
import { type PipelineNode } from "./pipeline.js";
import type { ApplyCompressionResult, CompressionBlock, CompressionState, Config, CoreMessage, ProcessTurnResult, StatusReport } from "./types.js";
export interface Ports {
    countTokens?: (text: string) => number;
}
export interface CompressionCore {
    processTurn(input: ProcessTurnInput): ProcessTurnResult;
    /** Kernel primitive behind acp_retrieve: resolve a ref to its stored
     *  original plus the wire-safe injection pair (see ccr.ts). */
    retrieve(store: MessageContentStore, ref: string): ApplyRetrieveResult;
    applyCompression(input: ApplyCompressionInput): ApplyCompressionResult;
    defaultNodes(): PipelineNode[];
    decompress(blockId: string, state: CompressionState): CompressionBlock | undefined;
    search(query: string, state: CompressionState): CompressionBlock[];
    status(state: CompressionState, tokenCount: number, config: Config): StatusReport;
}
export interface ProcessTurnInput {
    messages: CoreMessage[];
    state: CompressionState;
    config: Config;
    tokenCount: number;
    /**
     * Which messages get an <acp> ref tag injected into their text
     * (the render-refs pipeline node). Refs are ALWAYS assigned regardless
     * (assign-refs node runs unconditionally).
     *   - "all" (default): tag every mapped message — in-process hosts
     *     like pai-acp want tags for the LLM to reference compress ranges.
     *   - "text-only": tag only user/assistant text; leave tool-call args
     *     and tool-result content pristine — proxy hosts where structured
     *     content must not be polluted.
     *   - "none": leave all text untouched — hosts that read the ref map
     *     directly from result.state.messageRefs.
     */
    renderTags?: RenderStrategy;
    /** Per-session CCR content store (pass result.contentStore back here).
     *  Omit for pre-CCR sessions — an empty store is used. */
    contentStore?: MessageContentStore;
    /** #3236: the EXACT message array class applyCompression will run on for
     * this lane. Hosts whose render view (`messages`) differs from the fold
     * view (pruned separators, host-side compaction tails) pass the unpruned
     * log here so recommendation screening and unit projection judge ranges on
     * the same class execute will — advertised and applied can't diverge.
     * Omit when `messages` already IS that class. */
    applyView?: CoreMessage[];
}
export interface ApplyCompressionInput {
    ranges: {
        startRef: string;
        endRef: string;
        summary: string;
        topic?: string;
        compressCallId?: string;
        summaryMaxChars?: number;
    }[];
    messages: CoreMessage[];
    state: CompressionState;
    config: Config;
    protectedMessageIds?: Set<string>;
}
export declare function createCore(ports?: Ports): CompressionCore;
export { createInitialState };
//# sourceMappingURL=compress.d.ts.map