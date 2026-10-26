// src/refs.ts
var REF_WIDTH = 5;
var MIN_INDEX = 1;
var MAX_INDEX = 9999999;
var REF_PATTERN = /^m0*(\d{1,7})$/;
var BLOCKED_REF = "BLOCKED";
function emptyRefMap() {
  return { byRaw: {}, byRef: {} };
}
function indexToRef(index) {
  if (!Number.isInteger(index) || index < MIN_INDEX || index > MAX_INDEX) {
    throw new RangeError(
      `ref index out of bounds: ${index} (allowed ${MIN_INDEX}-${MAX_INDEX})`
    );
  }
  return `m${String(index).padStart(REF_WIDTH, "0")}`;
}
function refToIndex(ref) {
  const match = REF_PATTERN.exec(ref.trim().toLowerCase());
  if (!match) return null;
  const index = Number(match[1]);
  if (index < MIN_INDEX || index > MAX_INDEX) return null;
  return index;
}
function refForRaw(map, rawId) {
  return map.byRaw[rawId] ?? null;
}
function orderedRefPair(startRef, endRef) {
  const a = refToIndex(startRef);
  const b = refToIndex(endRef);
  if (a !== null && b !== null && b < a) return [endRef, startRef];
  return [startRef, endRef];
}
function rawForRef(map, ref) {
  return map.byRef[ref] ?? null;
}
function assignRefs(messages, options) {
  const map = {
    byRaw: { ...options.existing.byRaw },
    byRef: { ...options.existing.byRef }
  };
  let cursor = Number.isInteger(options.nextIndex) && options.nextIndex >= MIN_INDEX ? options.nextIndex : MIN_INDEX;
  let newlyAssigned = 0;
  const migratedIds = [];
  const siblingProtected = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (!message.id || options.shouldSkip?.(message)) continue;
    if (options.isProtected?.(message)) siblingProtected.add(message.id);
  }
  for (const message of messages) {
    if (!message.id || options.shouldSkip?.(message)) continue;
    const protectedNow = options.isProtected?.(message) ?? false;
    const prev = map.byRaw[message.id];
    if (prev) {
      if (prev === BLOCKED_REF && !protectedNow && !siblingProtected.has(message.id)) {
        delete map.byRaw[message.id];
        migratedIds.push(message.id);
      } else continue;
    }
    if (protectedNow) {
      map.byRaw[message.id] = BLOCKED_REF;
      continue;
    }
    const ledgerSeq = message.ledgerSeq;
    if (typeof ledgerSeq === "number" && Number.isInteger(ledgerSeq) && ledgerSeq >= MIN_INDEX && ledgerSeq <= MAX_INDEX) {
      const text = indexToRef(ledgerSeq);
      if (!map.byRef[text]) {
        map.byRaw[message.id] = text;
        map.byRef[text] = message.id;
        newlyAssigned++;
        if (ledgerSeq >= cursor) cursor = ledgerSeq + 1;
        continue;
      }
    }
    const ref = allocateFreeRef(map, cursor);
    cursor = ref.index + 1;
    map.byRaw[message.id] = ref.text;
    map.byRef[ref.text] = message.id;
    newlyAssigned++;
  }
  return { map, nextIndex: cursor, newlyAssigned, migratedIds };
}
function allocateFreeRef(map, start) {
  let candidate = Math.max(start, MIN_INDEX);
  while (candidate <= MAX_INDEX) {
    const text = indexToRef(candidate);
    if (!map.byRef[text]) {
      return { text, index: candidate };
    }
    candidate++;
  }
  throw new Error(
    `ref capacity exhausted: cannot allocate beyond ${indexToRef(MAX_INDEX)}`
  );
}
function restampRefsToLedger(state, seqByRawId) {
  const out = {
    kept: 0,
    restamped: 0,
    rehomed: 0,
    blocked: 0,
    superseded: /* @__PURE__ */ new Map()
  };
  if (state.refLedgerAligned === true) return out;
  const refs = state.messageRefs;
  if (!refs || !refs.byRaw || !refs.byRef) return out;
  const byRaw = { ...refs.byRaw };
  const byRef = { ...refs.byRef };
  const scratch = { byRaw, byRef };
  const displaced = [];
  let nextIndex = highestUsedIndex(refs) + 1;
  for (const [rawId, seq] of seqByRawId) {
    const current = byRaw[rawId];
    if (current === void 0) continue;
    if (current === BLOCKED_REF) {
      out.blocked++;
      continue;
    }
    const targetIndex = seq + 1;
    if (targetIndex < MIN_INDEX || targetIndex > MAX_INDEX) continue;
    const target = indexToRef(targetIndex);
    if (current === target) {
      out.kept++;
      if (targetIndex + 1 > nextIndex) nextIndex = targetIndex + 1;
      continue;
    }
    const occupant = byRef[target];
    if (occupant !== void 0 && occupant !== rawId) displaced.push(occupant);
    if (byRef[current] === rawId) delete byRef[current];
    out.superseded.set(current, rawId);
    byRaw[rawId] = target;
    byRef[target] = rawId;
    out.restamped++;
    if (targetIndex + 1 > nextIndex) nextIndex = targetIndex + 1;
  }
  for (const rawId of displaced) {
    const held = byRaw[rawId];
    if (held === void 0) continue;
    if (byRef[held] === rawId) continue;
    const free = allocateFreeRef(scratch, nextIndex);
    out.superseded.set(held, rawId);
    byRaw[rawId] = free.text;
    byRef[free.text] = rawId;
    nextIndex = free.index + 1;
    out.rehomed++;
  }
  state.messageRefs = { byRaw, byRef };
  state.refLedgerAligned = true;
  return out;
}
function highestUsedIndex(map) {
  let highest = 0;
  for (const ref of Object.values(map.byRaw)) {
    const index = ref === BLOCKED_REF ? null : refToIndex(ref);
    if (index !== null && index > highest) highest = index;
  }
  return highest;
}

// src/tokenize.ts
import { createRequire } from "module";
var require2 = createRequire(import.meta.url);
function defaultCountTokens(text) {
  if (!text) return 0;
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjk?.length ?? 0;
  return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}
function thinkingTokenValue(thinking) {
  return typeof thinking === "number" && Number.isFinite(thinking) && thinking > 0 ? thinking : 0;
}
function countMessageTokens(message, countTokens = defaultCountTokens) {
  return countTokens(message.text ?? "") + thinkingTokenValue(message.thinkingTokens);
}
function estimateTokensFast(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
var BPE_SIZE_GUARD = 1e5;
function createBpeTokenizer() {
  try {
    const mod = require2("@anthropic-ai/tokenizer");
    const bpeCount = mod.countTokens ?? mod.default?.countTokens;
    if (typeof bpeCount !== "function") return defaultCountTokens;
    return (text) => {
      if (text.length > BPE_SIZE_GUARD) return defaultCountTokens(text);
      try {
        return bpeCount(text);
      } catch {
        return defaultCountTokens(text);
      }
    };
  } catch {
    return defaultCountTokens;
  }
}

// src/compression-rules.ts
var LANGUAGE_PRESERVATION_RULE = "Preserve the source conversation's primary language. Do not translate a monolingual conversation without a user request. For mixed-language source, preserve each segment's language. Keep code, commands, identifiers, and quoted text verbatim when the tier's fidelity rules retain them.";
var COMPRESS_PHILOSOPHY = `Compression Philosophy:
- All compression serves the primary task, but be frugal.
- Context capacity is precious. Save context by compressing consumed outputs, not by avoiding tools.
- Compress by need, not by percentage.
- Work from summaries, not raw tool outputs. All listed ranges (user prompts, tool outputs, code, logs, exploration, intermediate steps) should be compressed to summary format \u2014 the ONLY exceptions are protected content, content the current step is actively using, or critical content you cannot reconstruct.`;
var HOW_TO_COMPRESS_RULES = `HOW TO COMPRESS

When you call \`compress\`, the summary you write becomes the only record of the replaced conversation. Make it self-contained and complete: every user request, experiment purpose, and work task in the range must be accurately captured. A later reader (or you, after decompressing) should be able to continue the task WITHOUT needing the original. The summary records the PAST as of this block's creation: label recorded task state as history ("TASK AS OF THIS BLOCK: ...") \u2014 never as a live instruction, so a later reader treats it as settled context, not something to re-execute. Write plain text with real unicode characters; never copy \\uXXXX escape sequences or JSON-escaped fragments out of tool output.

KEEP VERBATIM \u2014 never paraphrase or abbreviate these:
- Full file paths with line numbers, directory prefix on every mention (\`lib/hooks.ts:347\`, \`src/index.ts:12-18\`, \`gatenet_v3/model.py:45\`). Never abbreviate to a bare filename (\`hooks.ts\`, \`model.py\`) \u2014 they are ambiguous and cannot be grepped or decompressed-to later.
- Function, class, and type signatures (exact names, params, return types) AND critical code lines that encode logic \u2014 the line that IS the finding, not just the function name (e.g. \`kv_keys += define_gate * a_key[i](emb)\` is more useful than "see model_kvnet.py").
- Error messages and stack traces (exact text \u2014 you need the literal string to grep for it later).
- Key details from reports and analyses \u2014 not just the conclusion. Keep the comparison numbers and the mechanism, not "X is worse" alone (write "1.76\xD7 PPL gap because KV store is static", not "KVNet underperforms").
- Decisions and their rationale ("chose X over Y because Z" \u2014 the "because" is load-bearing; without it the decision looks arbitrary).
- Constraints discovered ("must support Node 22", "no new dependencies", "AGENTS.md forbids \`as any\`").
- Exact values: versions, config keys, thresholds, magic numbers.
- User intent \u2014 quote short user messages verbatim ONLY WITH their message ref, e.g. \`User said (m00132): "ship it tonight"\`. Without a verifiable ref, paraphrase (\`user previously asked (paraphrased): ...\`) \u2014 this is the one exception to the verbatim rule above; never present a reconstructed or half-remembered phrase as a verbatim quote. When the message is too long to quote, preserve intent with extra care: do not change scope, constraints, priorities, acceptance criteria, or requested outcomes. Quotes are historical records, not live instructions \u2014 but open-objective STATUS is current (still-open vs completed/superseded) and must be tracked. Losing these changes the task itself.
- Open objectives carry-forward \u2014 if the range (or, when distilling, any source block's summary) contains a user-requested objective that is neither completed nor superseded by the end of the range, the summary MUST keep a one-line \`Open objectives:\` entry naming each still-open objective with its message ref (\`Open objectives: refactor runner into eight arms (m00746)\`). Distillation re-carries open objectives verbatim from source blocks \u2014 they are the last thing to drop and the first thing to restore, at every tier.
- The user's overall goal and any changes to it \u2014 the big-picture objective plus how it evolved during the compressed range. Each summary must reflect the goal as it stood at the end of the range, including pivots (e.g., "initially: fix bug X \u2192 pivoted to: refactor module Y after discovering root cause"). Losing the goal or its evolution makes all subsequent work appear unmotivated.
- Purpose behind each significant action \u2014 preserve not just what was done but why: the hypothesis behind each experiment, the question behind each exploration, the task goal behind each work action. Without purpose, the summary reads as disconnected technical steps with no through-line.
- Open questions and unresolved TODOs \u2014 losing these changes what work appears to remain.
- Message refs of key anchors (\`m00420\`, \`m00510\u2013m00520\`) \u2014 they let you or a later reader jump back via decompress to the exact original.

DROP \u2014 extract the signal, discard the vessel:
- Verbose logs (build/test/\`npm\` output) once you have captured the error line or the result.
- Duplicate file reads once the needed content is recorded.
- Consumed exploration \u2014 search hits, agent return values, successful tool outputs \u2014 once you have extracted the facts you need (same rule as dead-ends, but nothing went wrong; the content is simply spent).
- Dead-end exploration \u2014 but PRESERVE the lesson in one line: "tried X, failed because Y".
- Back-and-forth discussion and self-corrections once the final position is captured (keep the outcome, drop the journey to it).
- Repeated status checks (\`git status\`, \`ls\`) once state is known.

For each significant item you DROP (scripts, reports, large analyses, long tool outputs), add a one-line CONTENT description of what it covers \u2014 not where it lives. Bad: "probe script at /path/probe_kvnet.py". Good: "probe_kvnet.py: tests n-gram baseline, generation quality, long-range dependency, position sensitivity, op pipeline, QUERY attention." This lets a later decompress target the right block by relevance, not by guessing locations.

PRIORITY \u2014 when the summary must be compact, preserve in this order:
1. User's overall goal, goal evolution, intent, and hard constraints (losing these changes the task).
2. Decisions and rationale.
3. Exact technical artifacts: paths, signatures, errors, values.
4. Conclusions and key findings.
5. Lessons learned: what failed and why.

Write dense, scannable bullets \u2014 not narrative prose. If the range spans distinct concerns (request \u2192 findings \u2192 decision), group bullets under short thematic headers so a reader can scan to the part they need. Every line must earn its place. Do not mimic the style of existing summaries in context; follow these rules.`;
var TIER2_DISTILL_RULES = `TIER 2 COMPRESSION \u2014 DISTILLATION

You are compressing historical summaries (not raw conversation). These summaries have already captured the details. Your job is to DISTILL them: extract only what matters for future work, discard the process.

KEEP \u2014 these are the only things that survive distillation:
- Decisions and their rationale ("chose X over Y because Z" \u2014 the "because" is load-bearing).
- Final outcomes: version numbers shipped, PR numbers merged/closed, bugs fixed or deferred.
- Key lessons: what failed and why ("tried X, failed because Y"). These prevent repeating mistakes.
- Critical constraints discovered ("must support Node 22", "AGENTS.md forbids as any").
- Design decisions with architectural impact ("chose compress-as-anchor over synthetic messages because prefix cache").
- User quotes and task state only as attributed history: keep the source ref with any user quote; never carry an UNVERIFIED tier-1 "CURRENT TASK" claim forward as a live directive \u2014 relabel it "TASK AS OF THIS BLOCK". A ref-backed objective that no later source marks completed or superseded is not unverified: it carries in the \`Open objectives:\` entry (next bullet), not as a directive.
- Open objectives \u2014 if ANY source block's summary names a user-requested objective that no later source block marks completed or superseded, the distilled summary MUST keep a one-line \`Open objectives:\` entry re-carrying each still-open objective verbatim with its original ref. They are the last thing to drop and the first thing to restore.
- Whether content is OBSOLETE or SUPERSEDED \u2014 mark with one line: "[SUPERSEDED by PR #NNN]" or "[OBSOLETE: deleted in vX.Y.Z]". Do NOT keep the obsolete content's details \u2014 just the marker and reason.
- Function/class/type names and module paths that are the SUBJECT of the work \u2014 e.g., "fixed filterCompressedRanges in prune.ts", "added SessionStateRegistry in state.ts". Not exact line numbers or full signatures \u2014 just enough to LOCATE the code without searching.
- Exploration findings: if a block was exploratory with no decision, keep the CONCLUSION in one line ("explored X, not viable because Y"). Do not keep the exploration process.

DROP \u2014 these were useful during the work but are no longer needed:
- Exact line numbers, diffs, verbose function signatures, full code listings.
- Build/deploy process details, test execution steps.
- Review process details (who reviewed, what rounds, test counts).
- Verbose logs, command output, intermediate debugging steps.

FORMAT:
- Start each distilled block with a source header line:
  \`Source: bN+bM+... (XK\u2192YK tok, Zx). [original topic]\`
  Example: \`Source: b5+b7 (56K+44K\u2192268 tok, 375x). [Tool-result recap + publish]\`
- 3-5 bullet points per source block, each a self-contained fact.
- Dense, scannable \u2014 no narrative prose.
- Start with the outcome, not the process: "v1.13.0 shipped (7 PRs bundled)" not "implemented 7 PRs then reviewed then merged".
- Cross-block synthesis: if multiple source blocks cover the same topic (same PR, same feature, same bug), MERGE them into a single group of bullets. Do not repeat the same fact from different blocks \u2014 keep it once under the most relevant source header.

SIZE TARGET: 50-150 tokens per source block (excluding the header). If you can't fit it in 150 tokens, you're keeping too much process. If a block has nothing worth keeping (pure noise), output just the header followed by "[no actionable content]."`;
var TIER3_CONDENSE_RULES = `TIER 3 COMPRESSION \u2014 ULTRA-CONDENSATION

You are compressing distilled summaries (Tier 2) into ultra-condensed facts (Tier 3). The distilled summaries already contain only decisions and outcomes. Your job is to reduce them to bare factual references.

PRIORITY \u2014 when a source block has more facts than the size target allows, keep in this order:
1. Shipped outcomes (versions released, PRs merged) \u2014 these are permanent record.
2. Open work \u2014 PRs/issues still pending AND still-open user-requested objectives (re-carry any source block's \`Open objectives:\` entries verbatim); these may need follow-up.
3. Key decisions with architectural impact ("chose X over Y because Z").
4. Critical constraints ("must support Node 22").
Drop everything else. Tier 3 is a lookup index, not a knowledge base.

FORMAT:
- Start with a source header line:
  \`Source: bN+bM+... (XK\u2192YK tok, Zx). [original topic]\`
- Output 1-3 facts per source block. Each fact is a single line: subject + outcome.
- No explanations, no rationale, no process \u2014 just the fact.
- Format: "[PR/Issue/Version] \u2014 [outcome in \u22648 words]"
- Merge related facts from different source blocks if they concern the same topic.

EXAMPLES:
- "v1.13.0 shipped \u2014 quality gate + GC fix (7 PRs)"
- "PR #196 merged \u2014 preserve-first-user (supersedes #169)"
- "Bug 1214 fixed \u2014 compress consumed all user messages"
- "Objective (m00746) \u2014 eight-arm runner refactor, still open"
- "Chose compress-as-anchor \u2014 prefix cache benefit over synthetic injection"
- "Constraint: AGENTS.md forbids as any \u2014 never suppress types"

DROP:
- Multi-sentence context. If a fact needs >1 sentence, it's too detailed for Tier 3.
- Lessons learned ("tried X, failed because Y") \u2014 drop UNLESS the failure is likely to recur and the block is <30 days old.
- Design rationale details \u2014 keep the decision, drop the "because" unless it's a critical constraint.
- Anything marked [OBSOLETE] or [SUPERSEDED] \u2014 drop entirely, note "[N blocks obsolete]" in the summary.

SIZE TARGET: 30-60 tokens per source block (including header). For a batch of N source blocks, total output \u2248 N \xD7 40 tokens. If a source block has only one trivial fact, output just the header + one line.`;

// src/prompts.ts
var defaultPrompts = Object.freeze({
  compressPhilosophy: COMPRESS_PHILOSOPHY,
  howToCompressRules: HOW_TO_COMPRESS_RULES,
  tier2DistillRules: TIER2_DISTILL_RULES,
  tier3CondenseRules: TIER3_CONDENSE_RULES
});
function resolvePrompts(overrides, options = {}) {
  const clean = {};
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === "string") {
        clean[key] = value;
      }
    }
  }
  const keys = Object.keys(clean);
  if (keys.length > 0 && !options.acknowledgeRisk) {
    throw new Error(
      `resolvePrompts: overriding compression rules requires { acknowledgeRisk: true }. Overridden keys: ${keys.join(", ")}. These rules are quality-critical (tuned over months of production use); changing them can degrade summary quality and break retrieval (summaries may lose paths, signatures, decisions).`
    );
  }
  const merged = { ...defaultPrompts, ...clean };
  if (options.languagePreservation) {
    return {
      compressPhilosophy: `${merged.compressPhilosophy}
- ${LANGUAGE_PRESERVATION_RULE}`,
      howToCompressRules: `${merged.howToCompressRules}

${LANGUAGE_PRESERVATION_RULE}`,
      tier2DistillRules: `${merged.tier2DistillRules}

${LANGUAGE_PRESERVATION_RULE}`,
      tier3CondenseRules: `${merged.tier3CondenseRules}

${LANGUAGE_PRESERVATION_RULE}`
    };
  }
  return merged;
}

// src/nudge-text.ts
function efficiencyNote(prompts, sections) {
  if (sections.efficiencyNote !== void 0) return sections.efficiencyNote;
  return `This is an efficiency nudge to compress early and keep context lean \u2014 not an overflow warning. A separate, stronger alert will appear if the context is actually full.

${prompts.compressPhilosophy}`;
}
function emergencyHeader(prompts, sections) {
  if (sections.emergencyHeader !== void 0) return sections.emergencyHeader;
  return `\u26A0\uFE0F Context limit reached \u2014 compress now. Prioritize consumed tool outputs.

${prompts.compressPhilosophy}`;
}
function formatK(n) {
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
}
function formatBreakdown(bd) {
  if (!bd) return "";
  const parts = [];
  if (bd.system > 0) parts.push(`${formatK(bd.system)} system`);
  if (bd.tool > 0) parts.push(`${formatK(bd.tool)} tool`);
  if (bd.summaries > 0) parts.push(`${formatK(bd.summaries)} summaries`);
  if (bd.code > 0) parts.push(`${formatK(bd.code)} code`);
  if (bd.text > 0) parts.push(`${formatK(bd.text)} text`);
  const growth = bd.growth > 0 ? `
+${formatK(bd.growth)} since last nudge` : "";
  return `Context breakdown: ${parts.join(" | ")}${growth}`;
}
function formatTierTargetBlocks(blocks) {
  if (blocks.length === 0) {
    return "Target blocks: (none \u2014 no tier blocks found)";
  }
  const lines = blocks.map((b) => {
    const summaryTokens = Math.ceil((b.summary ?? "").length / 4);
    const topic = b.topic ? `  "${b.topic}"` : "";
    return `  ${b.blockId}  ${b.effectiveMessageIds.length} msgs  ${formatK(b.compressedTokens)}\u2192${formatK(summaryTokens)}${topic}`;
  });
  return `Target ${blocks[0].tier === 1 ? "tier-1" : "tier-2"} blocks to distill (${blocks.length}):
${lines.join("\n")}`;
}
var BLOCK_MAP_MAX_SHOWN = 8;
function formatBlockMap(spans) {
  if (spans.length === 0) return "";
  const hidden = Math.max(0, spans.length - BLOCK_MAP_MAX_SHOWN);
  const shown = hidden > 0 ? spans.slice(-BLOCK_MAP_MAX_SHOWN) : spans;
  const items = shown.map(
    (s) => `${s.blockId}=${s.startRef}\u2013${s.endRef}${s.tier > 1 ? ` t${s.tier}` : ""}`
  );
  const prefix = hidden > 0 ? `\u2026+${hidden} older \xB7 ` : "";
  return `Active blocks (${spans.length}): ${prefix}${items.join(" \xB7 ")}`;
}
function formatRanges(compressible, protectedRanges) {
  if (compressible.length === 0 && protectedRanges.length === 0) {
    return "[No specific ranges detected \u2014 compress any consumed content.]";
  }
  const refNum = (ref) => {
    const m = ref.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  };
  const entries = [];
  for (const r of compressible) {
    entries.push({
      startRef: r.startRef,
      endRef: r.endRef,
      startNum: refNum(r.startRef),
      endNum: refNum(r.endRef),
      startPos: r.startIndex ?? refNum(r.startRef),
      endPos: r.endIndex ?? refNum(r.endRef),
      count: r.count,
      tokens: r.tokens,
      userMsgs: r.userMsgs ?? 0,
      toolPct: r.toolPct,
      textPct: r.textPct,
      compressibleTokens: r.tokens,
      compressibleCount: r.count,
      protectedTokens: 0,
      protectedCount: 0,
      protectedTools: [],
      dangerous: r.dangerous ?? false,
      noMergeBefore: r.noMergeBefore ?? false
    });
  }
  for (const r of protectedRanges) {
    entries.push({
      startRef: r.startRef,
      endRef: r.endRef,
      startNum: refNum(r.startRef),
      endNum: refNum(r.endRef),
      startPos: r.startIndex ?? refNum(r.startRef),
      endPos: r.endIndex ?? refNum(r.endRef),
      count: r.count,
      tokens: r.tokens,
      userMsgs: 0,
      toolPct: 0,
      textPct: 0,
      compressibleTokens: 0,
      compressibleCount: 0,
      protectedTokens: r.tokens,
      protectedCount: r.count,
      protectedTools: [...r.tools],
      dangerous: false,
      noMergeBefore: r.noMergeBefore ?? false
    });
  }
  entries.sort((a, b) => a.startPos - b.startPos || a.startNum - b.startNum);
  const merged = [];
  for (const e of entries) {
    const last = merged[merged.length - 1];
    if (last && !e.noMergeBefore && e.startPos <= last.endPos + 1) {
      last.endRef = e.endRef;
      last.endNum = Math.max(last.endNum, e.endNum);
      last.endPos = Math.max(last.endPos, e.endPos);
      last.count += e.count;
      last.tokens += e.tokens;
      last.userMsgs += e.userMsgs;
      last.compressibleTokens += e.compressibleTokens;
      last.compressibleCount += e.compressibleCount;
      last.protectedTokens += e.protectedTokens;
      last.protectedCount += e.protectedCount;
      if (e.dangerous) last.dangerous = true;
      for (const t of e.protectedTools) {
        if (!last.protectedTools.includes(t)) last.protectedTools.push(t);
      }
    } else {
      merged.push({ ...e });
    }
  }
  const userNote = (n) => n > 0 ? ` \xB7 ${n} user msg${n > 1 ? "s" : ""}` : "";
  const lines = merged.map((e) => {
    const [lo, hi] = orderedRefPair(e.startRef, e.endRef);
    const suffix = e.dangerous && e.compressibleTokens > 0 ? "  \u26A0\uFE0F NOT recommended unless you are certain." : "";
    if (e.protectedTokens > 0 && e.compressibleTokens === 0) {
      return `  ${lo}\u2013${hi}  ${e.count} msgs  ${formatK(e.tokens)} [PROTECTED: ${e.protectedTools.join(", ")} \u2014 not compressible]${suffix}`;
    }
    if (e.protectedTokens > 0 && e.compressibleTokens > 0) {
      return `  ${lo}\u2013${hi}  ${e.count} msgs  ${formatK(e.tokens)} [${formatK(e.compressibleTokens)} compressible | ${formatK(e.protectedTokens)} protected: ${e.protectedTools.join(", ")}]${userNote(e.userMsgs)}${suffix}`;
    }
    return `  ${lo}\u2013${hi}  ${e.count} msgs  ${formatK(e.tokens)} [tool ${e.toolPct}% | text ${e.textPct}%]${userNote(e.userMsgs)}${suffix}`;
  });
  return `Compressible ranges (${merged.length}, oldest first):
${lines.join("\n")}`;
}
var DEFAULT_T2_GUIDANCE = `Your tier-1 compression summaries have accumulated. Distill them into a single denser tier-2 summary. Use block IDs as boundaries (startId and endId as bN). Any raw (uncompressed) messages sitting between the boundary blocks are absorbed into the tier-2 block as well \u2014 apply HOW TO COMPRESS to those raw messages and the TIER 2 distillation rules to the existing summaries, so the whole span is covered and nothing is lost.`;
var DEFAULT_T3_GUIDANCE = `Your tier-2 compression summaries have accumulated. Condense them further into a tier-3 ultra-condensed summary. Use block IDs as boundaries (startId and endId as bN). Any raw (uncompressed) messages sitting between the boundary blocks are absorbed into the tier-3 block as well \u2014 apply HOW TO COMPRESS to those raw messages and the TIER 3 condensation rules to the existing summaries, so the whole span is covered and nothing is lost.`;
function tierGuidance(tier, sections) {
  const value = tier === 2 ? sections.t2Guidance : sections.t3Guidance;
  if (value !== void 0) return value;
  return tier === 2 ? DEFAULT_T2_GUIDANCE : DEFAULT_T3_GUIDANCE;
}
function compact(parts) {
  while (parts.length > 0 && parts[0] === "") parts.shift();
  return parts;
}
var ONE_CALL_HINT = "ONE call, ONE string \u2014 fold every range you keep into a single compress call: content entries ({startId, endId, summary, topic?}) or one JSON-escaped string holding one block per range ('m00150\u2013m00220 topic' header line, then the summary). Ranges you still need can wait \u2014 they reappear in later nudges; never split the batch across separate calls.";
var ANTHROPIC_LANE_NOTE = "Write the summary ONLY as the `compress` tool's `content` argument. Never emit `<analysis>` or `<summary>` tags in your reply text \u2014 they are not parsed, and a reply without a tool call ends the turn.";
function renderNudgeText(decision, prompts = defaultPrompts, sections = {}, protocol) {
  const breakdownStr = formatBreakdown(decision.contextBreakdown);
  const rangesStr = formatRanges(
    decision.compressibleRanges,
    decision.protectedRanges ?? []
  );
  const blockMapStr = formatBlockMap(decision.activeBlockSpans ?? []);
  const laneNote = protocol === "anthropic" ? ANTHROPIC_LANE_NOTE : null;
  const isEmergency = !!decision.breakdown?.emergencyOverride || !!decision.breakdown?.overLimit;
  if (decision.tier !== null && decision.tier >= 2) {
    const isT2 = decision.tier === 2;
    const targets = decision.tierTargetBlocks ?? [];
    const blockList = formatTierTargetBlocks(targets);
    const startId = targets[0]?.blockId ?? "b1";
    const endId = targets[targets.length - 1]?.blockId ?? "b5";
    const voice = isEmergency ? "emergency" : "gentle";
    const triggerLine = isEmergency ? `[EMERGENCY \u2014 TIER ${decision.tier} ${isT2 ? "DISTILLATION" : "CONDENSATION"}] Context limit reached \u2014 distill NOW into a denser summary to reclaim tokens.` : `[TIER ${decision.tier} ${isT2 ? "DISTILLATION" : "CONDENSATION"} TRIGGER]`;
    const guidance = tierGuidance(isT2 ? 2 : 3, sections);
    const head = efficiencyNote(prompts, sections);
    return {
      voice,
      text: compact([
        ...head === null ? [] : [head],
        "",
        breakdownStr,
        "",
        triggerLine,
        ...guidance === null ? [] : [guidance],
        blockList,
        `Example: compress({ content: [{ startId: "${startId}", endId: "${endId}", summary: "..." }] })`,
        "",
        prompts.howToCompressRules,
        "",
        isT2 ? prompts.tier2DistillRules : prompts.tier3CondenseRules,
        ...laneNote === null ? [] : ["", laneNote]
      ]).join("\n")
    };
  }
  if (isEmergency) {
    const head = emergencyHeader(prompts, sections);
    return {
      voice: "emergency",
      text: compact([
        ...head === null ? [] : [head],
        "",
        breakdownStr,
        "",
        prompts.howToCompressRules,
        "",
        "Only use IDs from visible messages above. Compress older work first.",
        "",
        rangesStr,
        ...blockMapStr ? ["", blockMapStr] : [],
        "",
        ONE_CALL_HINT,
        ...laneNote === null ? [] : ["", laneNote]
      ]).join("\n")
    };
  }
  const gentleHead = efficiencyNote(prompts, sections);
  return {
    voice: "gentle",
    text: compact([
      ...gentleHead === null ? [] : [gentleHead],
      "",
      breakdownStr,
      "",
      prompts.howToCompressRules,
      "",
      rangesStr,
      ...blockMapStr ? ["", blockMapStr] : [],
      "",
      `\u{1F4A1} If you compress, fold the ranges you keep in ONE call \u2014 pass multiple content entries (\`content: [{...}, {...}]\`) or ONE plain string holding every range, each block starting with its 'mNNNNN\u2013mNNNNN topic' header line (a valid JSON string: \\" and \\n). Ranges the task still needs can wait \u2014 they reappear in later nudges.`,
      ...laneNote === null ? [] : ["", laneNote]
    ]).join("\n")
  };
}

// src/viable.ts
var VIABLE_RANGE_MIN_TOKENS = 200;
function viableRanges(ranges) {
  return ranges.filter((r) => r.tokens >= VIABLE_RANGE_MIN_TOKENS);
}

// src/truncate.ts
function isHighSurrogate(c) {
  return c >= 55296 && c <= 56319;
}
function isLowSurrogate(c) {
  return c >= 56320 && c <= 57343;
}
function clampPrefix(text, maxUnits) {
  const cut = Math.min(maxUnits, text.length);
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1)))
    return text.slice(0, cut - 1);
  return text.slice(0, cut);
}
function clampWindow(text, start, end) {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.min(text.length, Math.max(s, end));
  if (s > 0 && isLowSurrogate(text.charCodeAt(s))) s += 1;
  if (e > s && isHighSurrogate(text.charCodeAt(e - 1))) e -= 1;
  return text.slice(s, Math.max(s, e));
}
function scrubLoneSurrogates(text) {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, "\uFFFD").replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\uFFFD");
}

export {
  BLOCKED_REF,
  emptyRefMap,
  indexToRef,
  refToIndex,
  refForRaw,
  orderedRefPair,
  rawForRef,
  assignRefs,
  restampRefsToLedger,
  highestUsedIndex,
  defaultCountTokens,
  thinkingTokenValue,
  countMessageTokens,
  estimateTokensFast,
  createBpeTokenizer,
  LANGUAGE_PRESERVATION_RULE,
  COMPRESS_PHILOSOPHY,
  HOW_TO_COMPRESS_RULES,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
  defaultPrompts,
  resolvePrompts,
  clampPrefix,
  clampWindow,
  scrubLoneSurrogates,
  formatRanges,
  ONE_CALL_HINT,
  renderNudgeText,
  VIABLE_RANGE_MIN_TOKENS,
  viableRanges
};
//# sourceMappingURL=chunk-VBWN2X6H.js.map