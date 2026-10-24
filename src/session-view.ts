import type { DshContentBlock, DshMessage, DshSessionLike } from './dsh-types.js'
import type { CoreMessage } from './kernel.js'

/**
 * Builds the kernel's message list from a dsh session log.
 *
 * dsh's model-visible surface is a fold: a `user/message` with `surfaceOp:
 * {op:'replace', ...}` shadows the range it covers. Folding the *surface* would
 * hide every message this plugin already compressed, so the kernel's state
 * (which blocks cover which raw ids) would lose its anchors and re-compress the
 * same span. This module therefore folds the **append-origin** events — one per
 * message as it originally entered the conversation — which only ever grows.
 * Compression results stay a projection (`surfaceOp: 'replace'`) applied on top,
 * exactly like bili's proxy view.
 */

const SURFACE_TYPES: ReadonlySet<string> = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/** Source kind stamped on every replacement message this plugin writes. */
export const BLOCK_SOURCE_KIND = 'bili-compaction'

/** Source kind stamped on an optional nudge message (see `injectNudge`). */
export const NUDGE_SOURCE_KIND = 'bili-compaction-nudge'

export interface ViewEntry {
  seq: number
  message: DshMessage
  ids: string[]
}

export interface KernelView {
  messages: CoreMessage[]
  entries: ViewEntry[]
  /** Kernel sub-id → owning dsh log sequence. */
  seqOf: Map<string, number>
  /** Sub-ids the kernel must never fold. */
  protectedIds: Set<string>
}

interface SurfaceEventLike {
  type?: unknown
  surfaceOp?: unknown
  data?: unknown
}

function isSurfaceEventLike(value: unknown): value is SurfaceEventLike {
  return typeof value === 'object' && value !== null
}

function normalizeRole(role: string): CoreMessage['role'] {
  if (role === 'system' || role === 'developer') return 'system'
  if (role === 'assistant') return 'assistant'
  if (role === 'tool') return 'tool'
  return 'user'
}

function textOf(block: DshContentBlock): string | undefined {
  const text = (block as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

function blockIds(message: DshMessage, seq: number): string[] {
  const base = typeof message.id === 'string' && message.id.length > 0 ? message.id : `acp_seq_${seq}`
  return message.content.map((_, index) => `${base}#${index}`)
}

/**
 * Whether a session event is a message this plugin itself wrote (a block
 * summary or an injected nudge). Those are replacement copies: they are already
 * excluded by the `surfaceOp: 'append'` filter, but the source check keeps the
 * exclusion correct if dsh ever appends one of them instead.
 */
export function isOwnMessage(message: DshMessage): boolean {
  const kind = message.source?.kind
  return kind === BLOCK_SOURCE_KIND || kind === NUDGE_SOURCE_KIND
}

function toCoreMessages(
  message: DshMessage,
  seq: number,
  ids: string[],
  protectedIds: Set<string>,
): CoreMessage[] {
  const role = normalizeRole(String(message.role))
  const hasMedia = message.content.some((block) => block.type === 'image' || block.type === 'file')
  const structurallyProtected = role === 'system' || hasMedia || typeof message.id !== 'string'
  const out: CoreMessage[] = []

  message.content.forEach((block, index) => {
    const id = ids[index]
    if (id === undefined) return
    const kind = String(block.type)
    let contentType: CoreMessage['contentType'] = 'text'
    let text = textOf(block)
    let toolName: string | undefined
    let toolCallId: string | undefined

    if (role === 'tool') {
      contentType = 'tool-result'
      toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
    } else if (kind === 'text') {
      contentType = 'text'
    } else if (kind === 'reasoning') {
      contentType = 'reasoning'
    } else if (kind === 'tool-call') {
      contentType = 'tool-call'
      const callId = (block as { id?: unknown }).id
      const name = (block as { name?: unknown }).name
      const args = (block as { arguments?: unknown }).arguments
      toolCallId = typeof callId === 'string' ? callId : undefined
      toolName = typeof name === 'string' ? name : undefined
      text = typeof args === 'string' ? args : undefined
    } else {
      // Media and unknown blocks carry bytes dsh cannot re-materialize from a
      // summary; keep them visible by protecting the whole parent message.
      return
    }

    if (text === undefined || text.length === 0) return
    out.push({
      id,
      role,
      contentType,
      text,
      // dsh log sequences are 0-based; kernel ledger refs are 1-based, so
      // `m00500` always means "log event #499". `assignRefs` honors this
      // directly, which keeps refs stable for the life of the session.
      ledgerSeq: seq + 1,
      ...(toolName === undefined ? {} : { toolName }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
    })
  })

  if (structurallyProtected) for (const id of ids) protectedIds.add(id)
  return out
}

/**
 * Fold the append-origin events of a session into the kernel's message list.
 *
 * Entries are emitted in log order, which is the order dsh renders them, so the
 * `seqOf` map resolves any kernel sub-id back to the surface node a durable
 * replace has to shadow.
 */
export function buildKernelView(session: DshSessionLike): KernelView {
  const messages: CoreMessage[] = []
  const entries: ViewEntry[] = []
  const seqOf = new Map<string, number>()
  const protectedIds = new Set<string>()
  const total = typeof session.seq === 'number' ? session.seq : 0

  for (let seq = 0; seq < total; seq += 1) {
    const event = session.eventAt(seq)
    if (!isSurfaceEventLike(event)) continue
    if (typeof event.type !== 'string' || !SURFACE_TYPES.has(event.type)) continue
    if (event.surfaceOp !== 'append') continue
    const message = session.deriveEventMessage(event)
    if (message === null || message === undefined) continue
    if (isOwnMessage(message)) continue

    const ids = blockIds(message, seq)
    const core = toCoreMessages(message, seq, ids, protectedIds)
    if (core.length === 0) continue
    for (const id of ids) seqOf.set(id, seq)
    messages.push(...core)
    entries.push({ seq, message, ids })
  }

  return { messages, entries, seqOf, protectedIds }
}

/** The replacement text dsh renders for a block: kernel summary + topic. */
export function renderBlockSummary(header: string, summary: string, topic?: string): string {
  const topicLine = topic === undefined || topic.length === 0 ? header : `${header} — ${topic}`
  const body = summary.trim()
  return body.length === 0 ? topicLine : `${topicLine}\n${body}`
}
