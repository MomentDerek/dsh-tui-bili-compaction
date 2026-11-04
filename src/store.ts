import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CompressionState, MessageContentStore } from './kernel.js'
import { createContentStore, createInitialState } from './kernel.js'

/**
 * Durable per-session kernel state.
 *
 * The kernel is pure: it never touches the disk. dsh's own log keeps the
 * messages, so this store only has to remember the 3-tier LSM bookkeeping
 * (blocks, refs, nudge watermarks) plus the CCR content store, which is a cache
 * of originals for cache-safe retrieval.
 */

export interface PersistedSession {
  version: 1
  state: CompressionState
  contentStore: MessageContentStore
}

const STORE_VERSION = 1

/** One durable-state event; emitted on every load/save and on refused writes. */
export type StoreLogAction = 'load' | 'save' | 'reset' | 'refuse-empty' | 'corrupt'

export interface StoreLogEvent {
  action: StoreLogAction
  sessionId: string
  /** Path of the state file the event belongs to. */
  file: string
  blocks: number
  active: number
  refs: number
  /** Kernel `stats.compressionCount`: how many folds the state remembers. */
  folded: number
  /** Kernel `stats.tokensCompressed`: cumulative tokens the folds reclaimed. */
  tokens: number
  detail?: string
}

export type StoreLogger = (event: StoreLogEvent) => void

type StoreSummary = Omit<StoreLogEvent, 'action' | 'sessionId' | 'file' | 'detail'>

interface SaveOptions {
  /** Allow a zero-block write (reset); normal saves refuse it. */
  allowEmpty?: boolean
  /** Log label; `reset` reuses the save path. */
  action?: 'save' | 'reset'
  detail?: string
}

/** Set to `1` to print every load/save, not just the ones that change state. */
const STATE_LOG_ENV = 'DSH_BILI_COMPACTION_STATE_LOG'

function summaryOf(session: PersistedSession): StoreSummary {
  // Count only blocks a load would keep (`normalizeBlock` drops malformed
  // ones), but do not rebuild the whole state: this runs on every save.
  const state = session.state
  let blocks = 0
  let active = 0
  for (const block of Array.isArray(state.blocks) ? state.blocks : []) {
    if (!normalizeBlock(block)) continue
    blocks += 1
    if (block.active === true) active += 1
  }
  const refs = isRecord(state.messageRefs) && isRecord(state.messageRefs.byRef) ? Object.keys(state.messageRefs.byRef).length : 0
  const stats = isRecord(state.stats) ? state.stats : undefined
  return {
    blocks,
    active,
    refs,
    folded: stats !== undefined && finite(stats['compressionCount']) ? stats['compressionCount'] : 0,
    tokens: stats !== undefined && finite(stats['tokensCompressed']) ? stats['tokensCompressed'] : 0,
  }
}

function verboseStateLog(): boolean {
  const value = process.env[STATE_LOG_ENV]
  return value === '1' || value === 'true'
}

function formatStoreLog(event: StoreLogEvent): string {
  const detail = event.detail === undefined ? '' : ` ${event.detail}`
  return `[bili-compaction][state] ${event.action} session=${event.sessionId.slice(0, 8)} blocks=${event.blocks} active=${event.active} refs=${event.refs} folded=${event.folded} tokens=${event.tokens}${detail}`
}

export function defaultStorageDir(): string {
  const localAppData = process.env['LOCALAPPDATA']
  if (process.platform === 'win32' && typeof localAppData === 'string' && localAppData.length > 0) {
    return join(localAppData, 'dsh-tui-bili-compaction', 'sessions')
  }
  const xdg = process.env['XDG_STATE_HOME']
  const root = typeof xdg === 'string' && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state')
  return join(root, 'dsh-tui-bili-compaction', 'sessions')
}

function fileStem(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  const readable = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
  return `${readable}-${digest}`
}

function emptySession(): PersistedSession {
  return { version: STORE_VERSION, state: createInitialState(), contentStore: createContentStore() }
}

/**
 * Rename the freshly written temp file over the live one.
 *
 * Windows hands out EPERM/EBUSY while a virus scanner or the search indexer
 * still holds the destination open; those clear within milliseconds, so retry
 * briefly instead of letting a scan failure drop a compression commit.
 */
function renameWithRetry(from: string, to: string): void {
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      lastError = error
      const code = (error as { code?: unknown }).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1))
    }
  }
  throw lastError
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeBlock(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value['blockId'] !== 'string' || value['blockId'].length === 0) return false
  if (typeof value['runId'] !== 'string' || typeof value['summary'] !== 'string') return false
  if (value['tier'] !== 1 && value['tier'] !== 2 && value['tier'] !== 3) return false
  if (value['generation'] !== 'young' && value['generation'] !== 'old') return false
  if (!stringArray(value['directMessageIds'])) return false
  if (!stringArray(value['effectiveMessageIds'])) return false
  if (!stringArray(value['directBlockIds'])) return false
  if (!finite(value['compressedTokens']) || !finite(value['createdAt']) || !finite(value['survivedCount'])) return false
  return typeof value['active'] === 'boolean'
}

function normalizeRefs(value: unknown): CompressionState['messageRefs'] | undefined {
  if (!isRecord(value) || !isRecord(value['byRaw']) || !isRecord(value['byRef'])) return undefined
  const byRaw = Object.fromEntries(
    Object.entries(value['byRaw']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  const byRef = Object.fromEntries(
    Object.entries(value['byRef']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return { byRaw, byRef }
}

function normalizeContentStore(value: unknown): MessageContentStore {
  if (!isRecord(value) || !isRecord(value['byHash']) || !isRecord(value['byRef'])) return createContentStore()
  const byHash = Object.fromEntries(
    Object.entries(value['byHash']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  const byRef = Object.fromEntries(
    Object.entries(value['byRef']).filter((entry): entry is [string, MessageContentStore['byRef'][string]] => {
      const entryValue = entry[1]
      return (
        isRecord(entryValue) &&
        typeof entryValue['ref'] === 'string' &&
        typeof entryValue['rawId'] === 'string' &&
        typeof entryValue['text'] === 'string' &&
        typeof entryValue['kind'] === 'string' &&
        finite(entryValue['tokens']) &&
        typeof entryValue['head'] === 'string'
      )
    }),
  )
  return { version: 1, byHash, byRef }
}

function positiveInt(value: unknown, fallback: number): number {
  return finite(value) && value >= 1 ? Math.floor(value) : fallback
}

function normalizeState(value: unknown): CompressionState {
  const initial = createInitialState()
  if (!isRecord(value)) return initial
  const refs = normalizeRefs(value['messageRefs'])
  if (refs === undefined || !Array.isArray(value['blocks'])) return initial
  const seen = new Set<string>()
  const blocks = value['blocks'].filter((block): block is CompressionState['blocks'][number] => {
    if (!normalizeBlock(block)) return false
    const id = (block as { blockId: string }).blockId
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  const highestBlockId = blocks.reduce((highest, block) => {
    const match = /^b(\d+)$/.exec(block.blockId)
    return match === null ? highest : Math.max(highest, Number(match[1]))
  }, 0)
  const tokenSnapshot = isRecord(value['tokenSnapshot'])
    ? Object.fromEntries(
        Object.entries(value['tokenSnapshot']).filter((entry): entry is [string, number] => finite(entry[1])),
      )
    : initial.tokenSnapshot
  const nudgeValue = value['nudge']
  const nudge =
    isRecord(nudgeValue) &&
    finite(nudgeValue['lastPerMessageNudgeTokens']) &&
    finite(nudgeValue['lastNudgeShownTokens']) &&
    finite(nudgeValue['baselineTokens']) &&
    isRecord(nudgeValue['anchors'])
      ? {
          lastPerMessageNudgeTokens: nudgeValue['lastPerMessageNudgeTokens'],
          lastNudgeShownTokens: nudgeValue['lastNudgeShownTokens'],
          baselineTokens: nudgeValue['baselineTokens'],
          anchors: Object.fromEntries(
            Object.entries(nudgeValue['anchors']).filter((entry): entry is [string, number] => finite(entry[1])),
          ),
          lastShownByTier: isRecord(nudgeValue['lastShownByTier'])
            ? (Object.fromEntries(
                Object.entries(nudgeValue['lastShownByTier']).filter((entry): entry is [string, number] =>
                  finite(entry[1]),
                ),
              ) as Record<number, number>)
            : initial.nudge.lastShownByTier,
        }
      : initial.nudge
  const statsValue = value['stats']
  const stats = isRecord(statsValue)
    ? {
        ...initial.stats,
        ...Object.fromEntries(
          Object.entries(statsValue).filter((entry): entry is [string, number] => finite(entry[1])),
        ),
      }
    : initial.stats
  return {
    ...initial,
    ...value,
    blocks,
    messageRefs: refs,
    tokenSnapshot,
    nudge,
    stats,
    nextBlockId: Math.max(positiveInt(value['nextBlockId'], initial.nextBlockId), highestBlockId + 1),
    nextRunId: positiveInt(value['nextRunId'], initial.nextRunId),
    nextRuleId: positiveInt(value['nextRuleId'], initial.nextRuleId ?? 1),
  } as CompressionState
}

export class SessionStore {
  private readonly dir: string
  private readonly log?: StoreLogger
  private readonly cache = new Map<string, PersistedSession>()

  constructor(dir?: string, log?: StoreLogger) {
    this.dir = dir !== undefined && dir.length > 0 ? dir : defaultStorageDir()
    this.log = log
  }

  path(sessionId: string): string {
    return join(this.dir, `${fileStem(sessionId)}.json`)
  }

  load(sessionId: string): PersistedSession {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return cached
    const file = this.path(sessionId)
    let loaded: PersistedSession
    if (!existsSync(file)) {
      loaded = emptySession()
      this.emit({ action: 'load', sessionId, file, ...summaryOf(loaded), detail: 'no state file yet' }, false)
    } else {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        loaded = this.normalize(parsed)
        const summary = summaryOf(loaded)
        this.emit({ action: 'load', sessionId, file, ...summary }, summary.blocks > 0)
      } catch (error) {
        // A corrupt file must not take the session down, but its bytes are the
        // only evidence of what the LSM believed: keep a copy before starting
        // over, and say so — this used to reset silently.
        const why = error instanceof Error ? error.message : String(error)
        const backup = this.backup(file, 'corrupt')
        loaded = emptySession()
        this.emit(
          {
            action: 'corrupt',
            sessionId,
            file,
            ...summaryOf(loaded),
            detail: `unreadable (${why}); copy kept at ${backup ?? file}`,
          },
          true,
          true,
        )
      }
    }
    this.cache.set(sessionId, loaded)
    return loaded
  }

  private normalize(parsed: unknown): PersistedSession {
    if (!isRecord(parsed)) return emptySession()
    return {
      version: STORE_VERSION,
      state: normalizeState(parsed['state']),
      contentStore: normalizeContentStore(parsed['contentStore']),
    }
  }

  /**
   * Persist one session state.
   *
   * A `blocks === 0` state written over one that had blocks means the kernel
   * lost its LSM (the resume/fork path can hand back a fresh state while the
   * log is intact). The file on disk is then the only copy of the folds, so it
   * is backed up and the write is refused instead of letting a stale empty view
   * erase it. `reset` opts in with `allowEmpty`.
   */
  save(sessionId: string, value: PersistedSession, options: SaveOptions = {}): void {
    const file = this.path(sessionId)
    const previous = this.cache.get(sessionId) ?? this.peek(sessionId)
    // Count what the file will actually mean after a load, not the raw payload:
    // malformed blocks are discarded by `normalize`, and a payload of only
    // malformed blocks must not look like a real state worth protecting.
    const before = previous === undefined ? undefined : summaryOf(previous)
    const next = summaryOf(value)
    if (options.allowEmpty !== true && next.blocks === 0 && before !== undefined && before.blocks > 0) {
      const backup = this.backup(file, 'refuse')
      this.emit(
        {
          action: 'refuse-empty',
          sessionId,
          file,
          ...next,
          detail: `previous blocks=${before.blocks} active=${before.active} folded=${before.folded}; refused to overwrite (copy kept at ${backup ?? file})`,
        },
        true,
        true,
      )
      return
    }
    this.cache.set(sessionId, value)
    mkdirSync(this.dir, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(value), 'utf8')
    try {
      renameWithRetry(temp, file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
    // Refs and active flags churn on every ordinary turn; only a change in the
    // fold bookkeeping itself is worth a line. `DSH_BILI_COMPACTION_STATE_LOG=1`
    // prints the rest.
    const notable =
      before === undefined
        ? next.blocks > 0
        : before.blocks !== next.blocks || before.folded !== next.folded || before.tokens !== next.tokens
    this.emit({ action: options.action ?? 'save', sessionId, file, ...next, detail: options.detail }, notable)
  }

  reset(sessionId: string, nextBlockId?: number): PersistedSession {
    const previous = this.cache.get(sessionId) ?? this.peek(sessionId)
    const fresh = emptySession()
    if (nextBlockId !== undefined && nextBlockId > fresh.state.nextBlockId) {
      fresh.state.nextBlockId = nextBlockId
    }
    const detail = previous === undefined ? 'fresh session' : `replaced blocks=${summaryOf(previous).blocks}`
    this.save(sessionId, fresh, { allowEmpty: true, action: 'reset', detail })
    return fresh
  }

  /** Read a state file for comparison without caching or reporting it. */
  private peek(sessionId: string): PersistedSession | undefined {
    try {
      const file = this.path(sessionId)
      if (!existsSync(file)) return undefined
      return this.normalize(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return undefined
    }
  }

  /** Copy a file aside before it is replaced or abandoned. Best effort. */
  private backup(file: string, kind: 'corrupt' | 'refuse'): string | undefined {
    if (!existsSync(file)) return undefined
    const target = `${file}.${kind}-${Date.now()}`
    try {
      copyFileSync(file, target)
      return target
    } catch {
      return undefined
    }
  }

  private emit(event: StoreLogEvent, notable: boolean, warn = false): void {
    if (this.log !== undefined) {
      this.log(event)
      return
    }
    if (!notable && !verboseStateLog()) return
    const line = formatStoreLog(event)
    if (warn) console.warn(line)
    else console.log(line)
  }
}
