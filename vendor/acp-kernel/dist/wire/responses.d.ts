import type { CoreMessage } from "../types.js";
import type { ConversationIdentity } from "./util.js";
import { type BiliMessage } from "./bili-message.js";
export type ResponseContentPart = {
    type: "input_text";
    text: string;
    [key: string]: unknown;
} | {
    type: "output_text";
    text: string;
    [key: string]: unknown;
} | {
    type: "input_image";
    image_url: string;
    [key: string]: unknown;
} | {
    type: string;
    [key: string]: unknown;
};
export type ResponseInputMessage = {
    type: "message";
    role: "system" | "developer" | "user" | "assistant";
    content: string | ResponseContentPart[];
    [key: string]: unknown;
};
export type ResponseFunctionCall = {
    type: "function_call";
    id?: string;
    call_id: string;
    name: string;
    arguments: string;
    [key: string]: unknown;
};
export type ResponseFunctionCallOutput = {
    type: "function_call_output";
    call_id: string;
    output: string;
    [key: string]: unknown;
};
export type ResponseInputItem = ResponseInputMessage | ResponseFunctionCall | ResponseFunctionCallOutput | {
    type: string;
    [key: string]: unknown;
};
export type ResponsesRequestBody = {
    model?: string;
    input: string | ResponseInputItem[];
    instructions?: string;
    tools?: unknown[];
    stream?: boolean;
    session_id?: string;
    previous_response_id?: string;
    prompt_cache_key?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
};
type ResponseLayoutSlot = {
    original: ResponseInputItem;
    coreId?: string;
    /** #3642: canonical granularity splits one wire item into one core per
     *  content part. `coreId` stays the FIRST core (insertion anchoring);
     *  `coreIds` lists every core this item produced so the patch/replay path
     *  can drop the item only when ALL of its cores are folded, and rebuild a
     *  partial view when only some are (never resurrecting folded parts). */
    coreIds?: string[];
};
export type ResponsesProjection = {
    msgs: BiliMessage[];
    systemParts: string[];
    preamble: ResponseInputItem[];
    customToolCallIds: Set<string>;
    layout: ResponseLayoutSlot[];
    stringInput?: {
        original: string;
        coreId: string;
    };
    /** Reasoning items dropped because ACP_REASONING_KEEP=none. 0 by default —
     *  reasoning is normally routed through the compression pipeline so it is
     *  hidden automatically once its turn is summarized. */
    droppedReasoning: number;
};
export declare function responsesToCore(body: ResponsesRequestBody): ResponsesProjection;
export declare function patchResponsesInput(projection: ResponsesProjection, messages: CoreMessage[]): string | ResponseInputItem[];
export declare function coreToResponses(messages: CoreMessage[], customToolCallIds?: Set<string>): ResponseInputItem[];
export declare function injectResponsesDeveloperMessage(input: string | ResponseInputItem[], content: string): ResponseInputItem[];
export declare function conversationIdentityResponses(body: ResponsesRequestBody, headerValue?: string): ConversationIdentity;
export declare function conversationSignalResponses(body: ResponsesRequestBody, headerValue?: string): string;
export interface SubagentNamespaces {
    /** Resolve the compression-state namespace for a request: the identity
     *  itself for the anchored (main) instructions, `identity|sub:<fp>` for
     *  any other instructions value. First-seen instructions anchor. */
    namespaceFor(identityValue: string, instructions: unknown): string;
}
/** Host-owned subagent-namespace store.
 *
 * The anchor map is per-conversation mutable state, so it belongs to the
 * host — NOT to a library module global. Create one instance and keep it for
 * the process lifetime (or persist it alongside your session store if you
 * need namespaces to survive restarts: a fresh instance re-anchors on the
 * first request it sees, which after a restart may be a subagent request,
 * orphaning the main conversation's stored compression state). */
export declare function createSubagentNamespaces(): SubagentNamespaces;
export declare function subagentNamespace(identityValue: string, instructions: unknown): string;
export {};
//# sourceMappingURL=responses.d.ts.map