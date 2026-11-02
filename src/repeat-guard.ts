/**
 * Cut a model attempt that has collapsed into a repetition loop.
 *
 * Compaction can only stop feeding the loop; the loop itself runs inside one
 * attempt, where the only hook with the raw chunk stream is `llm/stream`. This
 * guard wraps that stream, watches reasoning and text deltas, and ends the
 * attempt with a synthetic `error` finish as soon as a run of identical lines
 * stops looking like prose. The loop turns that finish into `agent/request-error`,
 * which this module answers with one retry; past that it leaves the failure
 * terminal, so a model that insists on repeating cannot burn the whole budget.
 *
 * A retry resends the same request, so the cost is the prompt again. The guard
 * only arms after `minChars` of output and only counts lines that contain a
 * letter or digit, which keeps short answers and closing braces from tripping it.
 *
 * A legitimately repeated block — an aligned table, a Yes/No column — can still
 * look like a loop from one line at a time. Two extra gates separate them: the
 * repeated line must be short, and the recent window must hold almost nothing
 * else. A collapse produces one or two distinct short lines and nothing else;
 * a table produces structure around the run, so `maxUniqueLines` refuses it.
 */

/** Stable failure code shared by the stream cut and its retry decision. */
export const REPEAT_FAILURE_CODE = 'REPETITION_LOOP'

export interface RepeatGuardOptions {
  enabled: boolean
  /** Identical consecutive lines that end the attempt. */
  minRepeatedLines: number
  /** Do not arm until one attempt has produced this many characters. */
  minChars: number
  /** Retries per agent before the failure stays terminal. */
  maxRetries: number
  /** A longer repeated line is content (a table row), not a collapse. */
  maxLineChars: number
  /** Distinct meaningful lines allowed in the recent window when the run trips. */
  maxUniqueLines: number
}

export const DEFAULT_REPEAT_GUARD: RepeatGuardOptions = {
  enabled: true,
  minRepeatedLines: 16,
  minChars: 200,
  maxRetries: 1,
  maxLineChars: 40,
  maxUniqueLines: 2,
}

/** Lines that carry no word character are structure, not a collapse. */
const MEANINGFUL_LINE = /[\p{L}\p{N}]/u

/** How much trailing text one detector keeps; a run longer than this is still a run. */
const TAIL_CHARS = 8192

/** How many recent meaningful lines the uniqueness gate looks at. */
const UNIQUE_WINDOW = 64

/**
 * Incremental detector for one attempt.
 *
 * Only the tail is kept: a loop announces itself with its most recent lines,
 * and retaining the whole attempt would make the guard a second copy of the
 * stream it is meant to cut.
 */
export class RepeatDetector {
  private partial = ''
  private run = 0
  private last: string | undefined
  private total = 0
  private readonly recent: string[] = []

  constructor(private readonly options: RepeatGuardOptions) {}

  /**
   * Feed one delta; true means the attempt has collapsed.
   *
   * Line state is incremental. Re-scanning a retained tail per chunk would cost
   * O(chunks × tail), and the guard runs on the hot path of every model call.
   */
  push(text: string): boolean {
    if (text.length === 0) return false
    this.total += text.length
    let start = 0
    for (;;) {
      const newline = text.indexOf('\n', start)
      if (newline < 0) {
        this.partial = (this.partial + text.slice(start)).slice(-TAIL_CHARS)
        return false
      }
      const line = (this.partial + text.slice(start, newline)).trim()
      this.partial = ''
      start = newline + 1
      if (line.length === 0 || !MEANINGFUL_LINE.test(line)) continue
      if (this.consume(line)) return true
    }
  }

  private consume(line: string): boolean {
    this.recent.push(line)
    if (this.recent.length > UNIQUE_WINDOW) this.recent.shift()
    if (line === this.last) {
      this.run += 1
    } else {
      this.last = line
      this.run = 1
      return false
    }
    if (this.run < this.options.minRepeatedLines) return false
    if (this.total < this.options.minChars) return false
    if (line.length > this.options.maxLineChars) return false
    return new Set(this.recent).size <= this.options.maxUniqueLines
  }
}

/** Whether the tail holds `min` consecutive identical meaningful lines. */
export function repeatedTail(text: string, min: number): boolean {
  let run = 0
  let last: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || !MEANINGFUL_LINE.test(line)) continue
    if (line === last) {
      run += 1
      if (run >= min) return true
    } else {
      last = line
      run = 1
    }
  }
  return false
}

interface ChunkLike {
  type?: unknown
  text?: unknown
}

/**
 * Wrap one model stream.
 *
 * The upstream iterator is driven by hand instead of `for await` so that a
 * rejection from its `return()` cannot replace the synthetic finish: once the
 * detector trips, the failure we report is the one we chose, not whatever the
 * adapter throws while closing a live HTTP body.
 */
export async function* guardStream(
  upstream: AsyncIterable<unknown>,
  options: RepeatGuardOptions,
): AsyncGenerator<unknown> {
  if (!options.enabled) {
    yield* upstream
    return
  }
  const detector = new RepeatDetector(options)
  const iterator = upstream[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      const chunk = next.value as ChunkLike
      if (chunk?.type === 'reasoning-delta' || chunk?.type === 'text-delta') {
        const text = typeof chunk.text === 'string' ? chunk.text : ''
        if (detector.push(text)) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                code: REPEAT_FAILURE_CODE,
                message: `model output collapsed into a repetition loop (${options.minRepeatedLines}+ identical lines); the attempt was cut before it consumed the budget`,
              },
            },
          }
          return
        }
      }
      yield chunk
    }
  } finally {
    // Closing the adapter stream can throw (aborted fetch, already-consumed
    // body). That error must not surface in place of the finish above.
    try {
      await iterator.return?.(undefined)
    } catch {
      // Upstream is already broken; the attempt outcome is decided.
    }
  }
}

/** Minimal plugin-context surface this guard needs. */
export interface RepeatGuardHost {
  on(event: string, listener: (...args: never[]) => unknown, options?: { global?: boolean }): unknown
}

interface RequestErrorPayload {
  agent?: object
  failure?: { code?: unknown }
  signal?: { aborted?: unknown }
}

interface StatusPayload {
  agent?: object
  status?: unknown
}

/**
 * Install the stream guard and its retry decision.
 *
 * `llm/stream` is a waterfall: returning our own iterable replaces the adapter
 * stream for every caller, including one-shot calls such as a compaction
 * summary, which is why the retry path is keyed on the agent and bounded.
 */
export function installRepeatGuard(host: RepeatGuardHost, options: RepeatGuardOptions): void {
  if (!options.enabled) return
  const retries = new WeakMap<object, number>()

  host.on(
    'llm/stream',
    ((_request: unknown, next: () => AsyncIterable<unknown>) => guardStream(next(), options)) as never,
    { global: true },
  )

  host.on(
    'agent/request-error',
    (async (payload: unknown, next: () => Promise<unknown>) => {
      const value = payload as RequestErrorPayload | undefined
      if (value?.failure?.code !== REPEAT_FAILURE_CODE) return next()
      if (value.signal?.aborted === true) return next()
      const agent = value.agent
      if (agent === undefined) return next()
      const used = retries.get(agent) ?? 0
      if (used >= options.maxRetries) return next()
      retries.set(agent, used + 1)
      return { kind: 'retry' }
    }) as never,
    { global: true },
  )

  host.on(
    'agent/status',
    ((payload: unknown) => {
      const value = payload as StatusPayload | undefined
      if (value?.status === 'idle' && value.agent !== undefined) retries.delete(value.agent)
    }) as never,
    { global: true },
  )
}
