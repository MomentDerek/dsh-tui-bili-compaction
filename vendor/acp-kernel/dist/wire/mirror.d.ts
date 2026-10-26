import type { BiliMessage } from "./bili-message.js";
/**
 * Mirror constructors: rebuild the WIRE-SHAPE projection of a persisted
 * conversation (the mirror of "what the host will put on the wire after a
 * restart") for each protocol family, then fold it through the matching
 * `*ToCore` codec so the projection lands in the same identity/fingerprint
 * space as the live request.
 *
 * This used to live as three hand-rolled builders in the omp plugin
 * (wire-fold.ts) — protocol knowledge scattered across consumers is exactly
 * how the issue-#64 class of restart divergences happened (one place fixed,
 * another broke). The wire layouts now live here, next to the codecs that
 * define their identity space.
 *
 * CONTRACT: the caller maps its own persisted message shape into
 * {@link MirrorMessage} FIRST and normalizes text there (e.g. ref-tag
 * stripping is a host-app concern, not a wire concern). Builders only apply
 * host-encoder wire rules:
 *   - thinking rides each wire the way the live encoder sends it
 *     (openai: `reasoning_content` field — hosts that demote inline as
 *     `<think>…</think>` land in the same identity space anyway because
 *     `openaiToCore` normalizes the inline form; anthropic: signed
 *     `{type:"thinking"}` blocks; responses: `{type:"reasoning"}` items);
 *   - whitespace-only text survives on the openai wire, is dropped on the
 *     anthropic/responses wires (host encoder behaviour);
 *   - tool calls/results map to each wire's native shape.
 */
export type MirrorBlock = {
    type: "text";
    text: string;
} | {
    type: "thinking";
    thinking: string;
    signature?: string;
} | {
    type: "toolCall";
    id?: string;
    name?: string;
    arguments?: unknown;
};
export type MirrorMessage = {
    /** `meta` is anything the host sends as out-of-band/system-ish traffic. */
    role: "user" | "assistant" | "toolResult" | "meta";
    blocks?: MirrorBlock[];
    /** toolResult only. */
    toolCallId?: string;
    /** meta only: extracted text or summary. */
    text?: string;
};
/** Openai/completions mirror: system message first, then the conversation
 * with thinking as the `reasoning_content` field (issue #103). */
export declare function mirrorOpenaiMessages(view: MirrorMessage[], systemText: string): Array<Record<string, unknown>>;
/** Anthropic/messages mirror: no system message (the live request carries it
 * as the top-level `system` field, out of the fold space — issue #64), tool
 * results folded into user messages, thinking as signed `{type:"thinking"}`
 * blocks (issue #103). Unsigned thinking is demoted to text by the live
 * encoder; sending it as a thinking block diverges, so callers that persist
 * unsigned thinking should send it as a text block instead. */
export declare function mirrorAnthropicMessages(view: MirrorMessage[]): Array<Record<string, unknown>>;
/** Responses mirror: the live /v1/responses request carries the system
 * prompt in the top-level `instructions` field and the conversation as an
 * `input` item array (issue #64, responses variant). Assistant blocks are
 * emitted in content order so the core sequence matches the live wire
 * (issue #103 parity). */
export declare function mirrorResponsesInput(view: MirrorMessage[]): Array<Record<string, unknown>>;
/** Fold the openai mirror through `openaiToCore`. */
export declare function mirrorOpenaiToCore(view: MirrorMessage[], systemText: string): BiliMessage[];
/** Fold the anthropic mirror through `anthropicToCore`. */
export declare function mirrorAnthropicToCore(view: MirrorMessage[]): BiliMessage[];
/** Fold the responses mirror through `responsesToCore`. */
export declare function mirrorResponsesToCore(view: MirrorMessage[], systemText: string): BiliMessage[];
//# sourceMappingURL=mirror.d.ts.map