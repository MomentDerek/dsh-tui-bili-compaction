import { buildKernelConfig } from './config.js';
import { SUMMARY_HEADER, activeBlocks, baseIdOf, blockById, buildStatusReport, collectBlockContent, createCore, defaultCountTokens, estimateTokensFast, formatRanges, parseBlockIdArg, parseCompressArgs, renderNudgeText, resolvePrompts, validateConfig, } from './kernel.js';
import { SessionStore } from './store.js';
import { BLOCK_SOURCE_KIND, buildKernelView, isOwnMessage, renderBlockSummary } from './session-view.js';
/**
 * Drop the drill-down rows a model must never copy.
 *
 * `renderUncompressedRanges` groups adjacent messages without skipping
 * protected ones, so a run that opens on a protected message prints a literal
 * `BLOCKED` in place of a ref. A span the kernel already flagged as
 * unresolvable is not actionable either — both would only bait the model into
 * an invalid `compress` call.
 */
function scrubRanges(text) {
    const kept = [];
    let dropped = 0;
    for (const line of text.split('\n')) {
        if (/^\s*BLOCKED\b/.test(line) || line.includes('not foldable: refs unresolvable')) {
            dropped += 1;
            continue;
        }
        kept.push(line);
    }
    if (dropped === 0)
        return text;
    kept.push(`  (${dropped} protected span(s) hidden — system/developer prompts and media cannot be folded)`);
    return kept.join('\n');
}
function describeTokens(value) {
    if (value >= 1000)
        return `${(value / 1000).toFixed(1)}K`;
    return String(value);
}
function positiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
/** Accept either `"b1"` or the tool-call argument object that wraps it. */
function blockIdArgument(raw) {
    if (typeof raw === 'string')
        return raw.trim();
    if (typeof raw !== 'object' || raw === null)
        return '';
    const record = raw;
    for (const key of ['blockId', 'block_id', 'block', 'id']) {
        const value = record[key];
        if (typeof value === 'string')
            return value.trim();
    }
    return '';
}
/**
 * The dsh-side driver around the kernel.
 *
 * The kernel owns every compression decision (which ranges are foldable, what a
 * tier means, which refs a block covers). This class only translates between
 * dsh's durable session log and the kernel's pure 3-tier LSM state:
 *
 * - `refresh` folds the append-origin log into the kernel and stores the new
 *   state, so nudges/status are always computed against the whole conversation.
 * - `compress` runs the kernel's applier, then writes one durable
 *   `surfaceOp: 'replace'` event per new block — dsh's own compaction contract,
 *   so the transcript, the token meter and the status line all stay honest.
 * - `decompress` is cache-safe: it returns the folded originals as tool output
 *   and never rewrites the prefix.
 */
export class CompactionEngine {
    config;
    core;
    store;
    options;
    constructor(options, store, core) {
        this.options = options;
        this.store = store;
        this.core = core ?? createCore();
        const base = buildKernelConfig(options);
        this.config = {
            ...base,
            isMessageProtected: (message) => {
                const kind = typeof message.toolName === 'string' ? message.toolName : '';
                return kind.length === 0 && message.role === 'system';
            },
        };
        const problems = validateConfig(this.config);
        if (problems.length > 0) {
            console.warn(`[bili-compaction] kernel config warnings: ${problems.join('; ')}`);
        }
    }
    configFor(view, modelContextLimit = this.config.modelContextLimit) {
        return {
            ...this.config,
            modelContextLimit,
            isMessageProtected: (message) => view.protectedIds.has(message.id),
        };
    }
    /**
     * Prefer the live route's advertised window over the static option. An
     * operator-pinned `modelContextLimit` stays authoritative so a deliberate
     * cap (or a route that advertises a window larger than the budget) is not
     * silently widened.
     */
    contextLimit(session) {
        if (this.options.modelContextLimitExplicit)
            return this.config.modelContextLimit;
        try {
            return positiveNumber(session.requestContext?.()?.contextWindow) ?? this.config.modelContextLimit;
        }
        catch {
            return this.config.modelContextLimit;
        }
    }
    load(session) {
        const persisted = this.store.load(session.id);
        return { state: persisted.state, contentStore: persisted.contentStore };
    }
    save(session, state, contentStore) {
        this.store.save(session.id, { version: 1, state, contentStore });
    }
    /** Measure a view the way the kernel does when dsh's meter is unavailable. */
    estimate(view) {
        let total = 0;
        for (const message of view.messages)
            total += estimateTokensFast(message.text ?? '');
        return total;
    }
    /**
     * Fold the current log into the kernel and persist the resulting state.
     * Returns the kernel's nudge decision for this step (if any).
     */
    refresh(session, measurement) {
        const synced = this.sync(session, measurement);
        return { decision: synced.decision, tokenCount: synced.tokenCount };
    }
    /**
     * Bring the persisted LSM up to date with the session log.
     *
     * Every entry point starts here: refs are minted by `processTurn`, and a
     * status or compress call on a state that never saw the current log would
     * report zero visible tokens (and reject every ref it was not told about).
     */
    sync(session, measurement, options = {}) {
        const view = buildKernelView(session);
        const persisted = this.load(session);
        const limit = this.contextLimit(session);
        const tokenCount = measurement !== undefined && typeof measurement.totalTokens === 'number'
            ? measurement.totalTokens
            : this.estimate(view);
        // `acp_status` and `decompress` are read-only with respect to the nudge:
        // letting them advance the watermark would swallow the next pre-step nudge.
        const nudgeBefore = persisted.state.nudge;
        const turn = this.core.processTurn({
            messages: view.messages,
            state: persisted.state,
            config: this.configFor(view, limit),
            tokenCount,
            renderTags: 'none',
            contentStore: persisted.contentStore,
        });
        const state = options.advanceNudge === false ? { ...turn.state, nudge: nudgeBefore } : turn.state;
        const contentStore = turn.contentStore ?? persisted.contentStore;
        this.save(session, state, contentStore);
        return {
            view,
            state,
            contentStore,
            decision: turn.nudge ?? null,
            tokenCount,
            limit,
        };
    }
    /** Render the kernel's nudge for this step, if it wants to speak. */
    nudgeText(decision) {
        if (decision === null || !decision.shouldInject)
            return null;
        const prompts = resolvePrompts(undefined, { languagePreservation: this.options.languagePreservation });
        return renderNudgeText(decision, prompts).text;
    }
    /**
     * Apply a `compress` tool call.
     *
     * Every newly created block becomes one durable surface replacement. The whole
     * batch is planned before the first append: if any block would split a dsh
     * event, span an uncovered message, or otherwise cannot be represented, the
     * call is rejected without writing a replacement and without persisting the
     * kernel state. A failed commit must never leave an active block that covers
     * messages still visible on dsh's surface.
     */
    compress(session, rawArgs, measurement) {
        const parsed = parseCompressArgs(rawArgs);
        if (!parsed.diagnostics.ok || parsed.ranges.length === 0) {
            const reasons = parsed.diagnostics.invalidReasons?.join('; ') ?? parsed.diagnostics.kind;
            return { ok: false, text: `compress rejected: ${parsed.diagnostics.kind}${reasons.length > 0 ? ` (${reasons})` : ''}. Call acp_status first to see the compressible ranges.` };
        }
        const { view, state, contentStore, limit } = this.sync(session, measurement);
        const before = new Set(state.blocks.map((block) => block.blockId));
        const config = this.configFor(view, limit);
        const applied = this.core.applyCompression({
            ranges: parsed.ranges,
            messages: view.messages,
            state,
            config,
        });
        const created = activeBlocks(applied.state).filter((block) => !before.has(block.blockId));
        const warnings = applied.result.warnings.length > 0 ? `\nWarnings: ${applied.result.warnings.join('; ')}` : '';
        const errors = applied.result.errors.length > 0 ? `\nErrors: ${applied.result.errors.join('; ')}` : '';
        if (created.length === 0) {
            // Refolds update an existing block without creating a new one; persist
            // those, but do not report a fold.
            this.save(session, applied.state, contentStore);
            return {
                ok: false,
                text: `No new block was created. Check that the refs are inside the ranges acp_status advertised.${warnings}${errors}`,
            };
        }
        // Group every kernel core id by its dsh event. A dsh assistant message is
        // one event containing reasoning + text + tool-call cores; a block may only
        // shadow the event if it covers ALL of those cores, otherwise the sibling
        // cores disappear without being summarized.
        const coresByBase = new Map();
        for (const message of view.messages) {
            const base = baseIdOf(message.id);
            let ids = coresByBase.get(base);
            if (ids === undefined) {
                ids = new Set();
                coresByBase.set(base, ids);
            }
            ids.add(message.id);
        }
        const plans = [];
        const problems = new Map();
        for (const block of created) {
            const planned = this.planCommit(session, view, block, coresByBase);
            if ('problem' in planned)
                problems.set(block.blockId, planned.problem);
            else
                plans.push(planned);
        }
        if (problems.size > 0) {
            const lines = created.map((block) => {
                const problem = problems.get(block.blockId);
                return problem === undefined
                    ? `- ${block.blockId} ${block.startRef}–${block.endRef}: NOT committed — batch rejected because another block in this call could not be committed`
                    : `- ${block.blockId} ${block.startRef}–${block.endRef}: NOT committed — ${problem}`;
            });
            return {
                ok: false,
                text: `Compressed 0 range(s):\n${lines.join('\n')}\nNo durable replacement was written and the kernel state was not saved; retry with ranges that cover each message completely.${warnings}${errors}`,
            };
        }
        const committed = [];
        for (const plan of plans) {
            try {
                session.append('user/message', {
                    id: `acp_block_${plan.block.blockId}`,
                    role: 'user',
                    content: [{ type: 'text', text: plan.text }],
                    source: { kind: BLOCK_SOURCE_KIND, blockId: plan.block.blockId },
                }, { surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq }, sourceEventSeqs: plan.shadowed });
                committed.push(plan.block);
            }
            catch (error) {
                problems.set(plan.block.blockId, error instanceof Error ? error.message : String(error));
            }
        }
        const allCommitted = committed.length === created.length;
        if (allCommitted) {
            this.save(session, applied.state, contentStore);
        }
        else if (committed.length > 0) {
            // Keep the replacements that did land, but drop every block that did not
            // so its messages stay compressible on the next call.
            this.save(session, this.stateAfterCommitFailure(applied.state, before, committed, created), contentStore);
        }
        const lines = created.map((block) => {
            const problem = problems.get(block.blockId);
            return problem === undefined
                ? `- ${block.blockId} ${block.startRef}–${block.endRef} (tier ${block.tier}, ${describeTokens(block.compressedTokens)} tokens folded${block.topic === undefined ? '' : `, topic: ${block.topic}`})`
                : `- ${block.blockId} ${block.startRef}–${block.endRef}: NOT committed — ${problem}`;
        });
        const usage = measurement === undefined ? '' : `\nContext is now ${describeTokens(measurement.totalTokens)} tokens (${Math.round((measurement.totalTokens / limit) * 100)}% of ${describeTokens(limit)}).`;
        const body = allCommitted
            ? `Compressed ${created.length} range(s):\n${lines.join('\n')}${usage}`
            : `Compressed ${committed.length} of ${created.length} range(s):\n${lines.join('\n')}${usage}`;
        return { ok: allCommitted && errors.length === 0, text: `${body}${warnings}${errors}` };
    }
    /**
     * Validate one durable replacement without writing it.
     *
     * The critical check is not just "does the block cover the event's base id":
     * the block must cover every kernel core id of that event. `assignRefs` gives
     * each core its own ref (same `ledgerSeq`, different free ref), so a range can
     * legitimately select only one core; committing it would shadow the whole
     * event and silently drop the unselected siblings.
     */
    planCommit(session, view, block, coresByBase) {
        const coveredIds = new Set(block.effectiveMessageIds);
        const coveredBases = new Set();
        for (const id of coveredIds)
            coveredBases.add(baseIdOf(id));
        const surface = session.surface.nodes;
        let minSeq = Number.POSITIVE_INFINITY;
        let maxSeq = Number.NEGATIVE_INFINITY;
        for (const id of block.effectiveMessageIds) {
            const seq = view.seqOf.get(id);
            if (seq === undefined)
                continue;
            if (seq < minSeq)
                minSeq = seq;
            if (seq > maxSeq)
                maxSeq = seq;
        }
        if (!Number.isFinite(minSeq) || !Number.isFinite(maxSeq)) {
            return { problem: 'no surface sequence is mapped to this block' };
        }
        const shadowed = [];
        for (const seq of surface)
            if (seq >= minSeq && seq <= maxSeq)
                shadowed.push(seq);
        if (shadowed.length === 0)
            return { problem: 'the block covers no currently visible message' };
        const startSeq = shadowed[0];
        const endSeq = shadowed[shadowed.length - 1];
        if (startSeq === undefined || endSeq === undefined)
            return { problem: 'the block covers no currently visible message' };
        for (const seq of shadowed) {
            const event = session.eventAt(seq);
            const message = session.deriveEventMessage(event);
            if (message === null || message === undefined)
                return { problem: `visible node #${seq} derives no message` };
            if (isOwnMessage(message))
                continue;
            const base = typeof message.id === 'string' ? message.id : undefined;
            if (base === undefined)
                return { problem: `visible node #${seq} has no durable message id` };
            if (!coveredBases.has(base)) {
                return { problem: `the span contains ${base} which this block does not cover; compress a narrower range` };
            }
            const expected = coresByBase.get(base);
            if (expected !== undefined) {
                const missing = [...expected].filter((id) => !coveredIds.has(id));
                if (missing.length > 0) {
                    return {
                        problem: `the span contains ${base} but this block covers only part of its content (missing ${missing.join(', ')}); compress a range that covers every content block of ${base}`,
                    };
                }
            }
        }
        return {
            block,
            startSeq,
            endSeq,
            shadowed,
            text: renderBlockSummary(SUMMARY_HEADER, block.summary, block.topic),
        };
    }
    /**
     * Best-effort state for a partially written batch (an unexpected append
     * failure, after every plan validated). Blocks that landed are kept; blocks
     * that did not are removed so their messages do not look covered.
     */
    stateAfterCommitFailure(applied, before, committed, created) {
        const kept = new Set(committed.map((block) => block.blockId));
        const failed = created.filter((block) => !kept.has(block.blockId));
        const failedConsumed = new Set(failed.flatMap((block) => block.directBlockIds));
        const committedConsumed = new Set(committed.flatMap((block) => block.directBlockIds));
        const blocks = applied.blocks
            .filter((block) => before.has(block.blockId) || kept.has(block.blockId))
            .map((block) => failedConsumed.has(block.blockId) && !committedConsumed.has(block.blockId) ? { ...block, active: true } : block);
        return { ...applied, blocks };
    }
    /** Cache-safe decompress: return the folded originals as tool output. */
    decompress(session, rawBlockId, full = false) {
        // Reconcile with the log first: a block may have been committed by this
        // process but the cached/persisted view is stale after a restart or reload.
        const synced = this.sync(session, undefined, { advanceNudge: false });
        const requested = blockIdArgument(rawBlockId);
        const blockId = parseBlockIdArg(requested) ?? requested;
        if (blockId.length === 0)
            return 'decompress: pass a blockId such as "b00012" (see acp_status).';
        const block = blockById(synced.state, blockId);
        if (block === undefined) {
            const known = synced.state.blocks.map((entry) => entry.blockId).join(', ');
            return `decompress: unknown block "${requested}". Known blocks: ${known.length === 0 ? '(none)' : known}`;
        }
        const collected = collectBlockContent(synced.state, block, synced.view.messages, { full });
        if (collected.count === 0)
            return `decompress: ${block.blockId} covers no messages in the current log.`;
        return `decompress ${block.blockId} (${collected.count} item(s), tier ${block.tier}${full ? ', all tiers' : ', one tier up'}):\n\n${collected.text}`;
    }
    /**
     * The refs the model may fold right now.
     *
     * This is the kernel's own recommendation (the same list a nudge advertises),
     * not its `uncompressed` drill-down: the drill-down reports raw visible spans,
     * and a span that starts at a protected message renders as `BLOCKED–m000NN`,
     * which is not a usable ref. Protected spans are listed by `formatRanges` as
     * protected instead, so every ref printed here can actually be compressed.
     *
     * The kernel folds the append-origin log, but dsh's surface can also be
     * rewritten by another compactor (or by an earlier native fold). A range whose
     * messages are no longer surface nodes is not compressible: `commit` would
     * reject it after the model already paid for a summary. Filter those spans
     * here so `acp_status` only advertises refs that are still on the surface.
     */
    rangeList(decision, state, view, session) {
        if (decision === null)
            return 'Compressible ranges: unavailable (no kernel decision for this turn).';
        const visible = new Set(session.surface.nodes);
        const refVisible = (ref) => {
            const raw = state.messageRefs.byRef[ref];
            if (raw === undefined)
                return false;
            const seq = view.seqOf.get(raw);
            return seq !== undefined && visible.has(seq);
        };
        const rangeVisible = (range) => {
            if (typeof range.startIndex === 'number' && typeof range.endIndex === 'number') {
                for (let index = range.startIndex; index <= range.endIndex; index += 1) {
                    const message = view.messages[index];
                    if (message === undefined)
                        return false;
                    const seq = view.seqOf.get(message.id);
                    if (seq === undefined || !visible.has(seq))
                        return false;
                }
                return true;
            }
            return refVisible(range.startRef) && refVisible(range.endRef);
        };
        const compressible = decision.compressibleRanges.filter(rangeVisible);
        const protectedRanges = (decision.protectedRanges ?? []).filter(rangeVisible);
        const hidden = decision.compressibleRanges.length -
            compressible.length +
            (decision.protectedRanges?.length ?? 0) -
            protectedRanges.length;
        const text = formatRanges(compressible, protectedRanges);
        return hidden === 0 ? text : `${text}\n  (${hidden} range(s) hidden — no longer on the current dsh surface)`;
    }
    /**
     * Kernel status report, plus dsh's measured surface size when available.
     *
     * With no query this prints the overview followed by the compressible ranges:
     * the kernel only advertises ranges through its nudge (which is threshold
     * gated), but the model needs concrete refs the moment it decides to fold.
     */
    status(session, measurement, query = {}) {
        const synced = this.sync(session, measurement, { advanceNudge: false });
        const config = this.configFor(synced.view, synced.limit);
        const base = { config, originalMessages: synced.view.messages };
        const report = query.scope === undefined
            ? [
                buildStatusReport(synced.state, synced.view.messages, defaultCountTokens, base),
                this.rangeList(synced.decision, synced.state, synced.view, session),
            ].join('\n\n')
            : scrubRanges(buildStatusReport(synced.state, synced.view.messages, defaultCountTokens, { ...base, ...query }));
        if (measurement === undefined)
            return report;
        const usage = measurement.totalTokens;
        const pct = Math.round((usage / synced.limit) * 100);
        return `dsh surface: ${describeTokens(usage)} tokens (${pct}% of ${describeTokens(synced.limit)}), ${synced.view.messages.length} messages in the append-origin log.\n\n${report}`;
    }
    /** Reset the LSM for a session (used by tests and by a manual `acp_reset`). */
    reset(session) {
        // The durable log still contains `acp_block_bNNNNN` ids. Reusing b00001
        // would append a second message with the same id, so resume the allocator
        // above every checkpoint already present in this session.
        let nextBlockId = 1;
        for (let seq = 0; seq < session.seq; seq += 1) {
            const message = session.deriveEventMessage(session.eventAt(seq));
            if (message === null || message === undefined)
                continue;
            const source = message.source;
            const id = typeof source?.blockId === 'string' ? source.blockId : message.id;
            const match = typeof id === 'string' ? /^acp_block_b(\d+)$/.exec(id) ?? /^b(\d+)$/.exec(id) : null;
            if (match !== null)
                nextBlockId = Math.max(nextBlockId, Number(match[1]) + 1);
        }
        // One atomic write: reset-then-save would immediately rename over the file
        // it just created, which is flaky on Windows (EPERM).
        this.store.reset(session.id, nextBlockId);
    }
}
//# sourceMappingURL=engine.js.map