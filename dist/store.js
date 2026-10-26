import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createContentStore, createInitialState } from './kernel.js';
const STORE_VERSION = 1;
export function defaultStorageDir() {
    const localAppData = process.env['LOCALAPPDATA'];
    if (process.platform === 'win32' && typeof localAppData === 'string' && localAppData.length > 0) {
        return join(localAppData, 'dsh-tui-bili-compaction', 'sessions');
    }
    const xdg = process.env['XDG_STATE_HOME'];
    const root = typeof xdg === 'string' && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state');
    return join(root, 'dsh-tui-bili-compaction', 'sessions');
}
function fileStem(sessionId) {
    const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    const readable = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
    return `${readable}-${digest}`;
}
function emptySession() {
    return { version: STORE_VERSION, state: createInitialState(), contentStore: createContentStore() };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function normalizeBlock(value) {
    if (!isRecord(value))
        return false;
    if (typeof value['blockId'] !== 'string' || value['blockId'].length === 0)
        return false;
    if (typeof value['runId'] !== 'string' || typeof value['summary'] !== 'string')
        return false;
    if (value['tier'] !== 1 && value['tier'] !== 2 && value['tier'] !== 3)
        return false;
    if (value['generation'] !== 'young' && value['generation'] !== 'old')
        return false;
    if (!stringArray(value['directMessageIds']))
        return false;
    if (!stringArray(value['effectiveMessageIds']))
        return false;
    if (!stringArray(value['directBlockIds']))
        return false;
    if (!finite(value['compressedTokens']) || !finite(value['createdAt']) || !finite(value['survivedCount']))
        return false;
    return typeof value['active'] === 'boolean';
}
function normalizeRefs(value) {
    if (!isRecord(value) || !isRecord(value['byRaw']) || !isRecord(value['byRef']))
        return undefined;
    const byRaw = Object.fromEntries(Object.entries(value['byRaw']).filter((entry) => typeof entry[1] === 'string'));
    const byRef = Object.fromEntries(Object.entries(value['byRef']).filter((entry) => typeof entry[1] === 'string'));
    return { byRaw, byRef };
}
function normalizeContentStore(value) {
    if (!isRecord(value) || !isRecord(value['byHash']) || !isRecord(value['byRef']))
        return createContentStore();
    const byHash = Object.fromEntries(Object.entries(value['byHash']).filter((entry) => typeof entry[1] === 'string'));
    const byRef = Object.fromEntries(Object.entries(value['byRef']).filter((entry) => {
        const entryValue = entry[1];
        return (isRecord(entryValue) &&
            typeof entryValue['ref'] === 'string' &&
            typeof entryValue['rawId'] === 'string' &&
            typeof entryValue['text'] === 'string' &&
            typeof entryValue['kind'] === 'string' &&
            finite(entryValue['tokens']) &&
            typeof entryValue['head'] === 'string');
    }));
    return { version: 1, byHash, byRef };
}
function positiveInt(value, fallback) {
    return finite(value) && value >= 1 ? Math.floor(value) : fallback;
}
function normalizeState(value) {
    const initial = createInitialState();
    if (!isRecord(value))
        return initial;
    const refs = normalizeRefs(value['messageRefs']);
    if (refs === undefined || !Array.isArray(value['blocks']))
        return initial;
    const seen = new Set();
    const blocks = value['blocks'].filter((block) => {
        if (!normalizeBlock(block))
            return false;
        const id = block.blockId;
        if (seen.has(id))
            return false;
        seen.add(id);
        return true;
    });
    const highestBlockId = blocks.reduce((highest, block) => {
        const match = /^b(\d+)$/.exec(block.blockId);
        return match === null ? highest : Math.max(highest, Number(match[1]));
    }, 0);
    const tokenSnapshot = isRecord(value['tokenSnapshot'])
        ? Object.fromEntries(Object.entries(value['tokenSnapshot']).filter((entry) => finite(entry[1])))
        : initial.tokenSnapshot;
    const nudgeValue = value['nudge'];
    const nudge = isRecord(nudgeValue) &&
        finite(nudgeValue['lastPerMessageNudgeTokens']) &&
        finite(nudgeValue['lastNudgeShownTokens']) &&
        finite(nudgeValue['baselineTokens']) &&
        isRecord(nudgeValue['anchors'])
        ? {
            lastPerMessageNudgeTokens: nudgeValue['lastPerMessageNudgeTokens'],
            lastNudgeShownTokens: nudgeValue['lastNudgeShownTokens'],
            baselineTokens: nudgeValue['baselineTokens'],
            anchors: Object.fromEntries(Object.entries(nudgeValue['anchors']).filter((entry) => finite(entry[1]))),
            lastShownByTier: isRecord(nudgeValue['lastShownByTier'])
                ? Object.fromEntries(Object.entries(nudgeValue['lastShownByTier']).filter((entry) => finite(entry[1])))
                : initial.nudge.lastShownByTier,
        }
        : initial.nudge;
    const statsValue = value['stats'];
    const stats = isRecord(statsValue)
        ? {
            ...initial.stats,
            ...Object.fromEntries(Object.entries(statsValue).filter((entry) => finite(entry[1]))),
        }
        : initial.stats;
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
    };
}
export class SessionStore {
    dir;
    cache = new Map();
    constructor(dir) {
        this.dir = dir !== undefined && dir.length > 0 ? dir : defaultStorageDir();
    }
    path(sessionId) {
        return join(this.dir, `${fileStem(sessionId)}.json`);
    }
    load(sessionId) {
        const cached = this.cache.get(sessionId);
        if (cached !== undefined)
            return cached;
        const file = this.path(sessionId);
        let loaded;
        if (!existsSync(file)) {
            loaded = emptySession();
        }
        else {
            try {
                const parsed = JSON.parse(readFileSync(file, 'utf8'));
                loaded = this.normalize(parsed);
            }
            catch {
                // A corrupt or older shape must never take the session down: start the
                // LSM over. dsh's own log still holds every message, so the only loss
                // is the compression bookkeeping.
                loaded = emptySession();
            }
        }
        this.cache.set(sessionId, loaded);
        return loaded;
    }
    normalize(parsed) {
        if (!isRecord(parsed))
            return emptySession();
        return {
            version: STORE_VERSION,
            state: normalizeState(parsed['state']),
            contentStore: normalizeContentStore(parsed['contentStore']),
        };
    }
    save(sessionId, value) {
        this.cache.set(sessionId, value);
        mkdirSync(this.dir, { recursive: true });
        const target = this.path(sessionId);
        const temp = `${target}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(value), 'utf8');
        try {
            renameSync(temp, target);
        }
        catch (error) {
            rmSync(temp, { force: true });
            throw error;
        }
    }
    reset(sessionId, nextBlockId) {
        const fresh = emptySession();
        if (nextBlockId !== undefined && nextBlockId > fresh.state.nextBlockId) {
            fresh.state.nextBlockId = nextBlockId;
        }
        this.save(sessionId, fresh);
        return fresh;
    }
}
//# sourceMappingURL=store.js.map