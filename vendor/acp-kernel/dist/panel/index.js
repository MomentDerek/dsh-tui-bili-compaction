import {
  clampPrefix,
  defaultCountTokens,
  formatRanges,
  viableRanges
} from "../chunk-VBWN2X6H.js";

// src/panel/topic.ts
function topicFallback(summary) {
  const first = summary.split(/[.\n]/)[0] ?? "";
  const t = first.trim().replace(/^["'`]+/, "").trim();
  return t.length <= 30 ? t : `${clampPrefix(t, 30).trimEnd()}\u2026`;
}

// src/panel/format.ts
function formatCompactTokens(count) {
  if (count < 1e3) return count.toString();
  if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1e3)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

// src/panel/cache.ts
function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
function cacheHitStats(usages) {
  let cacheRead = 0;
  let billedPrompt = 0;
  let requests = 0;
  let last;
  for (const u of usages) {
    const read = num(u?.cacheRead);
    const write = num(u?.cacheWrite);
    const input = num(u?.input);
    if (read + write <= 0) continue;
    const total = read + write + input;
    if (total <= 0) continue;
    cacheRead += read;
    billedPrompt += total;
    requests += 1;
    last = read / total;
  }
  return {
    session: requests > 0 ? cacheRead / billedPrompt : void 0,
    last,
    requests,
    cacheRead,
    billedPrompt
  };
}
function formatHitRate(rate) {
  return `${(Math.max(0, Math.min(1, rate)) * 100).toFixed(1)}%`;
}

// src/panel/panel.ts
function bar(value, total, width = 20) {
  if (total === 0) return "";
  const filled = Math.max(
    0,
    Math.min(width, Math.round(value / total * width))
  );
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}
function buildStatusPanel(input) {
  const { tokenCount, state, nudge, modelContextLimit } = input;
  const fmt = input.fmtTokens ?? formatCompactTokens;
  const externalBlockIds = input.externalBlockIds;
  const bd = nudge?.contextBreakdown;
  const limit = modelContextLimit;
  const classified = bd ? bd.system + bd.tool + bd.summaries + bd.code + bd.text : 0;
  const systemPromptTokens = input.systemPromptTokens;
  const sentTotal = classified + systemPromptTokens;
  const sessionOnly = input.unprunedTokens !== void 0 ? Math.max(0, input.unprunedTokens - sentTotal) : 0;
  const displayTotal = tokenCount;
  const displayPct = limit > 0 ? Math.round(displayTotal / limit * 100) : 0;
  const sentPct = limit > 0 ? Math.round(sentTotal / limit * 100) : 0;
  const activeBlocksList = state.blocks.filter((b) => b.active);
  const totalBlocksList = state.blocks;
  const lines = [];
  lines.push("\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E");
  lines.push("\u2502           ACP Context Analysis              \u2502");
  lines.push("\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F");
  if (input.version) lines.push(input.version);
  if (input.storage) lines.push(input.storage);
  lines.push("");
  lines.push(
    `Context (session accounting, host footer scale): ${displayPct}% (${fmt(displayTotal)} / ${fmt(limit)}) \u2014 includes compressed originals; shrinks slower than the sent view`
  );
  if (nudge && bd) {
    const growth = bd.growth;
    if (growth > 0 && displayTotal > 0) {
      lines.push(`Growth: +${fmt(growth)} since last nudge`);
    }
    lines.push("");
    lines.push(
      `Sent to LLM (after compression, est.): ${fmt(sentTotal)}${limit > 0 ? ` (${sentPct}% of limit)` : ""}`
    );
    if (input.unprunedTokens !== void 0 && sessionOnly > 0) {
      lines.push(
        `Session-only (compressed originals, est.): ${fmt(sessionOnly)} \u2014 pruned from every request; the footer/nudge still count them`
      );
    }
    lines.push("");
    lines.push("Token Breakdown (sent view):");
    const categories = [
      { label: "Tool", value: bd.tool },
      { label: "SysPrompt", value: systemPromptTokens },
      { label: "Text", value: bd.text },
      { label: "Code", value: bd.code },
      { label: "Summaries", value: bd.summaries }
    ];
    for (const cat of categories) {
      if (cat.value <= 0) continue;
      const pct = sentTotal > 0 ? Math.round(cat.value / sentTotal * 100) : 0;
      const b = bar(cat.value, sentTotal);
      lines.push(
        `  ${cat.label.padEnd(10)} ${b} ${String(pct).padStart(3)}%  ${fmt(cat.value)}`
      );
    }
  }
  if (input.cacheUsages) {
    const cache = cacheHitStats(input.cacheUsages);
    if (cache.requests > 0 && cache.session !== void 0 && cache.last !== void 0) {
      lines.push("");
      lines.push(
        `Prompt cache (provider-reported): ${formatHitRate(cache.last)} last \xB7 ${formatHitRate(cache.session)} session avg \u2014 ${fmt(cache.cacheRead)} of ${fmt(cache.billedPrompt)} billed prompt tokens served from cache (${cache.requests} req)`
      );
    }
  }
  lines.push("");
  if (nudge) {
    if (nudge.shouldInject) {
      const tierInfo = nudge.tier ? ` [T${nudge.tier} distillation]` : "";
      lines.push(`Nudge: ACTIVE${tierInfo} \u2014 ${nudge.reason}`);
    } else {
      lines.push(`Nudge: idle \u2014 ${nudge.reason}`);
    }
  }
  const ranges = viableRanges(nudge?.compressibleRanges ?? []);
  const protectedRanges = nudge?.protectedRanges ?? [];
  if (ranges.length > 0 || protectedRanges.length > 0) {
    lines.push("");
    lines.push(formatRanges(ranges, protectedRanges));
  }
  if (activeBlocksList.length > 0) {
    lines.push("");
    lines.push(
      `Blocks: ${activeBlocksList.length} active / ${totalBlocksList.length} total (${fmt(state.stats.tokensCompressed)} tokens compressed, cumulative)`
    );
    for (const b of activeBlocksList) {
      const topic = b.topic ? `: ${b.topic}` : `: ${topicFallback(b.summary || "")}`;
      const summaryTok = defaultCountTokens(b.summary || "");
      const origTok = b.compressedTokens > 0 ? b.compressedTokens : summaryTok;
      const ext = externalBlockIds?.has(b.blockId) ? " \u26A1ext" : "";
      lines.push(
        `  [${b.blockId}] T${b.tier} ${fmt(origTok)}\u2192${fmt(summaryTok)}${ext}${topic}`
      );
    }
  } else if (totalBlocksList.length > 0) {
    lines.push("");
    lines.push(
      `Blocks: 0 active / ${totalBlocksList.length} total (${fmt(state.stats.tokensCompressed)} tokens compressed, cumulative)`
    );
  } else {
    lines.push("");
    lines.push("Blocks: none (nothing compressed yet)");
  }
  lines.push("");
  lines.push(
    "Tag visibility: tags injected to LLM only (deep copy), not persisted in session, not shown in terminal."
  );
  return lines.join("\n");
}
export {
  buildStatusPanel,
  cacheHitStats,
  formatCompactTokens,
  formatHitRate,
  topicFallback
};
//# sourceMappingURL=index.js.map