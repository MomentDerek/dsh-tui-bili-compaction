/**
 * Output-side steering decisions (#355): turn-structure classification,
 * verbosity levels (L0–L4), clamp-only effort routing.
 *
 * This module is the protocol-agnostic half of output-side compression. It
 * DECIDES; adapters LAND. Adapters (e.g. billion-context) own:
 *   - mapping their wire body onto `StructuralMessage[]` (contract below),
 *   - writing the decision onto wire-specific fields (effort field names,
 *     system-prompt carriers, numeric budget floors),
 *   - config persistence and logging of returned warnings.
 *
 * Hard boundaries:
 *   1. CLAMP-ONLY — `lowerEffort` never means "raise". Adapters lower only
 *      effort fields the client ALREADY sent; absent fields are never
 *      injected (models without effort support 400 on them), and values
 *      at/below the floor are left alone (`clampEffortToFloor`).
 *   2. TAIL-ONLY injection — the verbosity directive goes at the TAIL of the
 *      system prompt (prefix cache requires stable head bytes; never prepend).
 *      `applySteeringToPrompt` replaces an existing sentinel block in place,
 *      so re-applying the same level is a byte-stable no-op (compress retries
 *      re-send through this path).
 *   3. BYTE-STABLE directives — the L1–L4 texts below are frozen across
 *      releases. Editing one character busts the prefix cache of every
 *      session pinned at that level. Change only with a deliberate,
 *      announced cache bust.
 *
 * Origin: decision logic adapted from billion-context PR#1096
 * (`2026-09-21_output-side-compression`, `src/output-steering.ts`; design per
 * headroomlabs-ai/headroom's output-token-reduction proposal). Per-wire rules
 * are preserved here as the normalization contract; wire-side landing stays
 * in adapters.
 */
export type TurnKind = "new_user_ask" | "mechanical_continuation" | "error_continuation" | "unknown";
export interface StructuralBlock {
    /**
     * `text` / `image` / `document` — user signal ⇒ new_user_ask.
     * `tool_result` — machine-produced result; accumulates toward a
     * continuation verdict.
     */
    kind: "text" | "image" | "document" | "tool_result";
    /** `tool_result` only: the wire's error flag (Anthropic `is_error`). Absent = clean. */
    isError?: boolean;
}
export interface StructuralMessage {
    role: string;
    /** Plain-string content (Anthropic/OpenAI allow string content). Mutually exclusive with `blocks` in practice; `text` wins when both present. */
    text?: string;
    blocks?: StructuralBlock[];
}
/**
 * Classify the FINAL turn purely structurally — block composition only, no
 * content pattern-matching. Only the last message matters. Conservative by
 * design: anything unrecognized yields `unknown` (never a guess), because an
 * unrecognized composition may carry user intent we cannot see.
 */
export declare function classifyTurn(messages: readonly StructuralMessage[]): TurnKind;
/**
 * Normalization contract (adapter responsibility — documented here because
 * classification correctness depends on it):
 *
 *  - Anthropic: pass through. String content → `text`; content blocks map by
 *    `type`: text/image/document → same kind; tool_result → tool_result with
 *    `isError = block.is_error === true`.
 *  - OpenAI chat: fold trailing consecutive `role:"tool"` messages into ONE
 *    synthetic final user message carrying tool_result blocks (no error flag
 *    exists on this wire → `isError` stays absent). A trailing user message
 *    passes through (string content → `text`; array content: non-empty text
 *    part → text block, otherwise unknown).
 *  - Responses: walk `input` BACKWARD from the end (clients re-send full
 *    history every request — scanning forward would hit the original ask on
 *    every turn). Items after the last user signal: `*_call_output`
 *    (function/custom_tool/local_shell/apply_patch) → tool_result blocks;
 *    assistant-side items (message/function_call/custom_tool_call/
 *    local_shell_call/apply_patch_call/reasoning) form the preceding
 *    assistant message(s). User signal = `input_text` (non-empty),
 *    `input_image`, `input_file`, or a role:"user" message with non-empty
 *    text. Trailing outputs ⇒ final user(tool_results); none ⇒ final
 *    user(text); pending call with no output yet ⇒ unknown.
 *  - Google: the last `contents` entry must be role:"user"; parts map:
 *    functionResponse → tool_result; non-empty text → text; empty text →
 *    dropped (neutral); inlineData/fileData/videoMetadata → image/document.
 *
 * Anything unrecognized maps to nothing (→ `unknown`), never to a guess.
 */
export declare const MIN_VERBOSITY_LEVEL = 0;
export declare const MAX_VERBOSITY_LEVEL = 4;
export declare const DEFAULT_VERBOSITY_LEVEL = 2;
/** Conciseness directives L1–L4. L0 = no directive. FROZEN across releases. */
export declare const VERBOSITY_LEVELS: Readonly<Record<number, string>>;
export declare function verbosityDirective(level: number): string | null;
/**
 * Default sentinel wrapping the steering directive. Each host SHOULD pass its
 * own sentinel so a body that passes through several proxies never collides
 * (billion-context uses `<bili_output_steering>`). Must be a full opening
 * XML-style tag `<name>`; the closing tag is derived as `</name>`.
 */
export declare const DEFAULT_STEERING_SENTINEL = "<acp_output_steering>";
export declare function renderSteeringBlock(level: number, sentinel?: string): string | null;
export interface SteeringPlacement {
    updated: string;
    changed: boolean;
}
/**
 * Idempotently place `block` in `existing`: when a block wrapped by
 * `sentinel` is present, replace it in place (preserving surrounding text);
 * otherwise append at the tail. Never prepends. Re-applying the same block
 * returns `changed: false` with byte-identical output (retry safety). A
 * malformed (unclosed) sentinel block is consumed to the end of the string
 * so re-application neither duplicates the closing tag nor grows the block.
 */
export declare function applySteeringToPrompt(existing: string, block: string, sentinel?: string): SteeringPlacement;
/**
 * Ascending shared effort ladder (OpenAI chat / Responses / Anthropic
 * output_config.effort use these values). Wire-specific NUMERIC budget floors
 * (e.g. Anthropic thinking.budget_tokens ≥ 1024, Google thinkingBudget ≥ 128,
 * dynamic `-1` untouched) live adapter-side — they are properties of wire
 * fields, not of the decision.
 */
export declare const EFFORT_LADDER: readonly ["minimal", "low", "medium", "high", "xhigh"];
export type EffortValue = (typeof EFFORT_LADDER)[number];
/**
 * Clamp-only floor computation. Returns the value to write, or null when the
 * field is absent/unrecognized or already at/below `floor`. Never raises: a
 * client that explicitly asked for `minimal` keeps it. Unrecognized values
 * are left untouched rather than coerced — coercing an unknown value that
 * happens to sit below the floor would be a raise.
 */
export declare function clampEffortToFloor(current: unknown, floor?: EffortValue): EffortValue | null;
export interface OutputSteeringConfig {
    /** Master switch. Default OFF — both levers inert until explicitly on. */
    enabled: boolean;
    /** Verbosity level 0–4 (0 = no directive). Default 2. */
    verbosityLevel: number;
    /** Effort-routing sub-switch. Default on whenever `enabled` is. */
    effortRouting: boolean;
}
export declare const DEFAULT_OUTPUT_STEERING_CONFIG: OutputSteeringConfig;
/**
 * Resolve a raw verbosity level. An OMITTED field silently takes the default;
 * a PRESENT but out-of-range value falls back WITH a warning (honest output —
 * a valid partial config must not be accused of being malformed).
 */
export declare function resolveVerbosityLevel(v: unknown): {
    level: number;
    warning?: string;
};
/**
 * Validate a raw `outputSteering` config value (e.g. parsed JSON). Malformed
 * fields fall back to defaults rather than throwing; warnings are returned
 * as data for the host to log. Non-object input yields pure defaults.
 */
export declare function resolveOutputSteeringConfig(v: unknown): {
    config: OutputSteeringConfig;
    warnings: string[];
};
export interface OutputSteeringDecision {
    /** Structural classification of the final turn (echoed for observability/logging). */
    turnKind: TurnKind;
    /** Level to inject; 0 = inject nothing. Always 0 while disabled. */
    verbosityLevel: number;
    /**
     * Clamp-only routing: true ⇔ enabled && effortRouting && mechanical
     * continuation. The adapter lowers each effort field the client already
     * sent toward its wire floor; it never injects absent fields and never
     * raises any value.
     */
    lowerEffort: boolean;
}
/**
 * Single decision entry point: structural summary of the FINAL message list
 * (+ resolved config) → steering decision. Pure, synchronous, side-effect
 * free. Landing — which field gets written, which carrier holds the system
 * prompt — is the adapter's job.
 */
export declare function decideOutputSteering(messages: readonly StructuralMessage[], config?: OutputSteeringConfig): OutputSteeringDecision;
//# sourceMappingURL=output-steering.d.ts.map