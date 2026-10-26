import {
  activeBlocks,
  coveredMessageIds
} from "./chunk-KW5XKWQH.js";

// src/prune.ts
var SUMMARY_HEADER = "[Compressed conversation section]";
var SUMMARY_ID_PREFIX = "acp_summary_";
function summaryMessageId(blockId) {
  return `${SUMMARY_ID_PREFIX}${blockId}`;
}
function isSummaryMessageId(id) {
  return id.startsWith(SUMMARY_ID_PREFIX);
}
function baseIdOf(id) {
  const hash = id.indexOf("#");
  return hash > 0 ? id.substring(0, hash) : id;
}
function isCovered(id, coveredBases) {
  return coveredBases.has(baseIdOf(id));
}
function coveredSeqIntervals(state) {
  const intervals = [];
  for (const block of state.blocks) {
    if (!block.active) continue;
    if (typeof block.startSeq === "number" && typeof block.endSeq === "number" && block.endSeq >= block.startSeq) {
      intervals.push({ start: block.startSeq, end: block.endSeq });
    }
  }
  return intervals;
}
function isCoveredBySeq(seq, intervals) {
  if (typeof seq !== "number" || !Number.isInteger(seq)) return false;
  for (const interval of intervals) {
    if (seq >= interval.start && seq <= interval.end) return true;
  }
  return false;
}
function isRenderedSummaryMessage(message) {
  return isSummaryMessageId(message.id) && message.role === "system" && message.contentType === "text";
}
function prune(messages, state, options = {}) {
  const covered = coveredMessageIds(state);
  if (covered.size === 0) return [...messages];
  const coveredBases = /* @__PURE__ */ new Set();
  for (const id of covered) coveredBases.add(baseIdOf(id));
  const inject = options.injectSummaries ?? true;
  const isCompressTool = options.isCompressTool ?? ((name) => name === "compress");
  const firstUserIndex = messages.findIndex(
    (message) => message.role === "user"
  );
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  const baseIndexById = /* @__PURE__ */ new Map();
  const summaryIndexById = /* @__PURE__ */ new Map();
  messages.forEach((message, index) => {
    const base = baseIdOf(message.id);
    const existing = baseIndexById.get(base);
    if (existing === void 0 || index < existing)
      baseIndexById.set(base, index);
    if (isRenderedSummaryMessage(message))
      summaryIndexById.set(message.id, index);
  });
  const visibleCompressCallIds = /* @__PURE__ */ new Set();
  if (inject) {
    for (const message of messages) {
      if (message.contentType === "tool-call" && message.toolCallId && typeof message.toolName === "string" && isCompressTool(message.toolName)) {
        visibleCompressCallIds.add(message.toolCallId);
      }
    }
  }
  const anchors = inject ? collectSummaryAnchors(
    state,
    baseIndexById,
    summaryIndexById,
    options.headSummaryAnchors ? 0 : lastUserIndex >= 0 ? lastUserIndex : messages.length,
    visibleCompressCallIds
  ) : [];
  const knownSummaryIds = new Set(
    inject ? state.blocks.map((block) => summaryMessageId(block.blockId)) : []
  );
  return stripOrphanedReasoning(
    stripOrphanedToolResults(
      stripOrphanedToolCalls(
        rebuildMessages(
          messages,
          coveredBases,
          // #4316 layer 3: positional claims, built once per prune pass.
          coveredSeqIntervals(state),
          firstUserIndex,
          anchors,
          knownSummaryIds,
          options.headSummaryAnchors === true
        ),
        isCompressTool
      )
    )
  );
}
function collectSummaryAnchors(state, baseIndexById, summaryIndexById, fallbackIndex, visibleCompressCallIds) {
  const anchors = [];
  for (const block of activeBlocks(state)) {
    if (block.compressCallId && visibleCompressCallIds.has(block.compressCallId))
      continue;
    const existingIndex = summaryIndexById.get(summaryMessageId(block.blockId));
    if (existingIndex !== void 0) {
      anchors.push({
        blockId: block.blockId,
        summary: block.summary,
        topic: block.topic,
        insertAt: existingIndex
      });
      continue;
    }
    const anchorIds = block.directMessageIds && block.directMessageIds.length > 0 ? block.directMessageIds : block.effectiveMessageIds;
    let earliest = null;
    for (const id of anchorIds) {
      const index = baseIndexById.get(baseIdOf(id));
      if (index !== void 0 && (earliest === null || index < earliest)) {
        earliest = index;
      }
    }
    anchors.push({
      blockId: block.blockId,
      summary: block.summary,
      topic: block.topic,
      // Unresolved (no anchor id present in this input): park before the
      // newest user message — see prune() for the #3640/#2733 reasoning.
      // Tail-parking (the pre-#3640 behavior) let stale summaries land after
      // the user's current question, which the model then answered instead.
      insertAt: earliest ?? fallbackIndex,
      unresolved: earliest === null
    });
  }
  anchors.sort((left, right) => left.insertAt - right.insertAt);
  return anchors;
}
function buildAnchorPairingIndex(messages) {
  const n = messages.length;
  const resultIndexByCallId = /* @__PURE__ */ new Map();
  messages.forEach((message, at) => {
    if (message.contentType !== "tool-result") return;
    if (typeof message.toolCallId !== "string") return;
    if (!resultIndexByCallId.has(message.toolCallId)) {
      resultIndexByCallId.set(message.toolCallId, at);
    }
  });
  const runStart = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; ) {
    if (messages[i].role !== "assistant") {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && messages[j + 1].role === "assistant") j++;
    for (let k = i; k <= j; k++) runStart[k] = i;
    i = j + 1;
  }
  const prefixEnd = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const message = messages[i];
    let end = 0;
    if (message.role === "assistant" && message.contentType === "tool-call" && typeof message.toolCallId === "string") {
      const resultIndex = resultIndexByCallId.get(message.toolCallId);
      if (resultIndex !== void 0) end = resultIndex + 1;
    }
    prefixEnd[i + 1] = Math.max(prefixEnd[i], end);
  }
  return { runStart, prefixEnd };
}
function pairSafeAnchorIndex(messages, index, ix) {
  const n = messages.length;
  let safe = index;
  if (safe > 0 && safe < n) {
    const start = ix.runStart[safe];
    if (start >= 0 && messages[safe - 1].role === "assistant") {
      safe = start;
    }
  }
  if (safe < 0 || safe > n) return safe;
  for (let guard = 0; guard < n; guard++) {
    const next = Math.max(safe, ix.prefixEnd[safe]);
    if (next === safe) break;
    safe = next;
  }
  return safe;
}
var wireIndexOf = (m) => m.wireIndex;
function rebuildMessages(messages, coveredBases, seqIntervals, firstUserIndex, anchors, knownSummaryIds, headAnchors) {
  let firstUserPinEnd = firstUserIndex + 1;
  if (firstUserIndex >= 0) {
    const firstWire = wireIndexOf(messages[firstUserIndex]);
    if (firstWire !== void 0) {
      while (firstUserPinEnd < messages.length && messages[firstUserPinEnd].role === "user" && wireIndexOf(messages[firstUserPinEnd]) === firstWire) {
        firstUserPinEnd++;
      }
    }
  }
  const ix = anchors.length > 0 ? buildAnchorPairingIndex(messages) : null;
  const safeAnchors = anchors.map((anchor) => ({
    ...anchor,
    insertAt: ix ? pairSafeAnchorIndex(messages, anchor.insertAt, ix) : anchor.insertAt
  })).map((anchor) => ({
    ...anchor,
    // #2733/#3642: a summary may NEVER precede the pinned opening wire
    // message — now measured to the END of the opening core run
    // (firstUserPinEnd), so an anchor can never land between the opening
    // message's split parts either.
    insertAt: headAnchors ? anchor.insertAt : Math.max(
      anchor.insertAt,
      anchor.unresolved === true ? firstUserIndex : firstUserPinEnd
    )
  })).sort((left, right) => left.insertAt - right.insertAt);
  const result = [];
  const pending = [...safeAnchors];
  for (let index = 0; index < messages.length; index++) {
    while (pending.length > 0 && pending[0].insertAt === index) {
      result.push(renderSummary(pending.shift()));
    }
    if (index === firstUserIndex && firstUserIndex >= 0) {
      for (let k = index; k < firstUserPinEnd; k++) {
        result.push(messages[k]);
      }
      index = firstUserPinEnd - 1;
      continue;
    }
    if (isCovered(messages[index].id, coveredBases)) continue;
    if (isCoveredBySeq(messages[index].ledgerSeq, seqIntervals)) continue;
    if (isRenderedSummaryMessage(messages[index]) && knownSummaryIds.has(messages[index].id))
      continue;
    result.push(messages[index]);
  }
  while (pending.length > 0) {
    result.push(renderSummary(pending.shift()));
  }
  return result;
}
function renderSummary(anchor) {
  const body = anchor.summary.trim();
  const topicLine = anchor.topic ? `${SUMMARY_HEADER} \u2014 ${anchor.topic}` : SUMMARY_HEADER;
  const text = body.length === 0 ? topicLine : `${topicLine}
${body}`;
  return {
    id: summaryMessageId(anchor.blockId),
    role: "system",
    contentType: "text",
    text
  };
}
function stripOrphanedToolResults(messages) {
  const openCallIds = /* @__PURE__ */ new Set();
  const drop = /* @__PURE__ */ new Set();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.contentType === "tool-call") {
      if (m.toolCallId) openCallIds.add(m.toolCallId);
    } else if (m.contentType === "tool-result" && m.toolCallId) {
      if (!openCallIds.has(m.toolCallId)) drop.add(i);
    }
  }
  return drop.size === 0 ? messages : messages.filter((_, i) => !drop.has(i));
}
function stripOrphanedToolCalls(messages, isCompressTool) {
  const answeredCallIds = /* @__PURE__ */ new Set();
  const drop = /* @__PURE__ */ new Set();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.contentType === "tool-result") {
      if (m.toolCallId) answeredCallIds.add(m.toolCallId);
    } else if (m.contentType === "tool-call" && m.toolCallId) {
      if (typeof m.toolName === "string" && isCompressTool(m.toolName)) continue;
      if (!answeredCallIds.has(m.toolCallId)) drop.add(i);
    }
  }
  return drop.size === 0 ? messages : messages.filter((_, i) => !drop.has(i));
}
function stripOrphanedReasoning(messages) {
  const drop = /* @__PURE__ */ new Set();
  for (let i = 0; i < messages.length; i++) {
    if (drop.has(i)) continue;
    if (messages[i].contentType !== "reasoning") continue;
    let j = i;
    while (j + 1 < messages.length && messages[j + 1].contentType === "reasoning") {
      j++;
    }
    const companion = messages[j + 1];
    const hasCompanion = companion !== void 0 && companion.role === "assistant" && (companion.contentType === "text" || companion.contentType === "tool-call");
    if (!hasCompanion) {
      for (let k = i; k <= j; k++) drop.add(k);
    }
  }
  if (drop.size === 0) return messages;
  return messages.filter((_, i) => !drop.has(i));
}

// src/protected.ts
var ALWAYS_PROTECTED_TOOLS = ["compress", "acp_rule"];
var FAILED_COMPRESS_RESULT_PREFIXES = [
  "[Compression FAILED",
  "[Compression refused"
];
function isCompressToolName(toolName, config) {
  if (!toolName) return false;
  return toolName === "compress" || !!config?.isCompressTool?.(toolName);
}
function isFailedCompressResult(msg, config) {
  const text = msg.text ?? "";
  return msg.contentType === "tool-result" && isCompressToolName(msg.toolName, config) && FAILED_COMPRESS_RESULT_PREFIXES.some((prefix) => text.startsWith(prefix));
}
function collectFailedCompressCallIds(messages, config) {
  const ids = /* @__PURE__ */ new Set();
  for (const m of messages) {
    if (isFailedCompressResult(m, config) && m.toolCallId) ids.add(m.toolCallId);
  }
  return ids;
}
var COMPRESS_EXCHANGE_KEEP_RECENT = 3;
function collectAgedCompressCallIds(messages, config, keepRecent = COMPRESS_EXCHANGE_KEEP_RECENT) {
  const recent = [];
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId && isCompressToolName(m.toolName, config)) {
      const at = recent.indexOf(m.toolCallId);
      if (at >= 0) recent.splice(at, 1);
      recent.push(m.toolCallId);
      if (recent.length > Math.max(0, keepRecent)) recent.shift();
    }
  }
  const aged = /* @__PURE__ */ new Set();
  const keep = new Set(recent);
  for (const m of messages) {
    if (m.contentType !== "tool-call" || !m.toolCallId) continue;
    if (!isCompressToolName(m.toolName, config)) continue;
    if (!keep.has(m.toolCallId)) aged.add(m.toolCallId);
  }
  return aged;
}
var NEVER_PRESERVE_RECENT_TOOLS = [
  "decompress",
  "search_context",
  "read",
  "bash"
];
function isNeverPreserveRecent(msg, patterns, preservePatterns) {
  if (msg.contentType !== "tool-call" && msg.contentType !== "tool-result") {
    return false;
  }
  if (!msg.toolName) return false;
  const base = patterns === void 0 ? NEVER_PRESERVE_RECENT_TOOLS : patterns;
  const list = preservePatterns === void 0 || preservePatterns.length === 0 ? base : base.filter(
    (tool) => !preservePatterns.some((p) => matchToolPattern(tool, p))
  );
  for (const pattern of list) {
    if (matchToolPattern(msg.toolName, pattern)) return true;
  }
  return false;
}
function matchToolPattern(toolName, pattern) {
  const name = toolName.toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat.endsWith("*")) {
    return name.startsWith(pat.slice(0, -1));
  }
  return name === pat;
}
var SKILL_MD_ANCHOR_RE = /([A-Za-z0-9][A-Za-z0-9._-]*)(?:\\\\|\\|\/)SKILL\.md/i;
function isValidSkillName(name) {
  return name.length > 0 && name.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}
function skillNameFromCallText(text) {
  if (!text) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return void 0;
  }
  const args = parsed;
  for (const key of ["skill", "name", "command"]) {
    const value = args[key];
    if (typeof value === "string" && isValidSkillName(value)) return value;
  }
  return void 0;
}
function toolPathOf(msg) {
  const toolName = msg.toolName ?? "";
  if (!toolName || msg.contentType !== "tool-call") return toolName;
  if (toolName.toLowerCase() === "skill") {
    const name = skillNameFromCallText(msg.text);
    if (name) return `skill/${name}`;
  }
  const anchored = (msg.text ?? "").match(SKILL_MD_ANCHOR_RE)?.[1];
  if (anchored && isValidSkillName(anchored)) return `skill/${anchored}`;
  return toolName;
}
function matchToolPath(path, pattern) {
  const patSegs = pattern.toLowerCase().split("/");
  const patFirst = patSegs[0] ?? "";
  const pathFirst = path.toLowerCase().split("/")[0] ?? "";
  if (patSegs.length === 1) {
    return matchToolPattern(pathFirst, patFirst);
  }
  const pathSegs = path.toLowerCase().split("/");
  if (patSegs.length === 2 && patSegs[1] === "*") {
    return matchToolPattern(pathFirst, patFirst);
  }
  return patSegs.length === pathSegs.length && patSegs.every((seg, i) => matchToolPattern(pathSegs[i] ?? "", seg));
}
function matchToolMessagePattern(msg, pattern) {
  const toolName = msg.toolName ?? "";
  if (!toolName) return false;
  return matchToolPath(toolPathOf(msg), pattern) || matchToolPattern(toolName, pattern);
}
function virtualToolPathOf(msg, config) {
  if (msg.contentType === "tool-call" || msg.contentType === "tool-result") {
    return void 0;
  }
  return config.messagePathOf?.(msg);
}
function isMessageProtected(msg, config, failedToolCallIds) {
  if (config.isMessageProtected?.(msg)) return true;
  if (isFailedCompressResult(msg, config) || msg.toolCallId !== void 0 && failedToolCallIds?.has(msg.toolCallId) === true) {
    return false;
  }
  if (msg.contentType !== "tool-call" && msg.contentType !== "tool-result" || !msg.toolName) {
    const virtualPath = virtualToolPathOf(msg, config);
    if (virtualPath) {
      for (const pattern of config.protectedTools) {
        if (matchToolPath(virtualPath, pattern)) return true;
      }
    }
    return false;
  }
  if (ALWAYS_PROTECTED_TOOLS.includes(msg.toolName)) {
    return true;
  }
  for (const pattern of config.protectedTools) {
    if (matchToolMessagePattern(msg, pattern)) return true;
  }
  if (config.isToolProtected?.(msg.toolName, msg.text)) return true;
  return false;
}
function collectProtectedToolCallIds(messages, config) {
  const ids = /* @__PURE__ */ new Set();
  const failedCompressCallIds = collectFailedCompressCallIds(messages, config);
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId && isMessageProtected(m, config, failedCompressCallIds)) {
      ids.add(m.toolCallId);
    }
  }
  return ids;
}
function isMessageProtectedWithPairing(msg, config, protectedCallIds, failedToolCallIds) {
  if (isMessageProtected(msg, config, failedToolCallIds)) return true;
  if (msg.contentType === "tool-result" && msg.toolCallId && !isFailedCompressResult(msg, config) && // #4289: a failed compress result is never re-protected via pairing
  protectedCallIds.has(msg.toolCallId)) {
    return true;
  }
  return false;
}
function collectLatestProtected(messages, config) {
  const callIds = /* @__PURE__ */ new Set();
  const msgIds = /* @__PURE__ */ new Set();
  const patterns = config.protectedLatestTools ?? [];
  if (patterns.length === 0) return { callIds, msgIds };
  for (const pattern of patterns) {
    if (pattern.includes("/")) {
      const lastByPath = /* @__PURE__ */ new Map();
      for (const m of messages) {
        if (m.contentType === "tool-call" && m.toolName) {
          if (!matchToolMessagePattern(m, pattern)) continue;
          lastByPath.set(toolPathOf(m), m);
          continue;
        }
        const virtualPath = virtualToolPathOf(m, config);
        if (virtualPath && matchToolPath(virtualPath, pattern)) {
          lastByPath.set(virtualPath, m);
        }
      }
      for (const last2 of lastByPath.values()) {
        if (last2.toolCallId) callIds.add(last2.toolCallId);
        else msgIds.add(last2.id);
      }
      continue;
    }
    let last;
    for (const m of messages) {
      if (m.contentType === "tool-call" && m.toolName) {
        if (matchToolMessagePattern(m, pattern)) {
          last = m;
        }
        continue;
      }
      const virtualPath = virtualToolPathOf(m, config);
      if (virtualPath && matchToolPath(virtualPath, pattern)) {
        last = m;
      }
    }
    if (!last) continue;
    if (last.toolCallId) callIds.add(last.toolCallId);
    else msgIds.add(last.id);
  }
  return { callIds, msgIds };
}
function isMessageLatestProtected(msg, latest) {
  if (latest.msgIds.has(msg.id)) return true;
  if ((msg.contentType === "tool-call" || msg.contentType === "tool-result") && msg.toolCallId && latest.callIds.has(msg.toolCallId)) {
    return true;
  }
  return false;
}
function hasMediaPayload(msg) {
  const m = msg;
  if (typeof m.imageBase64 === "string" && m.imageBase64.length > 0)
    return true;
  if (m.rawOpenaiContent != null) return true;
  if (Array.isArray(m.rawOpenaiContentParts) && m.rawOpenaiContentParts.length > 0)
    return true;
  const ab = m.rawAnthropicBlock;
  if (isObjWith(ab, "type", "image")) return true;
  if (isObjWith(ab, "type", "tool_result")) {
    const content = ab.content;
    if (Array.isArray(content))
      return content.some((p) => !isObjWith(p, "type", "text"));
  }
  const abType = asObj(ab)?.type;
  if (typeof abType === "string" && abType !== "image" && abType !== "tool_result" && abType !== "redacted_thinking")
    return true;
  const item = m.rawResponsesItem;
  if (isObjWith(item, "type", "input_image")) return true;
  if (item && typeof item === "object") {
    const content = item.content;
    if (Array.isArray(content)) {
      return content.some((p) => isObjWith(p, "type", "input_image"));
    }
  }
  return false;
}
function hasUnrecoverableMediaPayload(msg) {
  const m = msg;
  if (m.rawAnthropicMessage != null)
    return !isPlainTextSystemMessage(m.rawAnthropicMessage);
  if (m.rawOpenaiMessage != null)
    return !isPlainTextSystemMessage(m.rawOpenaiMessage);
  if (m.role === "system" && m.rawResponsesItem != null)
    return !isPlainTextResponsesSystemItem(m.rawResponsesItem);
  const roc = m.rawOpenaiContent;
  if (roc != null) {
    const part = asObj(roc);
    const url = part?.type === "image_url" ? asObj(part.image_url)?.url : void 0;
    if (!isInlineDataUrl(url)) return true;
  }
  if (Array.isArray(m.rawOpenaiContentParts)) {
    for (const p of m.rawOpenaiContentParts) {
      const part = asObj(p);
      const url = part?.type === "image_url" ? asObj(part.image_url)?.url : void 0;
      if (!isInlineDataUrl(url)) return true;
    }
  }
  const ab = asObj(m.rawAnthropicBlock);
  if (ab) {
    if (ab.type === "image" && !anthropicSourceArchivable(asObj(ab.source)))
      return true;
    if (ab.type === "tool_result") {
      const content = ab.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          const blk = asObj(b);
          if (!blk || blk.type === "text") continue;
          if (blk.type === "image") {
            if (!anthropicSourceArchivable(asObj(blk.source))) return true;
            continue;
          }
          return true;
        }
      }
    }
    if (typeof ab.type === "string" && ab.type !== "image" && ab.type !== "tool_result" && ab.type !== "redacted_thinking")
      return true;
  }
  const item = asObj(m.rawResponsesItem);
  if (item) {
    const parts = [];
    if (item.type === "input_image") parts.push(item);
    for (const key of ["content", "output"]) {
      const arr = item[key];
      if (Array.isArray(arr)) {
        for (const p of arr) if (asObj(p)?.type === "input_image") parts.push(p);
      }
    }
    for (const p of parts) {
      if (!isInlineDataUrl(asObj(p)?.image_url)) return true;
    }
  }
  if (Array.isArray(m.rawGoogleParts)) {
    for (const p of m.rawGoogleParts) {
      const part = asObj(p);
      if (!part) continue;
      if (part.fileData != null || part.videoMetadata != null) return true;
      const fr = asObj(part.functionResponse);
      if (fr && Array.isArray(fr.parts)) {
        for (const np of fr.parts) {
          const sub = asObj(np);
          if (sub && (sub.fileData != null || sub.videoMetadata != null))
            return true;
        }
      }
    }
  }
  return false;
}
function anthropicSourceArchivable(source) {
  if (!source) return false;
  if (source.type === "base64") return typeof source.data === "string";
  if (source.type === "url") return isInlineDataUrl(source.url);
  return false;
}
function isPlainTextSystemMessage(raw) {
  const m = asObj(raw);
  if (!m || Object.keys(m).some((k) => k !== "role" && k !== "content"))
    return false;
  if (typeof m.content === "string") return true;
  return Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => {
    const o = asObj(b);
    return o?.type === "text" && Object.keys(o).every(
      (k) => k === "type" || k === "text" || k === "cache_control"
    );
  });
}
function isPlainTextResponsesSystemItem(raw) {
  const m = asObj(raw);
  if (!m || Object.keys(m).some(
    (k) => k !== "type" && k !== "role" && k !== "content"
  ))
    return false;
  if (typeof m.content === "string") return true;
  return Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => {
    const o = asObj(b);
    return o != null && (o.type === "input_text" || o.type === "output_text") && typeof o.text === "string" && Object.keys(o).every((k) => k === "type" || k === "text");
  });
}
function asObj(v) {
  return typeof v === "object" && v !== null ? v : void 0;
}
function isInlineDataUrl(u) {
  return typeof u === "string" && /^data:[^;,]+(?:;base64)?,.+$/i.test(u);
}
function isObjWith(v, key, value) {
  return typeof v === "object" && v !== null && v[key] === value;
}

export {
  SUMMARY_HEADER,
  summaryMessageId,
  isSummaryMessageId,
  baseIdOf,
  isCovered,
  isRenderedSummaryMessage,
  prune,
  collectFailedCompressCallIds,
  collectAgedCompressCallIds,
  isNeverPreserveRecent,
  matchToolPattern,
  toolPathOf,
  matchToolPath,
  matchToolMessagePattern,
  isMessageProtected,
  collectProtectedToolCallIds,
  isMessageProtectedWithPairing,
  collectLatestProtected,
  isMessageLatestProtected,
  hasMediaPayload,
  hasUnrecoverableMediaPayload,
  isPlainTextSystemMessage
};
//# sourceMappingURL=chunk-VTRTXHVO.js.map