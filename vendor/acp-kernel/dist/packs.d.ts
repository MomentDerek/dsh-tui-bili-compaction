import type { Prompts } from "./prompts.js";
import type { CompressPromptSections, ToolPrompts } from "./surface-config.js";
import type { NudgePromptSections } from "./nudge-text.js";
/** Raw on-disk pack JSON (user-authored file or installer payload). Every
 * field optional; sanitized into a {@link PackSurface} before use. */
export interface PromptPackFile {
    name?: string;
    version?: string;
    description?: string;
    prompts?: unknown;
    promptSections?: unknown;
    nudgeSections?: unknown;
    toolPrompts?: unknown;
    /** Opaque per-host extras, keyed by host id (e.g. `pi`). Hosts sanitize
     * their own sub-object; the kernel only checks it is a plain object. */
    adapters?: unknown;
}
/** Sanitized surface bundle a pack contributes. */
export interface PackSurface {
    prompts?: Partial<Prompts>;
    promptSections?: CompressPromptSections;
    nudgeSections?: NudgePromptSections;
    toolPrompts?: ToolPrompts;
    adapters?: Record<string, unknown>;
}
/** A resolved prompt pack: name + sanitized surface, tagged with provenance
 * (`builtin:lean`, `file:/home/u/.config/x/packs/lean.json`, …). */
export interface Pack {
    name: string;
    version?: string;
    description?: string;
    surface: PackSurface;
    source: string;
}
/** A pluggable pack origin. Sources are consulted in resolver order; the
 * first non-null wins. Implementations must be safe to call per turn (sync,
 * no throw). */
export interface PackSource {
    readonly id: string;
    resolve(name: string): Pack | null;
    list?(): Pack[];
}
/** Ordered pack resolution over pluggable sources. */
export interface PackResolver {
    readonly sources: readonly PackSource[];
    resolve(name: string): Pack | null;
    listPacks(): Pack[];
}
export declare function isValidPackName(name: string): boolean;
/** Sanitize a raw pack file body into a kernel {@link PackSurface}. Malformed
 * values are dropped — a bad override never clobbers a good default. The
 * `adapters` record is passed through opaquely for host-side validation. */
export declare function sanitizePackSurface(raw: PromptPackFile | null | undefined): PackSurface;
/** The identity pack: no overrides, kernel defaults everywhere. */
export declare const defaultPack: Pack;
/**
 * Condensed how-to-compress contract for the lean pack (issue #263).
 *
 * Distillation of HOW_TO_COMPRESS_RULES (~5.2K chars → ~2.5K) that keeps every
 * load-bearing class — all KEEP VERBATIM items, DROP rules, one-line CONTENT
 * descriptions, PRIORITY order, format rules — plus two integrity rules exposed
 * by session 01a09989: with no style contract at summary-writing time, the model
 * transcribed follow-up Q&A as an enumerated "(answered)" list, recorded an unsent
 * reply as sent, then pattern-completed the list into a fabricated user turn.
 * Summaries are the only record; this contract is the floor that keeps them honest.
 */
export declare const LEAN_HOW_TO_COMPRESS = "HOW TO COMPRESS\n\nYour summary is the ONLY record of the replaced conversation \u2014 a later reader must continue without the original. It records the PAST: label task state as history (\"TASK AS OF THIS BLOCK: ...\"), never as a live instruction. Real unicode only, never \\uXXXX escapes.\n\nINTEGRITY \u2014 record facts and state only, never a simulated transcript of the dialogue: no Q&A lists, no \"(answered)\" claims. An answer not actually sent is PENDING; user questions are recorded as asked (with ref), never as answered.\n\nKEEP VERBATIM \u2014 never paraphrase or abbreviate:\n- File paths with line numbers and directory prefix on every mention (lib/hooks.ts:347); never a bare filename \u2014 ambiguous, un-greppable.\n- Function/class/type signatures AND the critical code lines that encode logic (the line that IS the finding).\n- Error messages and stack traces (exact text \u2014 needed to grep later).\n- Report details: comparison numbers plus mechanism, not \"X is worse\" (\"1.76\u00D7 PPL gap because KV store is static\").\n- Decisions with rationale (\"chose X over Y because Z\"); discovered constraints (\"must support Node 22\").\n- Exact values: versions, config keys, thresholds, magic numbers.\n- User intent: short quotes verbatim ONLY WITH message ref (User said (m00132): \"ship it tonight\"); without a ref, paraphrase. Quotes are history, not live instructions \u2014 but open-objective STATUS is current (see Open objectives below); never change scope, constraints, priorities, acceptance criteria, outcomes.\n- Overall goal and its evolution, including pivots (\"initially: fix X \u2192 pivoted to: refactor Y\").\n- Purpose behind significant actions (hypothesis, question, goal \u2014 not just what was done).\n- Open questions and unresolved TODOs.\n- Open objectives: user-requested work neither completed nor superseded gets a one-line \"Open objectives:\" entry with message refs; scan absorbed block summaries too. Last to drop, first to restore at every tier \u2014 carrying is not a directive to re-execute unconfirmed.\n- Message refs of key anchors (m00420, m00510\u2013m00520) for decompress.\n\nDROP \u2014 keep the signal, discard the vessel: verbose logs once the error/result is captured; duplicate reads; consumed exploration (search hits, agent returns, successful outputs); dead ends (one lesson line: \"tried X, failed because Y\"); back-and-forth once the final position is kept; repeated status checks. For each dropped item add one line of CONTENT: what it covers (\"probe.py: tests n-gram baseline...\"), not where it lives.\n\nPRIORITY when compacting: 1. user goal/evolution/intent/hard constraints \u00B7 2. decisions + rationale \u00B7 3. exact artifacts (paths, signatures, errors, values) \u00B7 4. conclusions \u00B7 5. lessons learned (what failed and why).\n\nFormat: dense scannable bullets under short thematic headers, not narrative prose; every line earns its place. Do not mimic the style of existing summaries in context; follow these rules.";
/** Lean-pack how-to-compress with the opt-in language-preservation rule (#493).
 * `false` (the default) returns the base text untouched — the builtin lean
 * surface stays byte-identical; hosts that enabled the rule pass `true` and
 * get it appended. Mirrors resolvePrompts' languagePreservation for the lean
 * surface (whose howToCompress slot does not flow through resolvePrompts). */
export declare function leanHowToCompress(languagePreservation?: boolean): string;
/** Token-lean surface: one-line tool descriptions, no snippets or guidelines.
 * Host-specific trims (e.g. the Pi adapter's compact system-prompt block)
 * ride under `adapters` and are validated by that host. The pi
 * `howToCompress` slot carries the condensed contract (LEAN_HOW_TO_COMPRESS);
 * philosophy/tier2/tier3 stay null — tier guidance still reaches the model via
 * nudge text (nudgeSections untouched). */
export declare const leanPack: Pack;
export declare const builtinSource: PackSource;
/** A pack directory source: `<dir>/<name>.json` files. Serves project-local,
 * user-global, and any future installer-managed directory identically. */
export declare function createDirPackSource(id: string, dir: string): PackSource;
/** Ordered resolution over the given sources; the first non-null wins. */
export declare function createPackResolver(sources: readonly PackSource[]): PackResolver;
/** Default source chain: project pack dir, then any user pack dirs, then the
 * builtin registry. Directory paths are host policy — the kernel only
 * assembles the chain. */
export declare function defaultPackSources(opts: {
    projectDir: string;
    userDirs?: readonly string[];
}): PackSource[];
//# sourceMappingURL=packs.d.ts.map