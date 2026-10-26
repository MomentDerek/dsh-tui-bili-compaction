import {
  createInitialState
} from "../chunk-KW5XKWQH.js";

// src/persist/store.ts
import { createHash } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
var StateStore = class {
  enabled;
  dir;
  version;
  debounceMs;
  log;
  legacyFn;
  relPathFn;
  validateFn;
  foreignFileFn;
  codec;
  retryAttempts;
  retryBaseMs;
  retryMaxMs;
  timers = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  writeChains = /* @__PURE__ */ new Map();
  /** id → absolute path, populated by writes and loadAll. */
  discovered = /* @__PURE__ */ new Map();
  /** id → seq of the last COMMITTED write (sync or async). Async writers
   *  capture the seq at snapshot time and re-check it inside their
   *  synchronous commit block; a flushSync (or a newer committed write)
   *  bumping the seq makes the stale in-flight write abort its commit
   *  instead of clobbering the newer on-disk payload. */
  commitSeq = /* @__PURE__ */ new Map();
  /** id → cumulative write-failure count, for rate-limited alerting. */
  failCounts = /* @__PURE__ */ new Map();
  /** Monotonic counter for unique temp filenames within a process. */
  tmpSeq = 0;
  constructor(opts) {
    this.dir = opts.dir;
    this.version = opts.version;
    this.debounceMs = opts.debounceMs ?? 500;
    this.enabled = opts.enabled ?? true;
    this.log = opts.log ?? ((_level, _msg) => {
    });
    this.relPathFn = opts.relPath;
    this.legacyFn = opts.legacy;
    this.validateFn = opts.validate ?? defaultValidate;
    this.foreignFileFn = opts.foreignFile;
    this.codec = opts.codec;
    this.retryAttempts = Math.max(1, opts.retryAttempts ?? 6);
    this.retryBaseMs = Math.max(1, opts.retryBaseMs ?? 50);
    this.retryMaxMs = Math.max(this.retryBaseMs, opts.retryMaxMs ?? 1600);
  }
  /** Debounced save. Coalesces bursts; the builder runs at write time, so
   *  the freshest state is always persisted. Never throws. */
  scheduleSave(id, build) {
    if (!this.enabled) return;
    this.pending.set(id, build);
    const existing = this.timers.get(id);
    if (existing) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const builder = this.pending.get(id);
      this.pending.delete(id);
      if (!builder) return;
      void this.writeNow(id, builder).catch(() => {
      });
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }
  /** Immediate save, serialized per id. Rejects on write failure; a
   *  failing write never breaks the chain for the next one. */
  async writeNow(id, build) {
    if (!this.enabled) return;
    const prev = this.writeChains.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {
    }).then(() => this.writeInner(id, build));
    this.writeChains.set(id, next);
    next.finally(() => {
      if (this.writeChains.get(id) === next) this.writeChains.delete(id);
    }).catch(() => {
    });
    return next;
  }
  /** Synchronous flush for one id. Used where the caller cannot await
   *  (memory eviction, sync shutdown paths). Cancels any pending debounce
   *  timer. Returns true on success, false on failure — callers that use
   *  the result to drop in-memory state must NOT drop it on failure.
   *  Committing bumps the per-id fence so a stale in-flight async write
   *  cannot land its older payload after this returns. */
  flushSync(id, build) {
    if (!this.enabled) return true;
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
      this.pending.delete(id);
    }
    let payload;
    try {
      payload = build();
    } catch (e) {
      this.log("error", `[persist] builder failed for ${id}: ${errText(e)}`);
      return false;
    }
    const file = this.resolvePath(id, payload);
    const data = this.serialize(id, payload);
    let lastErr;
    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      const tmp = this.tempPath(file);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.atomicWriteDurable(tmp, data);
        fs.renameSync(tmp, file);
        lastErr = void 0;
        break;
      } catch (e) {
        lastErr = e;
        try {
          fs.unlinkSync(tmp);
        } catch {
        }
        if (!isTransientFsError(e) || attempt === this.retryAttempts - 1) break;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          this.backoffMs(attempt)
        );
      }
    }
    if (!lastErr) {
      this.discovered.set(id, file);
      this.clearFailure(id);
      this.bumpCommit(id);
      this.removeSpillSync(file);
      return true;
    }
    const spill = this.spillPathFor(file);
    let spillPath = null;
    for (let attempt = 0; attempt < this.retryAttempts && spillPath === null; attempt++) {
      try {
        fs.mkdirSync(path.dirname(spill), { recursive: true });
        this.atomicWriteDurable(spill, data);
        spillPath = spill;
      } catch (e) {
        if (!isTransientFsError(e) || attempt === this.retryAttempts - 1) break;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          this.backoffMs(attempt)
        );
      }
    }
    if (spillPath) this.discovered.set(id, spillPath);
    if (spillPath) this.bumpCommit(id);
    this.recordFailure(id, lastErr, spillPath);
    return spillPath !== null;
  }
  /** Load one record. Checks the discovered path (from a prior
   *  write/loadAll), an optional relative-path hint, and the flat default
   *  name. Returns null when absent, disabled, corrupt, or rejected by
   *  validate. The hint covers namespaced records the store has not
   *  discovered (e.g. an evicted session re-requested with its meta,
   *  where the path depends on data the store cannot reconstruct from
   *  the id alone). */
  loadSync(id, hint) {
    if (!this.enabled) return null;
    const candidates = [
      this.discovered.get(id),
      hint ? path.join(this.dir, hint) : void 0,
      path.join(this.dir, flatFileNameFor(id))
    ];
    for (const file of candidates) {
      if (!file) continue;
      const envelope = this.readEnvelope(file);
      if (envelope && envelope.id === id) return envelope;
    }
    return null;
  }
  /** Load every record under dir. Populates the discovery map (enables
   *  loadSync for namespaced relPaths). Skips corrupt files, `.tmp-*`
   *  orphans, declared foreign co-residents (`foreignFile`, before any
   *  read), and records whose filename does not match their id — one
   *  bad file never blocks boot. Never throws. */
  async loadAll() {
    const out = /* @__PURE__ */ new Map();
    if (!this.enabled) return out;
    const files = await this.walkJsonFiles(this.dir);
    for (const file of files) {
      if (this.foreignFileFn?.(file)) continue;
      const envelope = this.readEnvelope(file);
      if (!envelope) continue;
      const base = path.basename(file);
      const relBase = path.basename(
        this.relPathOf(envelope.id, envelope.payload)
      );
      const flatBase = flatFileNameFor(envelope.id);
      let owner = null;
      if (base === relBase || base === flatBase) {
        owner = envelope.id;
      } else if (base.endsWith(".fb.json")) {
        const canonicalBase = `${base.slice(0, -".fb.json".length)}.json`;
        if (canonicalBase === relBase || canonicalBase === flatBase) {
          owner = envelope.id;
        }
      }
      if (owner === null) {
        this.log(
          "warn",
          `[persist] skipping ${rel(file, this.dir)}: filename does not match record id`
        );
        continue;
      }
      const existing = out.get(owner);
      if (!existing || envelope.savedAt >= existing.savedAt) {
        out.set(owner, envelope);
        this.discovered.set(owner, file);
      }
    }
    return out;
  }
  /** Whether a debounced write is pending for an id. */
  hasPending(id) {
    return this.timers.has(id);
  }
  /** Ids with a pending debounced write. */
  pendingIds() {
    return [...this.timers.keys()];
  }
  /** Flush every pending debounced write immediately, then drain in-flight
   *  writes. For graceful shutdown (SIGTERM/SIGINT). Never rejects. */
  async flushAll() {
    const ids = this.pendingIds();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const builders = /* @__PURE__ */ new Map();
    for (const id of ids) {
      const build = this.pending.get(id);
      if (build) builders.set(id, build);
      this.pending.delete(id);
    }
    await Promise.all(
      [...builders.entries()].map(
        ([id, build]) => this.writeNow(id, build).catch((e) => {
          this.log(
            "error",
            `[persist] shutdown flush failed for ${id}: ${errText(e)}`
          );
        })
      )
    );
    await Promise.allSettled([...this.writeChains.values()]);
  }
  /** Cancel all pending debounced writes without flushing (tests). */
  cancelAll() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }
  async writeInner(id, build) {
    const baseSeq = this.commitSeq.get(id) ?? 0;
    let payload;
    try {
      payload = build();
    } catch (e) {
      this.log("error", `[persist] builder failed for ${id}: ${errText(e)}`);
      throw e;
    }
    const file = this.resolvePath(id, payload);
    const data = this.serialize(id, payload);
    let lastErr;
    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      const tmp = this.tempPath(file);
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(tmp, data);
        this.fsyncFile(tmp);
        if ((this.commitSeq.get(id) ?? 0) !== baseSeq) {
          await fsp.unlink(tmp).catch(() => {
          });
          return;
        }
        try {
          fs.renameSync(tmp, file);
        } catch (e) {
          lastErr = e;
          await fsp.unlink(tmp).catch(() => {
          });
          if (!isTransientFsError(e) || attempt === this.retryAttempts - 1)
            break;
          const { promise, resolve } = Promise.withResolvers();
          setTimeout(resolve, this.backoffMs(attempt));
          await promise;
          continue;
        }
        this.discovered.set(id, file);
        this.clearFailure(id);
        this.commitSeq.set(id, baseSeq + 1);
        await this.removeSpill(file);
        return;
      } catch (e) {
        lastErr = e;
        await fsp.unlink(tmp).catch(() => {
        });
        if (!isTransientFsError(e) || attempt === this.retryAttempts - 1) break;
        const { promise, resolve } = Promise.withResolvers();
        setTimeout(resolve, this.backoffMs(attempt));
        await promise;
      }
    }
    if ((this.commitSeq.get(id) ?? 0) !== baseSeq) return;
    const spill = this.spillPathFor(file);
    let spillPath = null;
    for (let attempt = 0; attempt < this.retryAttempts && spillPath === null; attempt++) {
      try {
        await fsp.mkdir(path.dirname(spill), { recursive: true });
        if ((this.commitSeq.get(id) ?? 0) !== baseSeq) return;
        this.atomicWriteDurable(spill, data);
        spillPath = spill;
      } catch (e) {
        if (!isTransientFsError(e) || attempt === this.retryAttempts - 1) break;
        const { promise, resolve } = Promise.withResolvers();
        setTimeout(resolve, this.backoffMs(attempt));
        await promise;
      }
    }
    if (spillPath) {
      this.discovered.set(id, spillPath);
      this.commitSeq.set(id, baseSeq + 1);
    }
    this.recordFailure(id, lastErr, spillPath);
    throw lastErr;
  }
  envelope(id, payload) {
    return { version: this.version, savedAt: Date.now(), id, payload };
  }
  /** Serialize an envelope for disk, applying the optional codec. Strings
   *  are written as UTF-8 (the fs default); Buffer results pass through as
   *  raw bytes. */
  serialize(id, payload) {
    const json = JSON.stringify(this.envelope(id, payload));
    return this.codec ? this.codec.encode(json) : json;
  }
  /** Absolute path for a record: custom relPath (guarded against path
   *  escape) or the flat hash default. */
  resolvePath(id, payload) {
    return path.join(this.dir, this.relPathOf(id, payload));
  }
  relPathOf(id, payload) {
    const custom = this.relPathFn?.(id, payload);
    if (!custom) return flatFileNameFor(id);
    const rel2 = path.normalize(custom);
    if (path.isAbsolute(rel2) || rel2.split(/[\\/]+/).includes("..")) {
      this.log(
        "warn",
        `[persist] relPath for ${id} escapes dir; using flat name`
      );
      return flatFileNameFor(id);
    }
    return rel2;
  }
  /** Unique temp file next to the destination (same dir ⇒ same volume ⇒
   *  rename is atomic). Prefixed `.tmp-` so loadAll skips orphans. */
  tempPath(dest) {
    const seq = this.tmpSeq++;
    return path.join(
      path.dirname(dest),
      `.tmp-${path.basename(dest, ".json")}-${process.pid}-${seq}`
    );
  }
  /** Durable synchronous write: open → write → fsync → close. Without the
   *  fsync the bytes sit in the page cache until the OS flushes them, so a
   *  power loss / kernel panic between this write and the rename leaves a
   *  size-correct, VDL=0 all-zero file on disk (#3157) — the metadata (size +
   *  cluster allocation) is journaled by NTFS but the user data is not. The
   *  fsync makes the DATA durable before the rename publishes the name. */
  atomicWriteDurable(file, data) {
    const fd = fs.openSync(file, "w");
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Make an already-written file durable by re-opening it and fsyncing.
   *  Re-opening is a valid minimal-diff way to flush a file written through
   *  an async handle before its rename publishes it (#3157). The handle must
   *  have write access ("r+"): on POSIX fsync is file-level (inode) so any fd
   *  works, but on Windows the flush goes through the handle
   *  (FlushFileBuffers) and a read-only one fails with EPERM — which would
   *  break every async state write on that platform. */
  fsyncFile(file) {
    const fd = fs.openSync(file, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  backoffMs(attempt) {
    return Math.min(this.retryBaseMs * 2 ** attempt, this.retryMaxMs);
  }
  /** Side file for a record whose canonical write keeps failing: the
   *  canonical name with a `.fb` (fallback) infix, e.g. `a.json` →
   *  `a.fb.json`. One slot per id, overwritten on each spill, so a stuck
   *  lock never accumulates files. Ends in `.json` so loadAll discovers it. */
  spillPathFor(file) {
    const base = path.basename(file);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : ".json";
    return path.join(path.dirname(file), `${stem}.fb${ext}`);
  }
  /** Remove a stale spill after a successful canonical write (best-effort). */
  async removeSpill(file) {
    await fsp.unlink(this.spillPathFor(file)).catch(() => {
    });
  }
  /** Advance the per-id commit fence after a successful synchronous
   *  commit, fencing off any in-flight async write holding an older
   *  snapshot. */
  bumpCommit(id) {
    this.commitSeq.set(id, (this.commitSeq.get(id) ?? 0) + 1);
  }
  removeSpillSync(file) {
    try {
      fs.unlinkSync(this.spillPathFor(file));
    } catch {
    }
  }
  /** Rate-limited failure alerting: log on the first failure and at each
   *  power-of-two count (1,2,4,8,…), so a long lock yields ~log2(N) lines
   *  instead of one per write. Includes the spill path so the operator can
   *  see where the data landed. */
  recordFailure(id, err, spillPath) {
    const count = (this.failCounts.get(id) ?? 0) + 1;
    this.failCounts.set(id, count);
    const alertAt = count === 1 || count >= 2 && (count & count - 1) === 0;
    if (!alertAt) return;
    const where = spillPath ? `; data spilled to ${rel(spillPath, this.dir)}` : "; SPILLOVER ALSO FAILED \u2014 data at risk";
    this.log(
      count === 1 ? "error" : "warn",
      `[persist] write failed for ${id} (total ${count}x): ${errText(err)}${where}`
    );
  }
  clearFailure(id) {
    this.failCounts.delete(id);
  }
  /** Parse + validate one file. Corrupt or invalid records return null
   *  (logged) instead of throwing — load paths must never block boot. */
  readEnvelope(file) {
    let parsed;
    try {
      const buf = fs.readFileSync(file);
      const text = this.codec ? this.codec.decode(buf) : buf.toString("utf8");
      parsed = JSON.parse(text);
    } catch (e) {
      if (e.code !== "ENOENT") {
        this.log(
          "warn",
          `[persist] skipping corrupt file ${rel(file, this.dir)}: ${errText(e)}`
        );
      }
      return null;
    }
    if (isEnvelopeLike(parsed)) {
      if (!this.validateFn(parsed)) {
        this.log(
          "warn",
          `[persist] skipping invalid record ${rel(file, this.dir)}`
        );
        return null;
      }
      return parsed;
    }
    const adopted = this.adoptLegacy(parsed);
    if (adopted) return adopted;
    this.log(
      "warn",
      `[persist] skipping invalid record ${rel(file, this.dir)}`
    );
    return null;
  }
  /** Wrap a legacy (pre-envelope) record as an envelope via the `legacy`
   *  hook, then validate the adopted payload like any other. */
  adoptLegacy(parsed) {
    const adoption = this.legacyFn ? this.legacyFn(parsed) : null;
    if (!adoption || typeof adoption.id !== "string" || adoption.id.length === 0 || adoption.payload == null) {
      return null;
    }
    const source = parsed;
    const envelope = {
      version: adoption.version ?? source.version ?? this.version,
      savedAt: adoption.savedAt ?? source.savedAt ?? 0,
      id: adoption.id,
      payload: adoption.payload
    };
    if (!this.validateFn(envelope)) return null;
    return envelope;
  }
  /** Iterative recursive walk (no readdir-recursive dependency), skipping
   *  `.tmp-*` names and non-.json files. */
  async walkJsonFiles(root) {
    const out = [];
    const queue = [root];
    while (queue.length > 0) {
      const dir = queue.pop();
      let dirents;
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        if (d.name.startsWith(".tmp-")) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) queue.push(full);
        else if (d.isFile() && d.name.endsWith(".json")) out.push(full);
      }
    }
    return out;
  }
};
function defaultValidate(envelope) {
  return typeof envelope.id === "string" && envelope.id.length > 0 && envelope.payload != null;
}
function isEnvelopeLike(value) {
  if (!value || typeof value !== "object") return false;
  const v = value;
  return typeof v.id === "string" && "payload" in v;
}
function flatFileNameFor(id) {
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24) + ".json";
}
function isTransientFsError(e) {
  const code = e.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOENT" || code === "ENOTDIR";
}
function errText(e) {
  return e instanceof Error ? e.message : String(e);
}
function rel(p, base) {
  const r = path.relative(base, p);
  return r && !r.startsWith("..") ? r : p;
}

// src/persist/state-merge.ts
function mergeCompressionState(parsed) {
  const fresh = createInitialState();
  return {
    blocks: parsed.blocks ?? fresh.blocks,
    messageRefs: parsed.messageRefs ?? fresh.messageRefs,
    nudge: { ...fresh.nudge, ...parsed.nudge ?? {} },
    stats: { ...fresh.stats, ...parsed.stats ?? {} },
    nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
    nextRunId: parsed.nextRunId ?? fresh.nextRunId,
    tokenSnapshot: parsed.tokenSnapshot ?? fresh.tokenSnapshot,
    absorbed: parsed.absorbed ?? fresh.absorbed,
    rules: parsed.rules ?? fresh.rules,
    nextRuleId: parsed.nextRuleId ?? fresh.nextRuleId,
    terminalStreak: parsed.terminalStreak
  };
}
export {
  StateStore,
  flatFileNameFor,
  mergeCompressionState
};
//# sourceMappingURL=index.js.map