import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

export class SessionStore {
  private readonly dir: string
  private readonly cache = new Map<string, PersistedSession>()

  constructor(dir?: string) {
    this.dir = dir !== undefined && dir.length > 0 ? dir : defaultStorageDir()
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
    } else {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        loaded = this.normalize(parsed)
      } catch {
        // A corrupt or older shape must never take the session down: start the
        // LSM over. dsh's own log still holds every message, so the only loss
        // is the compression bookkeeping.
        loaded = emptySession()
      }
    }
    this.cache.set(sessionId, loaded)
    return loaded
  }

  private normalize(parsed: unknown): PersistedSession {
    if (typeof parsed !== 'object' || parsed === null) return emptySession()
    const record = parsed as { version?: unknown; state?: unknown; contentStore?: unknown }
    const state = record.state
    const contentStore = record.contentStore
    const validState =
      typeof state === 'object' &&
      state !== null &&
      Array.isArray((state as { blocks?: unknown }).blocks) &&
      typeof (state as { messageRefs?: unknown }).messageRefs === 'object'
    const validStore = typeof contentStore === 'object' && contentStore !== null
    return {
      version: STORE_VERSION,
      state: validState ? (state as CompressionState) : createInitialState(),
      contentStore: validStore ? (contentStore as MessageContentStore) : createContentStore(),
    }
  }

  save(sessionId: string, value: PersistedSession): void {
    this.cache.set(sessionId, value)
    mkdirSync(this.dir, { recursive: true })
    const target = this.path(sessionId)
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(value), 'utf8')
    try {
      renameSync(temp, target)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }

  reset(sessionId: string): PersistedSession {
    const fresh = emptySession()
    this.save(sessionId, fresh)
    return fresh
  }
}
