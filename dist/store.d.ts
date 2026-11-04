import type { CompressionState, MessageContentStore } from './kernel.js';
/**
 * Durable per-session kernel state.
 *
 * The kernel is pure: it never touches the disk. dsh's own log keeps the
 * messages, so this store only has to remember the 3-tier LSM bookkeeping
 * (blocks, refs, nudge watermarks) plus the CCR content store, which is a cache
 * of originals for cache-safe retrieval.
 */
export interface PersistedSession {
    version: 1;
    state: CompressionState;
    contentStore: MessageContentStore;
}
/** One durable-state event; emitted on every load/save and on refused writes. */
export type StoreLogAction = 'load' | 'save' | 'reset' | 'refuse-empty' | 'corrupt';
export interface StoreLogEvent {
    action: StoreLogAction;
    sessionId: string;
    /** Path of the state file the event belongs to. */
    file: string;
    blocks: number;
    active: number;
    refs: number;
    /** Kernel `stats.compressionCount`: how many folds the state remembers. */
    folded: number;
    /** Kernel `stats.tokensCompressed`: cumulative tokens the folds reclaimed. */
    tokens: number;
    detail?: string;
}
export type StoreLogger = (event: StoreLogEvent) => void;
interface SaveOptions {
    /** Allow a zero-block write (reset); normal saves refuse it. */
    allowEmpty?: boolean;
    /** Log label; `reset` reuses the save path. */
    action?: 'save' | 'reset';
    detail?: string;
}
export declare function defaultStorageDir(): string;
export declare class SessionStore {
    private readonly dir;
    private readonly log?;
    private readonly cache;
    constructor(dir?: string, log?: StoreLogger);
    path(sessionId: string): string;
    load(sessionId: string): PersistedSession;
    private normalize;
    /**
     * Persist one session state.
     *
     * A `blocks === 0` state written over one that had blocks means the kernel
     * lost its LSM (the resume/fork path can hand back a fresh state while the
     * log is intact). The file on disk is then the only copy of the folds, so it
     * is backed up and the write is refused instead of letting a stale empty view
     * erase it. `reset` opts in with `allowEmpty`.
     */
    save(sessionId: string, value: PersistedSession, options?: SaveOptions): void;
    reset(sessionId: string, nextBlockId?: number): PersistedSession;
    /** Read a state file for comparison without caching or reporting it. */
    private peek;
    /** Copy a file aside before it is replaced or abandoned. Best effort. */
    private backup;
    private emit;
}
export {};
//# sourceMappingURL=store.d.ts.map