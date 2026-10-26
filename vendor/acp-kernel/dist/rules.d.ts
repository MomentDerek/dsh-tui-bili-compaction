import type { CompressionState, Config, RuleRecord } from "./types.js";
/**
 * Persistent rules ("acp_rule") — durable reminders recorded for future turns
 * (kernel #282, from billion-context-pi#433). The adapter injects
 * formatRulesForPrompt(state) into the system prompt every turn, and acp_rule
 * tool calls/results are hard-protected from compression
 * (ALWAYS_PROTECTED_TOOLS), so a recorded rule survives context compaction.
 *
 * State-mutating helpers: hosts hold live CompressionState objects (a session's
 * single state instance) and discard returned states — these helpers update
 * `state` in place and return only an ok/error result. All mutations stay
 * shallow-copy-free: the rules array is replaced (not spliced) so hosts that
 * captured listRules() output keep a stable snapshot.
 */
export declare const RULE_TOOL_NAME = "acp_rule";
export interface RuleLimits {
    maxRules: number;
    maxRuleChars: number;
}
export declare const DEFAULT_RULE_LIMITS: Readonly<RuleLimits>;
export declare const RULES_USAGE_PROMPT: string;
export declare function listRules(state: CompressionState): RuleRecord[];
/** Effective limits: `config.rules` overrides on top of the defaults. Hosts
 *  resolving per-request configs pass the resolved Config here (billion-context
 *  three-level merge / pi acp.json both land in Config.rules). */
export declare function resolveRuleLimits(config?: Pick<Config, "rules">): RuleLimits;
/** Pure (unlike the mutating addRule/removeRule/clearRules): returns the id
 *  the next addRule call would issue, without touching state. Never re-issues
 *  an issued id, even after removal: the counter is monotonic and the
 *  hand-crafted-state guard backfills it from the highest surviving id. */
export declare function allocateRuleId(state: CompressionState): string;
export type AddRuleResult = {
    ok: true;
    rule: RuleRecord;
} | {
    ok: false;
    error: string;
};
export declare function addRule(state: CompressionState, text: string, limits?: Partial<RuleLimits>): AddRuleResult;
export type RemoveRuleResult = {
    ok: true;
    rule: RuleRecord;
} | {
    ok: false;
    error: string;
};
export declare function removeRule(state: CompressionState, id: string): RemoveRuleResult;
export interface ClearRulesResult {
    ok: true;
    count: number;
}
export declare function clearRules(state: CompressionState): ClearRulesResult;
/** System-prompt section for adapters with rules enabled. Returns "" when no
 *  rules exist so empty sessions pay zero tokens. */
export declare function formatRulesForPrompt(state: CompressionState): string;
/** Plain numbered rendering for the acp_rule tool result when the model lists
 *  rules (billion-context#750 executeRule returns this verbatim). */
export declare function formatRulesList(rules: RuleRecord[]): string;
//# sourceMappingURL=rules.d.ts.map