import type { ResolvedOptions } from './config.js'
import { buildKernelConfig } from './config.js'
import type {
  CompressionBlock,
  CompressionCore,
  CompressionState,
  Config,
  MessageContentStore,
  NudgeDecision,
} from './kernel.js'
import {
  SUMMARY_HEADER,
  activeBlocks,
  baseIdOf,
  blockById,
  buildStatusReport,
  collectBlockContent,
  createCore,
  defaultCountTokens,
  estimateTokensFast,
  formatRanges,
  parseBlockIdArg,
  parseCompressArgs,
  renderNudgeText,
  resolvePrompts,
  validateConfig,
} from './kernel.js'
import type { DshSessionLike, DshTokenMeasurement } from './dsh-types.js'
import { SessionStore } from './store.js'
import { BLOCK_SOURCE_KIND, buildKernelView, isOwnMessage, renderBlockSummary } from './session-view.js'
import type { KernelView } from './session-view.js'

export interface RefreshResult {
  decision: NudgeDecision | null
  tokenCount: number
}

export interface CompressOutcome {
  text: string
  ok: boolean
}

/** Optional drill-down for `acp_status`; mirrors the kernel's report options. */
export interface StatusQuery {
  scope?: 'compressed' | 'uncompressed'
  view?: 'ranges' | 'messages'
  tool?: string
  sort?: 'size' | 'time'
  limit?: number
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
function scrubRanges(text: string): string {
  const kept: string[] = []
  let dropped = 0
  for (const line of text.split('\n')) {
    if (/^\s*BLOCKED\b/.test(line) || line.includes('not foldable: refs unresolvable')) {
      dropped += 1
      continue
    }
    kept.push(line)
  }
  if (dropped === 0) return text
  kept.push(`  (${dropped} protected span(s) hidden — system/developer prompts and media cannot be folded)`)
  return kept.join('\n')
}

function describeTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(value)
}

/** Accept either `"b1"` or the tool-call argument object that wraps it. */
function blockIdArgument(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw !== 'object' || raw === null) return ''
  const record = raw as Record<string, unknown>
  for (const key of ['blockId', 'block_id', 'block', 'id']) {
    const value = record[key]
    if (typeof value === 'string') return value.trim()
  }
  return ''
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
  readonly config: Config
  private readonly core: CompressionCore
  private readonly store: SessionStore
  private readonly options: ResolvedOptions

  constructor(options: ResolvedOptions, store: SessionStore, core?: CompressionCore) {
    this.options = options
    this.store = store
    this.core = core ?? createCore()
    const base = buildKernelConfig(options)
    this.config = {
      ...base,
      isMessageProtected: (message) => {
        const kind = typeof message.toolName === 'string' ? message.toolName : ''
        return kind.length === 0 && message.role === 'system'
      },
    }
    const problems = validateConfig(this.config)
    if (problems.length > 0) {
      console.warn(`[bili-compaction] kernel config warnings: ${problems.join('; ')}`)
    }
  }

  private configFor(view: KernelView): Config {
    return { ...this.config, isMessageProtected: (message) => view.protectedIds.has(message.id) }
  }

  private load(session: DshSessionLike): { state: CompressionState; contentStore: MessageContentStore } {
    const persisted = this.store.load(session.id)
    return { state: persisted.state, contentStore: persisted.contentStore }
  }

  private save(session: DshSessionLike, state: CompressionState, contentStore: MessageContentStore): void {
    this.store.save(session.id, { version: 1, state, contentStore })
  }

  /** Measure a view the way the kernel does when dsh's meter is unavailable. */
  private estimate(view: KernelView): number {
    let total = 0
    for (const message of view.messages) total += estimateTokensFast(message.text ?? '')
    return total
  }

  /**
   * Fold the current log into the kernel and persist the resulting state.
   * Returns the kernel's nudge decision for this step (if any).
   */
  refresh(session: DshSessionLike, measurement?: DshTokenMeasurement): RefreshResult {
    const synced = this.sync(session, measurement)
    return { decision: synced.decision, tokenCount: synced.tokenCount }
  }

  /**
   * Bring the persisted LSM up to date with the session log.
   *
   * Every entry point starts here: refs are minted by `processTurn`, and a
   * status or compress call on a state that never saw the current log would
   * report zero visible tokens (and reject every ref it was not told about).
   */
  private sync(session: DshSessionLike, measurement?: DshTokenMeasurement): {
    view: KernelView
    state: CompressionState
    contentStore: MessageContentStore
    decision: NudgeDecision | null
    tokenCount: number
  } {
    const view = buildKernelView(session)
    const persisted = this.load(session)
    const tokenCount =
      measurement !== undefined && typeof measurement.totalTokens === 'number'
        ? measurement.totalTokens
        : this.estimate(view)
    const turn = this.core.processTurn({
      messages: view.messages,
      state: persisted.state,
      config: this.configFor(view),
      tokenCount,
      renderTags: 'none',
      contentStore: persisted.contentStore,
    })
    const contentStore = turn.contentStore ?? persisted.contentStore
    this.save(session, turn.state, contentStore)
    return {
      view,
      state: turn.state,
      contentStore,
      decision: turn.nudge ?? null,
      tokenCount,
    }
  }

  /** Render the kernel's nudge for this step, if it wants to speak. */
  nudgeText(decision: NudgeDecision | null): string | null {
    if (decision === null || !decision.shouldInject) return null
    const prompts = resolvePrompts(undefined, { languagePreservation: this.options.languagePreservation })
    return renderNudgeText(decision, prompts).text
  }

  /**
   * Apply a `compress` tool call.
   *
   * Every newly created block becomes one durable surface replacement. The
   * kernel state is persisted even when a commit is rejected, so a range that
   * spans a message dsh cannot shadow (for example a protected prompt) is
   * reported instead of leaving the log half-folded.
   */
  compress(session: DshSessionLike, rawArgs: unknown, measurement?: DshTokenMeasurement): CompressOutcome {
    const parsed = parseCompressArgs(rawArgs)
    if (!parsed.diagnostics.ok || parsed.ranges.length === 0) {
      const reasons = parsed.diagnostics.invalidReasons?.join('; ') ?? parsed.diagnostics.kind
      return { ok: false, text: `compress rejected: ${parsed.diagnostics.kind}${reasons.length > 0 ? ` (${reasons})` : ''}. Call acp_status first to see the compressible ranges.` }
    }

    const { view, state, contentStore } = this.sync(session, measurement)
    const before = new Set(state.blocks.map((block) => block.blockId))
    const config = this.configFor(view)
    const applied = this.core.applyCompression({
      ranges: parsed.ranges,
      messages: view.messages,
      state,
      config,
      protectedMessageIds: view.protectedIds,
    })
    const created = activeBlocks(applied.state).filter((block) => !before.has(block.blockId))

    const lines: string[] = []
    for (const block of created) {
      const problem = this.commit(session, view, block)
      if (problem !== null) {
        lines.push(`- ${block.blockId} ${block.startRef}–${block.endRef}: NOT committed — ${problem}`)
        continue
      }
      lines.push(
        `- ${block.blockId} ${block.startRef}–${block.endRef} (tier ${block.tier}, ${describeTokens(block.compressedTokens)} tokens folded${block.topic === undefined ? '' : `, topic: ${block.topic}`})`,
      )
    }

    this.save(session, applied.state, contentStore)

    const warnings = applied.result.warnings.length > 0 ? `\nWarnings: ${applied.result.warnings.join('; ')}` : ''
    const errors = applied.result.errors.length > 0 ? `\nErrors: ${applied.result.errors.join('; ')}` : ''
    const usage = measurement === undefined ? '' : `\nContext is now ${describeTokens(measurement.totalTokens)} tokens (${Math.round((measurement.totalTokens / this.config.modelContextLimit) * 100)}% of ${describeTokens(this.config.modelContextLimit)}).`
    const body =
      created.length === 0
        ? 'No new block was created. Check that the refs are inside the ranges acp_status advertised.'
        : `Compressed ${created.length} range(s):\n${lines.join('\n')}${usage}`
    const ok = created.length > 0 && errors.length === 0
    return { ok, text: `${body}${warnings}${errors}` }
  }

  /**
   * Write one block into dsh's log as a surface replacement.
   *
   * Returns a rejection reason instead of throwing: dsh refuses a replacement
   * that misses a shadowed node or that dsh cannot represent, and a partial
   * fold must never leave the session in a state the model cannot read.
   */
  private commit(session: DshSessionLike, view: KernelView, block: CompressionBlock): string | null {
    const covered = new Set<string>()
    for (const id of block.effectiveMessageIds) covered.add(baseIdOf(id))

    const surface = session.surface.nodes
    let minSeq = Number.POSITIVE_INFINITY
    let maxSeq = Number.NEGATIVE_INFINITY
    for (const id of block.effectiveMessageIds) {
      const seq = view.seqOf.get(id)
      if (seq === undefined) continue
      if (seq < minSeq) minSeq = seq
      if (seq > maxSeq) maxSeq = seq
    }
    if (!Number.isFinite(minSeq) || !Number.isFinite(maxSeq)) {
      return 'no surface sequence is mapped to this block'
    }

    const shadowed: number[] = []
    for (const seq of surface) if (seq >= minSeq && seq <= maxSeq) shadowed.push(seq)
    if (shadowed.length === 0) return 'the block covers no currently visible message'

    const startSeq = shadowed[0]
    const endSeq = shadowed[shadowed.length - 1]
    if (startSeq === undefined || endSeq === undefined) return 'the block covers no currently visible message'

    for (const seq of shadowed) {
      const event = session.eventAt(seq)
      const message = session.deriveEventMessage(event)
      if (message === null || message === undefined) return `visible node #${seq} derives no message`
      if (isOwnMessage(message)) continue
      const base = typeof message.id === 'string' ? message.id : undefined
      if (base === undefined) return `visible node #${seq} has no durable message id`
      if (!covered.has(base)) {
        return `the span contains ${base} which this block does not cover; compress a narrower range`
      }
    }

    const text = renderBlockSummary(SUMMARY_HEADER, block.summary, block.topic)
    session.append(
      'user/message',
      {
        id: `acp_block_${block.blockId}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: BLOCK_SOURCE_KIND, blockId: block.blockId },
      },
      { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: shadowed },
    )
    return null
  }

  /** Cache-safe decompress: return the folded originals as tool output. */
  decompress(session: DshSessionLike, rawBlockId: unknown, full = false): string {
    const persisted = this.load(session)
    const requested = blockIdArgument(rawBlockId)
    const blockId = parseBlockIdArg(requested) ?? requested
    if (blockId.length === 0) return 'decompress: pass a blockId such as "b00012" (see acp_status).'
    const block = blockById(persisted.state, blockId)
    if (block === undefined) {
      const known = persisted.state.blocks.map((entry) => entry.blockId).join(', ')
      return `decompress: unknown block "${requested}". Known blocks: ${known.length === 0 ? '(none)' : known}`
    }
    const view = buildKernelView(session)
    const collected = collectBlockContent(persisted.state, block, view.messages, { full })
    if (collected.count === 0) return `decompress: ${block.blockId} covers no messages in the current log.`
    return `decompress ${block.blockId} (${collected.count} item(s), tier ${block.tier}${full ? ', all tiers' : ', one tier up'}):\n\n${collected.text}`
  }

  /**
   * The refs the model may fold right now.
   *
   * This is the kernel's own recommendation (the same list a nudge advertises),
   * not its `uncompressed` drill-down: the drill-down reports raw visible spans,
   * and a span that starts at a protected message renders as `BLOCKED–m000NN`,
   * which is not a usable ref. Protected spans are listed by `formatRanges` as
   * protected instead, so every ref printed here can actually be compressed.
   */
  private rangeList(decision: NudgeDecision | null): string {
    if (decision === null) return 'Compressible ranges: unavailable (no kernel decision for this turn).'
    return formatRanges(decision.compressibleRanges, decision.protectedRanges ?? [])
  }

  /**
   * Kernel status report, plus dsh's measured surface size when available.
   *
   * With no query this prints the overview followed by the compressible ranges:
   * the kernel only advertises ranges through its nudge (which is threshold
   * gated), but the model needs concrete refs the moment it decides to fold.
   */
  status(session: DshSessionLike, measurement?: DshTokenMeasurement, query: StatusQuery = {}): string {
    const synced = this.sync(session, measurement)
    const config = this.configFor(synced.view)
    const base = { config, originalMessages: synced.view.messages }
    const report =
      query.scope === undefined
        ? [
            buildStatusReport(synced.state, synced.view.messages, defaultCountTokens, base),
            this.rangeList(synced.decision),
          ].join('\n\n')
        : scrubRanges(
            buildStatusReport(synced.state, synced.view.messages, defaultCountTokens, { ...base, ...query }),
          )
    if (measurement === undefined) return report
    const usage = measurement.totalTokens
    const pct = Math.round((usage / this.config.modelContextLimit) * 100)
    return `dsh surface: ${describeTokens(usage)} tokens (${pct}% of ${describeTokens(this.config.modelContextLimit)}), ${synced.view.messages.length} messages in the append-origin log.\n\n${report}`
  }

  /** Reset the LSM for a session (used by tests and by a manual `acp_reset`). */
  reset(session: DshSessionLike): void {
    this.store.reset(session.id)
  }
}
