import type { BiliMessage } from "./bili-message.js";
export type GooglePart = {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    functionCall?: {
        name: string;
        args?: unknown;
        id?: string;
    };
    functionResponse?: {
        name: string;
        response?: unknown;
        id?: string;
        parts?: GooglePart[];
    };
    inlineData?: {
        mimeType: string;
        data: string;
    };
    fileData?: {
        fileUri: string;
        mimeType?: string;
    };
    [k: string]: unknown;
};
export type GoogleContent = {
    role?: string;
    parts: GooglePart[];
};
export type GoogleFunctionDeclaration = {
    name: string;
    description?: string;
    parameters?: unknown;
    parametersJsonSchema?: unknown;
    response?: unknown;
    [k: string]: unknown;
};
export type GoogleTool = {
    functionDeclarations?: GoogleFunctionDeclaration[];
    [k: string]: unknown;
};
export type GoogleSystemInstruction = {
    parts?: GooglePart[];
    role?: string;
};
export type GoogleRequestBody = {
    contents: GoogleContent[];
    systemInstruction?: GoogleSystemInstruction;
    tools?: GoogleTool[];
    toolConfig?: unknown;
    generationConfig?: Record<string, unknown>;
    cachedContent?: string;
    [k: string]: unknown;
};
export type GoogleFlat = {
    msgs: BiliMessage[];
    systemText: string;
};
/** Hoist the system dimension out of the fold space. `systemInstruction` is
 *  host runtime state exactly like the openai codec's leading system prefix
 *  (see openaiToCore): its content varies across restarts, so keeping it
 *  inside the id space made every downstream fingerprint spanning it
 *  unstable, and a compress range that covered it deleted the model's system
 *  prompt from the rebuilt wire. The adapter re-injects it as
 *  `systemInstruction` at egress. */
export declare function googleSystemText(body: GoogleRequestBody): string;
/** Map a Gemini request body onto the kernel's message space. Mirrors
 *  openaiToCore's role handling: `content.role === "model"` is the assistant
 *  side, everything else the user side. A user content's functionResponse
 *  parts expand into `role:"tool"` cores emitted BEFORE that content's own
 *  user core — the client appends a second functionResponse to the previous
 *  user content instead of opening a new one, so those parts belong to the
 *  tool pair, not to the user text they sit next to. */
export declare function googleToCore(body: GoogleRequestBody): GoogleFlat;
/** #3159 — Vertex rejects a request whose user content carries plain text
 *  AFTER a functionResponse part ("Requests ending with a model turn are not
 *  supported"); text-before-functionResponse is accepted (controlled A/B on
 *  the official endpoint, gemini-4-argon). When a movable plain-text part
 *  trails a functionResponse, stable-partition the unsigned non-thought plain
 *  text ahead of every non-text part; otherwise return the input untouched so
 *  already-safe shapes stay byte-identical (prefix-cache anchor). Signed text
 *  parts, thought parts and all non-text parts keep their relative order —
 *  nothing is dropped, renamed or rewritten. */
export declare function normalizeGoogleUserPartOrder(parts: GooglePart[]): GooglePart[];
/** Rebuild Gemini `contents` from kernel messages. Runs of same-side cores
 *  are merged into ONE content (Gemini rejects non-alternating roles): an
 *  assistant run becomes a single `{"role":"model"}` content whose parts are
 *  ordered reasoning, text, tool-call; a user-side run (user + tool-result)
 *  becomes a single `{"role":"user"}` content normalized by
 *  normalizeGoogleUserPartOrder (#3159: plain text leads, functionResponse
 *  parts trail). Mid-conversation system cores (host-synthetic; Gemini has no
 *  system role inside contents) ride on the user side as a text part.
 *
 *  Byte-stability contract (#3938 / #3939⑥): for alternating-role histories
 *  (the only shape Gemini accepts), this function is PURE in the core array
 *  — same shape, same bytes, every request; any drift breaks the upstream
 *  prefix cache mid-session. The canonical part orders ARE the merge rules
 *  above: model runs emit reasoning → text → tool-call; user runs emit
 *  functionResponse parts then content parts, re-normalized by
 *  normalizeGoogleUserPartOrder (#3159). Merging same-role runs into one
 *  content is the required normalization (Gemini rejects non-alternating
 *  roles), and its output order is the canonical one. Do not reorder this
 *  emission without moving the pins in
 *  kernel/tests/issue3939-wire-byte-stability.test.ts. */
export declare function coreToGoogle(messages: BiliMessage[]): GoogleContent[];
/** Text-protocol/fallback system injection. `contents` has no top-level
 *  system slot, so the prompt becomes the first part of the leading user
 *  content, or a new leading user content when none is there. The adapter and
 *  the server inject the real system via `systemInstruction` instead (see the
 *  proxy's createGoogleAdapter) — this exists for the path where no system
 *  channel is wanted. */
export declare function injectGoogleSystem(contents: GoogleContent[], parts: string[]): GoogleContent[];
/** Extract the conversation dimension for Gemini: a client-provided session
 *  header if present (omp sends none for this protocol), else a content
 *  fingerprint of the first user content. See conversationSignalAnthropic for
 *  the full rationale. */
export declare function conversationSignalGoogle(body: GoogleRequestBody, headerValue?: string): string;
//# sourceMappingURL=google.d.ts.map