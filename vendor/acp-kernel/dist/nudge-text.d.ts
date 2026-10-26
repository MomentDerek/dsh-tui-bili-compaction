import type { NudgeDecision, CompressibleRange, ProtectedRange } from "./types.js";
import type { Prompts } from "./prompts.js";
/**
 * Wire protocol of the lane this nudge is rendered for. `undefined` means the
 * caller did not declare one; the text then stays protocol-neutral.
 */
export type NudgeProtocol = "anthropic" | "openai" | "responses" | "google";
export type NudgeVoice = "gentle" | "emergency";
export interface NudgePromptSections {
    efficiencyNote?: string | null;
    emergencyHeader?: string | null;
    t2Guidance?: string | null;
    t3Guidance?: string | null;
}
export interface RenderedNudge {
    voice: NudgeVoice;
    text: string;
}
export declare function formatRanges(compressible: CompressibleRange[], protectedRanges: ProtectedRange[]): string;
/** #2302 root-cause fix, distilled to a STATIC reminder. The nudge used to
 *  hand the model a LIST of recommended ranges plus a batching hint — and the
 *  model digests the list in groups, one compress call per group. Each separate
 *  call resets the provider prefix cache from its fold point and re-bills the
 *  whole remaining history; one call carrying every range pays once (live
 *  incident: five single-range calls over 44s on a 555K-token session
 *  re-billed 1.38M tokens; one 9-range call on the same log paid once).
 *  Instructions about batching do not survive contact with the model — but
 *  the expanded ready-to-fill skeleton had its own failure mode (#2377
 *  review): it grows linearly with the range count, reads like a mandatory
 *  to-do list (eroding the model's own judgment on WHAT to fold), and leaked
 *  onto query-only surfaces (acp_status). So the reminder is now ONE static
 *  line — never expanded, never range-aware, identical for every nudge. */
export declare const ONE_CALL_HINT = "ONE call, ONE string \u2014 fold every range you keep into a single compress call: content entries ({startId, endId, summary, topic?}) or one JSON-escaped string holding one block per range ('m00150\u2013m00220 topic' header line, then the summary). Ranges you still need can wait \u2014 they reappear in later nudges; never split the batch across separate calls.";
export declare function renderNudgeText(decision: NudgeDecision, prompts?: Prompts, sections?: NudgePromptSections, protocol?: NudgeProtocol): RenderedNudge;
//# sourceMappingURL=nudge-text.d.ts.map