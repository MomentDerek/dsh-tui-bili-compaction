// src/state.ts
function createInitialState() {
  return {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    tokenSnapshot: {},
    nudge: {
      lastPerMessageNudgeTokens: 0,
      lastNudgeShownTokens: 0,
      baselineTokens: 0,
      anchors: {},
      lastShownByTier: {}
    },
    stats: {
      tokensCompressed: 0,
      compressionCount: 0,
      absorbedTokens: 0,
      storedCount: 0,
      retrievalCount: 0
    },
    absorbed: [],
    rules: [],
    nextRuleId: 1,
    nextBlockId: 1,
    nextRunId: 1
  };
}
function allocateBlockId(state) {
  const id = state.nextBlockId;
  state.nextBlockId = Math.max(1, id) + 1;
  return `b${id}`;
}
function allocateRunId(state) {
  const id = state.nextRunId;
  state.nextRunId = Math.max(1, id) + 1;
  return `r${id}`;
}
function blockById(state, blockId) {
  return state.blocks.find((block) => block.blockId === blockId);
}
function activeBlocks(state) {
  return state.blocks.filter((block) => block.active);
}
function coveredMessageIds(state) {
  const covered = /* @__PURE__ */ new Set();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) covered.add(id);
  }
  return covered;
}
function isLiveCheckpointCarrier(message, state) {
  const carrierOf = message.summaryOfBlockId;
  return carrierOf !== void 0 && blockById(state, carrierOf)?.active === true;
}
function highestActiveTier(state) {
  let highest = 0;
  for (const block of state.blocks) {
    if (block.active && block.tier > highest) highest = block.tier;
  }
  return highest;
}
function advanceSurvival(state, promotionThreshold) {
  for (const block of state.blocks) {
    if (!block.active) continue;
    block.survivedCount += 1;
    if (block.survivedCount >= promotionThreshold) {
      block.generation = "old";
    }
  }
}

export {
  createInitialState,
  allocateBlockId,
  allocateRunId,
  blockById,
  activeBlocks,
  coveredMessageIds,
  isLiveCheckpointCarrier,
  highestActiveTier,
  advanceSurvival
};
//# sourceMappingURL=chunk-KW5XKWQH.js.map