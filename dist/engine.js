import { buildKernelConfig, resolveGrowthGate } from './config.js';
import { SUMMARY_HEADER, activeBlocks, baseIdOf, blockById, buildStatusReport, collectBlockContent, createCore, defaultCountTokens, estimateTokensFast, formatRanges, parseBlockIdArg, parseCompressArgs, renderNudgeText, resolvePrompts, validateConfig, } from './kernel.js';
import { SessionStore } from './store.js';
import { BLOCK_SOURCE_KIND, buildKernelView, isOwnMessage, renderBlockSummary } from './session-view.js';
/** One contiguous positional span a single durable replacement can shadow. */
/** How much of a summary a later segment repeats; a fold split N ways must not cost N copies. */
const SEGMENT_REPEAT_CHARS = 600;
const AUTO_FOLD_HEADER = 'This checkpoint was written automatically by bili-compaction because the visible context crossed its fold threshold. ' +
    'It condenses the oldest visible messages with a deterministic digest (user requests verbatim, assistant text and tool names ' +
    'shortened); the messages after it are untouched.';
/** Digest cap: the checkpoint must cost far less than what it replaces. */
const AUTO_FOLD_DIGEST_CAP = 12_000;
function textOfBlocks(blocks) {
    let text = '';
    for (const block of blocks) {
        const value = block.text;
        if (typeof value === 'string')
            text += value;
    }
    return text;
}
function contentLength(message) {
    return textOfBlocks(message.content).length;
}
/**
 * Injected context that only looks like a user message: keeping these in the
 * digest wastes the budget on clock stamps and registry notices a resumed
 * reader cannot use.
 */
const DIGEST_NOISE_SOURCES = new Set([
    'time-context',
    'runtime-context',
    'tool-registry',
    'skill-catalog',
    'system-prompt',
    'bili-compaction-nudge',
]);
/**
 * A degenerate turn is one short line repeated until the budget runs out. Copying
 * it into the digest verbatim is how a repetition loop survives compaction and
 * gets re-read as a style guide, so collapse runs and drop turns that are almost
 * entirely one line.
 */
function condenseRepeats(text) {
    const raw = text.split('\n').filter((line) => line.trim().length > 0);
    if (raw.length === 0)
        return '';
    const keys = raw.map((line) => line.trim());
    // Only an exact single-line loop is worthless. Two alternating lines can be a
    // Yes/No column or a table, and dropping it would lose real content.
    if (raw.length >= 8 && new Set(keys).size === 1)
        return `（${raw.length} 行重复内容，省略）`;
    const out = [];
    let last;
    let count = 0;
    let first = '';
    const flush = () => {
        if (count > 0)
            out.push(count > 1 ? `${first} ×${count}` : first);
        count = 0;
    };
    for (let index = 0; index < raw.length; index += 1) {
        const key = keys[index] ?? '';
        if (key === last) {
            count += 1;
            continue;
        }
        flush();
        last = key;
        first = raw[index] ?? '';
        count = 1;
    }
    flush();
    return out.join('\n');
}
function segmentText(text, index, total, blockId) {
    if (index === 0)
        return text;
    const head = `(segment ${index + 1}/${total} of ${blockId})`;
    const body = text.length <= SEGMENT_REPEAT_CHARS ? text : `${text.slice(0, SEGMENT_REPEAT_CHARS)}…`;
    return `${head}\n\n${body}`;
}
function digestMessages(messages) {
    const lines = [];
    let pendingTools = new Map();
    const flushTools = () => {
        if (pendingTools.size === 0)
            return;
        const parts = [...pendingTools.entries()]
            .sort((left, right) => right[1] - left[1])
            .map(([name, count]) => `${name}×${count}`);
        lines.push(`- 工具序列：${parts.join(' · ')}`);
        pendingTools = new Map();
    };
    for (const message of messages) {
        const kind = typeof message.source?.kind === 'string' ? message.source.kind : '';
        if (DIGEST_NOISE_SOURCES.has(kind))
            continue;
        const role = String(message.role);
        const text = textOfBlocks(message.content).trim();
        if (role === 'user') {
            flushTools();
            if (text.length > 0)
                lines.push(`- 用户：${text.slice(0, 800)}`);
            continue;
        }
        if (role !== 'assistant')
            continue;
        const toolNames = [];
        for (const block of message.content) {
            if (String(block.type) !== 'tool-call')
                continue;
            const name = block.name;
            toolNames.push(typeof name === 'string' ? name : 'tool');
        }
        if (text.length > 0) {
            flushTools();
            const tail = toolNames.length === 0 ? '' : ` ${toolNames.map((name) => `[${name}]`).join('')}`;
            lines.push(`- 助手：${`${condenseRepeats(text)}${tail}`.slice(0, 320)}`);
        }
        else {
            // A step that only ran tools says nothing written down; summarize the
            // run instead of spending a line per call on `[pwsh]`.
            for (const name of toolNames)
                pendingTools.set(name, (pendingTools.get(name) ?? 0) + 1);
        }
    }
    flushTools();
    if (lines.length === 0)
        return '(no summarizable text in this range)';
    const body = lines.join('\n');
    if (body.length <= AUTO_FOLD_DIGEST_CAP)
        return body;
    // Over budget: keep both ends. The oldest lines explain how the work started
    // and the newest ones say where it stands, which is what a resumed reader
    // needs most; the middle is the part that can go.
    const headLength = Math.floor(AUTO_FOLD_DIGEST_CAP * 0.6);
    const tailLength = AUTO_FOLD_DIGEST_CAP - headLength - 20;
    return `${body.slice(0, headLength)}\n\n…（中段省略）…\n\n${body.slice(body.length - tailLength)}`;
}
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
        // The growth gate scales with the live window, not with the 1M default
        // baked into this.config, so a 200K route is not held to a 1M floor.
        const growth = resolveGrowthGate(this.config.nudge, modelContextLimit);
        return {
            ...this.config,
            modelContextLimit,
            nudge: { ...this.config.nudge, ...growth },
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
     *
     * `advanceNudge` must stay false when the caller will not deliver the nudge
     * to the model: the kernel's watermark means "the model has been told", so
     * advancing it without delivering swallows the compression prompt and the
     * next real nudge never looks new.
     */
    refresh(session, measurement, options = {}) {
        const synced = this.sync(session, measurement, options);
        return { decision: this.nudgeDecision(session, synced), tokenCount: synced.tokenCount };
    }
    /**
     * Model-free automatic folding, for hosts that want the request kept small
     * without waiting for the model to answer a nudge.
     *
     * When the measured surface is over `autoFold.triggerPct` of the window, the
     * oldest still-visible messages are condensed into ONE durable
     * `surfaceOp: 'replace'` checkpoint whose summary is assembled from the
     * messages themselves (user text verbatim, assistant text/tool names as
     * snippets). Nothing is written unless the fold actually brings the surface
     * back toward `autoFold.targetPct`, so a pathological conversation cannot be
     * rewritten on every step.
     */
    autoFold(session, measurement) {
        const { enabled, triggerPct, targetPct } = this.options.autoFold;
        if (!enabled)
            return null;
        const tokens = measurement?.totalTokens;
        if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0)
            return null;
        const synced = this.sync(session, measurement, { advanceNudge: false });
        const limit = synced.limit;
        if (tokens <= limit * triggerPct)
            return null;
        const visible = [];
        for (const seq of session.surface.nodes) {
            const event = session.eventAt(seq);
            if (event === undefined)
                continue;
            const message = session.deriveEventMessage(event);
            if (message === null || message === undefined)
                continue;
            // Our own checkpoints stay visible: folding a summary into a summary is
            // how repeated auto-folds would erase the conversation.
            if (isOwnMessage(message))
                continue;
            const role = String(message.role);
            if (role === 'system' || role === 'developer')
                continue;
            visible.push({ seq, role, message, chars: contentLength(message) });
        }
        if (visible.length < 12)
            return null;
        const totalChars = visible.reduce((sum, node) => sum + node.chars, 0);
        if (totalChars === 0)
            return null;
        const charsPerToken = totalChars / tokens;
        // Never fold the exchange the model is working in: keep at least the
        // kernel's protected tail (messages + tokens) verbatim.
        let tailChars = 0;
        let tailNodes = 0;
        for (let index = visible.length - 1; index >= 0; index -= 1) {
            const node = visible[index];
            if (node === undefined)
                break;
            if (tailNodes >= Math.max(2, this.config.preserveRecentMessages) &&
                tailChars >= this.config.preserveRecentTokens * charsPerToken) {
                break;
            }
            tailChars += node.chars;
            tailNodes += 1;
        }
        const targetChars = Math.max(Math.floor(limit * targetPct * charsPerToken), tailChars);
        const need = totalChars - targetChars;
        // A fold that reclaims less than a fifth of the surface would just churn
        // the prompt cache; wait for more growth instead.
        if (need <= totalChars * 0.2)
            return null;
        let removed = 0;
        let cut = -1;
        const foldable = Math.max(1, visible.length - tailNodes);
        for (let index = 0; index < foldable; index += 1) {
            const node = visible[index];
            if (node === undefined)
                break;
            removed += node.chars;
            const next = visible[index + 1];
            // Never leave a tool result without its assistant tool-call in front of
            // it: the next kept message must not be a bare tool result.
            if (removed >= need && next !== undefined && next.role !== 'tool') {
                cut = index + 1;
                break;
            }
        }
        if (cut <= 0)
            return null;
        const folded = visible.slice(0, cut);
        const first = folded[0];
        const last = folded[folded.length - 1];
        if (first === undefined || last === undefined)
            return null;
        const foldedChars = folded.reduce((sum, node) => sum + node.chars, 0);
        const keptChars = totalChars - foldedChars;
        const digest = digestMessages(folded.map((node) => node.message));
        const text = `${AUTO_FOLD_HEADER}\n\n<compacted-summary>\n${digest}\n</compacted-summary>`;
        const startSeq = first.seq;
        const endSeq = last.seq;
        try {
            session.append('user/message', {
                id: `bili_autofold_${startSeq}`,
                role: 'user',
                content: [{ type: 'text', text }],
                source: { kind: BLOCK_SOURCE_KIND, blockId: `auto-${startSeq}` },
            }, { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: folded.map((node) => node.seq) });
        }
        catch (error) {
            return {
                folded: 0,
                foldedChars: 0,
                keptChars: totalChars,
                error: error instanceof Error ? error.message : String(error),
                text: '',
            };
        }
        return {
            folded: folded.length,
            foldedChars,
            keptChars,
            text: `autoFold: condensed ${folded.length} message(s) (${describeTokens(Math.round(foldedChars / charsPerToken))} tokens) into one checkpoint; ~${describeTokens(Math.round(keptChars / charsPerToken))} tokens remain visible.`,
        };
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
     * Every newly created block becomes one durable surface replacement. A block
     * that cannot be represented (it splits a dsh event, covers no visible
     * message, or cites a span an earlier fold already shadowed) is reported and
     * skipped; the rest of the batch still commits. Only when nothing lands is the
     * kernel state left unsaved, so a failed commit can never leave an active block
     * that covers messages still visible on dsh's surface.
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
            const planned = this.planCommit(session, view, block, coresByBase, applied.state);
            if ('problem' in planned)
                problems.set(block.blockId, planned.problem);
            else
                plans.push(block);
        }
        // Plan failures are per-block, not per-call. One span that splits a message
        // (or was already folded) must not discard the spans that would commit
        // cleanly — the previous all-or-nothing return meant a single bad range
        // turned the whole call into "Compressed 0 range(s)" and left the model to
        // retry everything by hand.
        const committed = [];
        const partialIds = new Set();
        for (const block of plans) {
            let landed = 0;
            let total = 0;
            try {
                // Re-plan against the live surface. Earlier blocks in this batch already
                // landed, and each of them replaced its span with one node whose seq is
                // the log tail. A span planned before those writes can therefore cite a
                // node set that no longer matches what dsh will shadow, which is the
                // batch-order half of the "not compressible" failures.
                const plan = this.planCommit(session, view, block, coresByBase, applied.state);
                if ('problem' in plan)
                    throw new Error(plan.problem);
                total = plan.segments.length;
                for (const [index, segment] of plan.segments.entries()) {
                    session.append('user/message', {
                        // dsh keeps one node per replacement, so a split block writes one
                        // node per segment; the block id stays shared for decompress.
                        id: `acp_block_${block.blockId}_${index}`,
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: segmentText(plan.text, index, total, block.blockId),
                            },
                        ],
                        source: { kind: BLOCK_SOURCE_KIND, blockId: block.blockId },
                    }, {
                        surfaceOp: { op: 'replace', startSeq: segment.startSeq, endSeq: segment.endSeq },
                        sourceEventSeqs: segment.shadowed,
                    });
                    landed += 1;
                }
                committed.push(block);
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                if (landed > 0 && landed < total) {
                    // The originals behind the failed segments are still on the surface,
                    // and this is the last moment they can be shadowed: once the kernel
                    // saves the block, it believes the whole range is folded and no later
                    // compress call will plan them again. Retry the remainder once — an
                    // append failure is usually transient — and report it if it is not.
                    try {
                        const repair = this.planCommit(session, view, block, coresByBase, applied.state);
                        if (!('problem' in repair)) {
                            for (const [index, segment] of repair.segments.entries()) {
                                session.append('user/message', {
                                    id: `acp_block_${block.blockId}_r${index}`,
                                    role: 'user',
                                    content: [
                                        { type: 'text', text: segmentText(repair.text, index, repair.segments.length, block.blockId) },
                                    ],
                                    source: { kind: BLOCK_SOURCE_KIND, blockId: block.blockId },
                                }, {
                                    surfaceOp: { op: 'replace', startSeq: segment.startSeq, endSeq: segment.endSeq },
                                    sourceEventSeqs: segment.shadowed,
                                });
                            }
                            committed.push(block);
                            continue;
                        }
                    }
                    catch {
                        // The repair failed too; fall through and keep the block so the
                        // segments that did land are not stranded in the kernel view.
                    }
                    committed.push(block);
                    partialIds.add(block.blockId);
                    problems.set(block.blockId, `${reason} (partial: ${landed} of ${total} segments landed; the remaining originals stay visible but are already counted as folded, so acp_reset is the only way to reclaim them)`);
                }
                else {
                    problems.set(block.blockId, reason);
                }
            }
        }
        const allCommitted = committed.length === created.length && partialIds.size === 0;
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
            if (problem === undefined) {
                return `- ${block.blockId} ${block.startRef}–${block.endRef} (tier ${block.tier}, ${describeTokens(block.compressedTokens)} tokens folded${block.topic === undefined ? '' : `, topic: ${block.topic}`})`;
            }
            const label = partialIds.has(block.blockId) ? 'PARTIAL' : 'NOT committed';
            return `- ${block.blockId} ${block.startRef}–${block.endRef}: ${label} — ${problem}`;
        });
        const usage = measurement === undefined ? '' : `\nContext is now ${describeTokens(measurement.totalTokens)} tokens (${Math.round((measurement.totalTokens / limit) * 100)}% of ${describeTokens(limit)}).`;
        const body = allCommitted
            ? `Compressed ${created.length} range(s):\n${lines.join('\n')}${usage}`
            : `Compressed ${committed.length - partialIds.size} of ${created.length} range(s):\n${lines.join('\n')}${usage}`;
        const skipped = created.length - (committed.length - partialIds.size);
        const footer = committed.length === 0
            ? '\nNo durable replacement was written and the kernel state was not saved; retry with ranges that cover each message completely.'
            : skipped > 0
                ? `\n${skipped} range(s) were skipped; their messages stay compressible for a later call.`
                : '';
        return { ok: allCommitted && errors.length === 0, text: `${body}${footer}${warnings}${errors}` };
    }
    /**
     * Validate one durable replacement without writing it.
     *
     * dsh's surface is a *positional* fold: `replacementRange` locates `startSeq`
     * and `endSeq` with `indexOf` and slices by index, and a landed replacement
     * keeps the seq it was appended with (always the log tail) while sitting at
     * the index it replaced. Surface seq numbers are therefore not monotonic, and
     * any seq *value* range is the wrong model: a re-fold that straddles an older
     * checkpoint always contains a node whose seq is far outside `[minSeq,
     * maxSeq]`, which the kernel then reports as `sourceEventSeqs must include
     * every shadowed surface node`. Plan by index instead.
     *
     * The second half of the check is informational: a span may contain a node
     * this block does not cover. dsh can only shadow one contiguous run, so the
     * node splits the span into segments that are committed separately. The block
     * still opens only on messages it covers, and every segment cites exactly the
     * nodes it will shadow.
     */
    planCommit(session, view, block, coresByBase, state) {
        const coveredIds = new Set(block.effectiveMessageIds);
        const coveredBases = new Set();
        for (const id of coveredIds)
            coveredBases.add(baseIdOf(id));
        const nodes = session.surface.nodes;
        const positionOf = new Map();
        for (let index = 0; index < nodes.length; index += 1) {
            const seq = nodes[index];
            if (seq !== undefined)
                positionOf.set(seq, index);
        }
        let firstIndex = Number.POSITIVE_INFINITY;
        let lastIndex = Number.NEGATIVE_INFINITY;
        for (const id of block.effectiveMessageIds) {
            const seq = view.seqOf.get(id);
            if (seq === undefined)
                continue;
            const index = positionOf.get(seq);
            if (index === undefined)
                continue;
            if (index < firstIndex)
                firstIndex = index;
            if (index > lastIndex)
                lastIndex = index;
        }
        if (!Number.isFinite(firstIndex) || !Number.isFinite(lastIndex) || lastIndex < firstIndex) {
            return { problem: 'the block covers no currently visible message' };
        }
        const segments = [];
        let current = [];
        const flush = () => {
            const head = current[0];
            const tail = current[current.length - 1];
            if (head !== undefined && tail !== undefined)
                segments.push({ startSeq: head, endSeq: tail, shadowed: [...current] });
            current = [];
        };
        for (const seq of nodes.slice(firstIndex, lastIndex + 1)) {
            const event = session.eventAt(seq);
            const message = session.deriveEventMessage(event);
            if (message === null || message === undefined)
                return { problem: `visible node #${seq} derives no message` };
            if (isOwnMessage(message)) {
                // Only this block's own earlier segments may be folded again: their
                // originals are still in the kernel store, so rewriting them loses
                // nothing. Any other checkpoint or nudge stays visible. Swallowing one
                // would delete its summary from the surface while the kernel still
                // treats the originals it covers as compressed, so the new summary is
                // the only copy left — and it was written without seeing them.
                const owner = message.source?.blockId;
                if (owner === block.blockId) {
                    current.push(seq);
                    continue;
                }
                flush();
                continue;
            }
            const base = typeof message.id === 'string' ? message.id : undefined;
            if (base === undefined)
                return { problem: `visible node #${seq} has no durable message id` };
            if (!coveredBases.has(base)) {
                // Protected tail, withdrawn tool-call pair or a foreign message: it stays
                // visible, so the current segment ends before it and the next one opens
                // after it. Refusing the whole block here is exactly what made large
                // re-folds look "not compressible".
                flush();
                continue;
            }
            const expected = coresByBase.get(base);
            if (expected !== undefined) {
                const missing = [...expected].filter((id) => !coveredIds.has(id));
                if (missing.length > 0) {
                    // The core ids are opaque (`<messageId>#<contentIndex>`); print their
                    // message refs too so the next call can copy a usable range instead of
                    // guessing which sibling it left out.
                    const refs = missing
                        .map((id) => state?.messageRefs.byRaw[id])
                        .filter((ref) => ref !== undefined);
                    const hint = refs.length === missing.length ? ` — refs ${refs.join(', ')}` : '';
                    return {
                        problem: `the span contains ${base} but this block covers only part of its content (missing ${missing.join(', ')})${hint}; compress a range that covers every content block of ${base}`,
                    };
                }
            }
            current.push(seq);
        }
        flush();
        if (segments.length === 0)
            return { problem: 'the block covers no currently visible message' };
        return {
            block,
            segments,
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
        // The kernel already counted every block it created, including the ones
        // that were skipped here; un-count them so `stats` describes what the log
        // actually contains (and so the saved state log line is truthful).
        const skippedTokens = failed.reduce((sum, block) => sum + block.compressedTokens, 0);
        const stats = failed.length === 0
            ? applied.stats
            : {
                ...applied.stats,
                tokensCompressed: Math.max(0, applied.stats.tokensCompressed - skippedTokens),
                compressionCount: Math.max(0, applied.stats.compressionCount - failed.length),
            };
        return { ...applied, blocks, stats };
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
     * The ranges a nudge may advertise.
     *
     * The kernel recommends core-level spans (one per content block), while
     * `compress` commits against dsh's positional surface: a replacement can only
     * shadow a contiguous run of whole messages, and only while those messages
     * are still visible. Rendering the kernel list verbatim therefore advertises
     * spans the commit path has to reject: an endpoint that splits an assistant
     * message into its text/reasoning cores, or a span an earlier fold already
     * shadowed. Align every endpoint to its whole message, drop what the surface
     * cannot show, and suppress a nudge that has nothing left to offer.
     */
    nudgeDecision(session, synced) {
        const decision = synced.decision;
        if (decision === null)
            return null;
        const visible = new Set(session.surface.nodes);
        // Expanding an endpoint to its whole message may pull in a protected
        // sibling core (the preserve-recent window can start mid-message). Those
        // spans are dropped instead of being advertised and then split at commit.
        const blockedSeqs = new Set();
        for (const range of decision.protectedRanges ?? []) {
            for (const id of this.rangeCoreIds(range, synced.state, synced.view)) {
                const seq = synced.view.seqOf.get(id);
                if (seq !== undefined)
                    blockedSeqs.add(seq);
            }
        }
        const bounds = this.messageBounds(synced.view);
        const ranges = [];
        for (const candidate of decision.compressibleRanges) {
            const aligned = this.alignRange(candidate, synced.state, synced.view, bounds);
            if (aligned === null)
                continue;
            if (this.rangeOnSurface(aligned, synced.view, visible, blockedSeqs))
                ranges.push(aligned);
        }
        const protectedRanges = (decision.protectedRanges ?? []).filter((range) => this.rangeOnSurface(range, synced.view, visible, new Set()));
        const tierWork = (decision.tierTargetBlocks?.length ?? 0) > 0;
        if (ranges.length === 0 && decision.shouldInject && !tierWork) {
            return { ...decision, shouldInject: false, compressibleRanges: [], protectedRanges };
        }
        return { ...decision, compressibleRanges: ranges, protectedRanges };
    }
    /** Kernel core ids behind one advertised span, in message order. */
    rangeCoreIds(range, state, view) {
        const start = range.startIndex;
        const end = range.endIndex;
        if (typeof start === 'number' && typeof end === 'number' && end >= start) {
            const ids = [];
            for (let index = start; index <= end; index += 1) {
                const message = view.messages[index];
                if (message !== undefined)
                    ids.push(message.id);
            }
            return ids;
        }
        const startRaw = state.messageRefs.byRef[range.startRef];
        const endRaw = state.messageRefs.byRef[range.endRef];
        return startRaw === undefined || endRaw === undefined ? [] : [startRaw, endRaw];
    }
    /** First and last core index of each dsh message, in one pass. */
    messageBounds(view) {
        const bounds = new Map();
        for (let index = 0; index < view.messages.length; index += 1) {
            const message = view.messages[index];
            if (message === undefined)
                continue;
            const base = baseIdOf(message.id);
            const known = bounds.get(base);
            if (known === undefined)
                bounds.set(base, { start: index, end: index });
            else
                known.end = index;
        }
        return bounds;
    }
    /**
     * Widen a core-level span to the whole messages its endpoints belong to.
     *
     * A dsh event is one message with `text`, `reasoning` and `tool-call` cores;
     * the kernel numbers them separately. Committing a fold that covers only some
     * cores would drop the siblings without summarizing them, so the range has to
     * start at the first core of its first message and end at the last core of
     * its last one. Returns null when an endpoint has no live message.
     */
    alignRange(range, state, view, bounds) {
        const startRaw = state.messageRefs.byRef[range.startRef];
        const endRaw = state.messageRefs.byRef[range.endRef];
        if (startRaw === undefined || endRaw === undefined)
            return null;
        const startBound = bounds.get(baseIdOf(startRaw));
        const endBound = bounds.get(baseIdOf(endRaw));
        if (startBound === undefined || endBound === undefined)
            return null;
        const startIndex = startBound.start;
        const endIndex = endBound.end;
        if (endIndex < startIndex)
            return null;
        const first = view.messages[startIndex];
        const last = view.messages[endIndex];
        if (first === undefined || last === undefined)
            return null;
        const startRef = state.messageRefs.byRaw[first.id];
        const endRef = state.messageRefs.byRaw[last.id];
        if (startRef === undefined || endRef === undefined)
            return null;
        return { ...range, startRef, endRef, startIndex, endIndex, count: endIndex - startIndex + 1 };
    }
    /** True when every message of the span is a node dsh can still shadow. */
    rangeOnSurface(range, view, visible, blockedSeqs) {
        const start = range.startIndex;
        const end = range.endIndex;
        // Hand-built or normalized ranges may carry no index; they were advertised
        // by the kernel itself, so keep them rather than hide a real span.
        if (start === undefined || end === undefined)
            return true;
        if (end < start)
            return false;
        for (let index = start; index <= end; index += 1) {
            const message = view.messages[index];
            if (message === undefined)
                return false;
            const seq = view.seqOf.get(message.id);
            if (seq === undefined || !visible.has(seq))
                return false;
            if (blockedSeqs.has(seq))
                return false;
        }
        return true;
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