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
export declare function defaultStorageDir(): string;
export declare class SessionStore {
    private readonly dir;
    private readonly cache;
    constructor(dir?: string);
    path(sessionId: string): string;
    load(sessionId: string): PersistedSession;
    private normalize;
    save(sessionId: string, value: PersistedSession): void;
    reset(sessionId: string, nextBlockId?: number): PersistedSession;
}
//# sourceMappingURL=store.d.ts.map