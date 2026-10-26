import type { ResolvedOptions } from './config.js';
import type { CompressionCore, Config, NudgeDecision } from './kernel.js';
import type { DshSessionLike, DshTokenMeasurement } from './dsh-types.js';
import { SessionStore } from './store.js';
export interface RefreshResult {
    decision: NudgeDecision | null;
    tokenCount: number;
}
export interface CompressOutcome {
    text: string;
    ok: boolean;
}
/** Optional drill-down for `acp_status`; mirrors the kernel's report options. */
export interface StatusQuery {
    scope?: 'compressed' | 'uncompressed';
    view?: 'ranges' | 'messages';
    tool?: string;
    sort?: 'size' | 'time';
    limit?: number;
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
export declare class CompactionEngine {
    readonly config: Config;
    private readonly core;
    private readonly store;
    private readonly options;
    constructor(options: ResolvedOptions, store: SessionStore, core?: CompressionCore);
    private configFor;
    /**
     * Prefer the live route's advertised window over the static option. An
     * operator-pinned `modelContextLimit` stays authoritative so a deliberate
     * cap (or a route that advertises a window larger than the budget) is not
     * silently widened.
     */
    private contextLimit;
    private load;
    private save;
    /** Measure a view the way the kernel does when dsh's meter is unavailable. */
    private estimate;
    /**
     * Fold the current log into the kernel and persist the resulting state.
     * Returns the kernel's nudge decision for this step (if any).
     */
    refresh(session: DshSessionLike, measurement?: DshTokenMeasurement): RefreshResult;
    /**
     * Bring the persisted LSM up to date with the session log.
     *
     * Every entry point starts here: refs are minted by `processTurn`, and a
     * status or compress call on a state that never saw the current log would
     * report zero visible tokens (and reject every ref it was not told about).
     */
    private sync;
    /** Render the kernel's nudge for this step, if it wants to speak. */
    nudgeText(decision: NudgeDecision | null): string | null;
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
    compress(session: DshSessionLike, rawArgs: unknown, measurement?: DshTokenMeasurement): CompressOutcome;
    /**
     * Validate one durable replacement without writing it.
     *
     * The critical check is not just "does the block cover the event's base id":
     * the block must cover every kernel core id of that event. `assignRefs` gives
     * each core its own ref (same `ledgerSeq`, different free ref), so a range can
     * legitimately select only one core; committing it would shadow the whole
     * event and silently drop the unselected siblings.
     */
    private planCommit;
    /**
     * Best-effort state for a partially written batch (an unexpected append
     * failure, after every plan validated). Blocks that landed are kept; blocks
     * that did not are removed so their messages do not look covered.
     */
    private stateAfterCommitFailure;
    /** Cache-safe decompress: return the folded originals as tool output. */
    decompress(session: DshSessionLike, rawBlockId: unknown, full?: boolean): string;
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
    private rangeList;
    /**
     * Kernel status report, plus dsh's measured surface size when available.
     *
     * With no query this prints the overview followed by the compressible ranges:
     * the kernel only advertises ranges through its nudge (which is threshold
     * gated), but the model needs concrete refs the moment it decides to fold.
     */
    status(session: DshSessionLike, measurement?: DshTokenMeasurement, query?: StatusQuery): string;
    /** Reset the LSM for a session (used by tests and by a manual `acp_reset`). */
    reset(session: DshSessionLike): void;
}
//# sourceMappingURL=engine.d.ts.map