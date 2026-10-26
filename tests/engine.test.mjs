import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { resolveOptions } from '../dist/config.js'
import { CompactionEngine } from '../dist/engine.js'
import { apply, stripNativeCompaction } from '../dist/index.js'
import { createContentStore, createInitialState } from '../dist/kernel.js'
import { BLOCK_SOURCE_KIND, buildKernelView } from '../dist/session-view.js'
import { SessionStore, defaultStorageDir } from '../dist/store.js'

/**
 * A structural stand-in for `@deepseek-ai/dsh-session`'s `Session`.
 *
 * It keeps the same contract the plugin relies on: an append-only event log,
 * `surfaceOp: 'append'` messages that become surface nodes, and `surfaceOp:
 * {op:'replace'}` messages that shadow a seq range.
 */
class FakeSession {
  constructor(id = 'session-test') {
    this.id = id
    this.events = []
    this.surfaceNodes = []
  }

  get seq() {
    return this.events.length
  }

  get surface() {
    return { nodes: this.surfaceNodes }
  }

  eventAt(seq) {
    return this.events[seq]
  }

  deriveEventMessage(event) {
    return event?.message ?? null
  }

  append(type, data, options) {
    const seq = this.events.length
    const surfaceOp = options?.surfaceOp
    this.events.push({ seq, type, data, message: data, surfaceOp, sourceEventSeqs: options?.sourceEventSeqs })
    if (surfaceOp === 'append') {
      this.surfaceNodes.push(seq)
    } else if (surfaceOp !== undefined && typeof surfaceOp === 'object') {
      const { startSeq, endSeq } = surfaceOp
      this.surfaceNodes = this.surfaceNodes.filter((node) => node < startSeq || node > endSeq)
      this.surfaceNodes.push(seq)
    }
    return { seq }
  }

  /** Append one original (never-rewritten) message to the log. */
  push(message) {
    const type = message.role === 'tool' ? 'tool/result' : `${message.role}/message`
    return this.append(type, message, { surfaceOp: 'append' })
  }
}

function userMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistantMessage(id, text) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'test', model: 'test-model' },
  }
}

function filler(chars) {
  return 'lorem ipsum dolor sit amet '.repeat(Math.ceil(chars / 27)).slice(0, chars)
}

function temporaryDir() {
  return mkdtempSync(join(tmpdir(), 'bili-compaction-test-'))
}

test('session store normalizes valid state and discards malformed entries', () => {
  const dir = temporaryDir()
  try {
    const store = new SessionStore(dir)
    assert.equal(store.path('abc').startsWith(dir), true)

    const state = createInitialState()
    store.save('abc', { version: 1, state, contentStore: createContentStore() })
    const loaded = new SessionStore(dir).load('abc')
    assert.equal(loaded.state.blocks.length, 0)
    assert.equal(loaded.state.nextBlockId, 1)
    assert.deepEqual(loaded.state.messageRefs, { byRaw: {}, byRef: {} })
    assert.equal(loaded.contentStore.version, 1)

    // A persisted block missing every required field is dropped, and a
    // malformed content store falls back to a fresh one instead of crashing.
    store.save('abc', {
      version: 1,
      state: { blocks: [{ blockId: 'b00001' }], messageRefs: { byRaw: {}, byRef: {} } },
      contentStore: { entries: {} },
    })
    const normalized = new SessionStore(dir).load('abc')
    assert.deepEqual(normalized.state.blocks, [])
    assert.equal(normalized.contentStore.version, 1)
    assert.deepEqual(normalized.contentStore.byHash, {})

    store.save('abc', {
      version: 1,
      state: { ...createInitialState(), nextBlockId: 'not-a-number', nextRunId: -3 },
      contentStore: createContentStore(),
    })
    const fixedAllocator = new SessionStore(dir).load('abc')
    assert.equal(fixedAllocator.state.nextBlockId, 1)
    assert.equal(fixedAllocator.state.nextRunId, 1)

    writeFileSync(store.path('abc'), '{ not json')
    // A fresh store has no cache, so the corrupt file is what it reads.
    const recovered = new SessionStore(dir).load('abc')
    assert.deepEqual(recovered.state.blocks, [])
    assert.equal(typeof recovered.contentStore, 'object')

    store.reset('abc')
    const fresh = store.load('abc')
    assert.deepEqual(fresh.state.blocks, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('default storage dir is a directory path', () => {
  const dir = defaultStorageDir()
  assert.equal(typeof dir, 'string')
  assert.equal(dir.length > 0, true)
})

test('legacy stripNativeCompaction rewrites synthesised rows, including groups', () => {
  const config = {
    plugins: [
      { id: 'keep', name: '@deepseek-ai/dsh-base' },
      { id: 'basic', name: '@deepseek-ai/dsh-compaction-basic', config: { auto: true } },
      {
        id: 'group',
        group: true,
        config: [
          { id: 'compact', name: '@deepseek-ai/dsh-command-compact' },
          { id: 'other', name: 'some-other-plugin' },
        ],
      },
    ],
  }
  const { config: next, changed } = stripNativeCompaction(config)
  assert.equal(changed, 2)
  assert.equal(next.plugins[1].disabled, true)
  assert.equal(next.plugins[1].config.auto, true)
  assert.equal(next.plugins[2].config[0].disabled, true)
  assert.equal(next.plugins[2].config[1].disabled, undefined)
  assert.equal(next.plugins[0].disabled, undefined)
  // The original object is never mutated.
  assert.equal(config.plugins[1].disabled, undefined)

  assert.equal(stripNativeCompaction({ plugins: [{ id: 'x' }] }).changed, 0)
  assert.equal(stripNativeCompaction(null).changed, 0)
})

test('disableNativeCompaction patches the live preset compaction service', async () => {
  const dir = temporaryDir()
  try {
    const service = {
      compactIfNeeded: () => 'original-auto',
      compactNow: () => 'original-manual',
    }
    const pruner = {
      pruneContent: () => ['original-content'],
      pruneSession: () => 'original-session',
    }
    const listeners = new Map()
    const cleanups = []
    const ctx = {
      on(event, listener) {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
      get(name) {
        if (name === 'agentPresets') {
          return {
            serviceFor: (_agent, serviceName) => {
              if (serviceName === 'compaction') return service
              if (serviceName === 'toolResultPruner') return pruner
              return undefined
            },
          }
        }
        if (name === 'tools') return { register: () => () => {} }
        return undefined
      },
      effect(callback) {
        cleanups.push(callback())
      },
    }

    apply(ctx, { storageDir: dir })
    const session = new FakeSession()
    session.push(userMessage('u1', filler(400)))
    const created = listeners.get('agent/created')
    assert.equal(typeof created, 'function')
    await created({ agent: { session }, source: 'fresh' })
    // Pressure compaction belongs to this engine; overflow recovery must still
    // reach the native implementation.
    assert.equal(await service.compactIfNeeded({}, 'pressure', undefined), null)
    assert.equal(await service.compactIfNeeded({}, 'context-overflow', undefined), 'original-auto')
    // The pruner stays untouched so overflow recovery can shrink tool results.
    assert.deepEqual(pruner.pruneContent(), ['original-content'])
    assert.equal(pruner.pruneSession(), 'original-session')

    const step = listeners.get('agent/pre-step')
    assert.equal(typeof step, 'function')
    await step({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))

    assert.equal(await service.compactIfNeeded({}, 'pressure', undefined), null)
    assert.equal(await service.compactIfNeeded({}, 'context-overflow', undefined), 'original-auto')
    await assert.rejects(service.compactNow, (error) => {
      assert.equal(error.name, 'ManualCompactionError')
      assert.equal(error.code, 'cancelled')
      assert.match(error.message, /native compaction is disabled/)
      return true
    })

    for (const cleanup of cleanups) cleanup?.()
    assert.equal(service.compactIfNeeded(), 'original-auto')
    assert.equal(service.compactNow(), 'original-manual')
    assert.deepEqual(pruner.pruneContent(), ['original-content'])
    assert.equal(pruner.pruneSession(), 'original-session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native guard falls back to the agent preset context', async () => {
  const dir = temporaryDir()
  const originalWarn = console.warn
  try {
    const service = {
      compactIfNeeded: () => 'original-auto',
      compactNow: () => 'original-manual',
    }
    const listeners = new Map()
    const cleanups = []
    const ctx = {
      on(event, listener) {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
      get(name) {
        if (name === 'tools') return { register: () => () => {} }
        return undefined
      },
      effect(callback) {
        cleanups.push(callback())
      },
    }
    console.warn = () => {}

    apply(ctx, { storageDir: dir })
    const session = new FakeSession()
    const agent = {
      session,
      ctx: {
        get(name) {
          return name === 'compaction' ? service : undefined
        },
      },
    }
    await listeners.get('agent/created')({ agent, source: 'fresh' })
    assert.equal(await service.compactIfNeeded({}, 'pressure', undefined), null)
    assert.equal(await service.compactIfNeeded({}, 'context-overflow', undefined), 'original-auto')

    for (const cleanup of cleanups) cleanup?.()
    assert.equal(service.compactIfNeeded(), 'original-auto')
  } finally {
    console.warn = originalWarn
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native guard throws the harness ManualCompactionError when it is resolvable', async () => {
  const dir = temporaryDir()
  try {
    const packageDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-compaction')
    mkdirSync(join(packageDir, 'lib'), { recursive: true })
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@deepseek-ai/dsh-compaction',
        version: '0.0.0-test',
        type: 'module',
        exports: './lib/index.js',
      }),
    )
    const modulePath = join(packageDir, 'lib', 'index.js')
    writeFileSync(
      modulePath,
      "export class ManualCompactionError extends Error { constructor(code, message) { super(message); this.code = code; this.name = 'ManualCompactionError' } }\n",
    )

    const service = { compactNow: () => 'original-manual' }
    const listeners = new Map()
    const cleanups = []
    const ctx = {
      on(event, listener) {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
      get(name) {
        if (name === 'agentPresets') return { serviceFor: (_agent, name) => (name === 'compaction' ? service : undefined) }
        if (name === 'tools') return { register: () => () => {} }
        return undefined
      },
      effect(callback) {
        cleanups.push(callback())
      },
    }

    apply(ctx, { storageDir: dir })
    const session = new FakeSession()
    const agent = { session, ctx: { baseUrl: pathToFileURL(dir).href } }
    await listeners.get('agent/created')({ agent, source: 'fresh' })

    let caught
    try {
      await service.compactNow()
    } catch (error) {
      caught = error
    }
    assert.ok(caught, 'compactNow must throw while the guard is active')
    const { ManualCompactionError } = await import(pathToFileURL(modulePath).href)
    assert.equal(caught instanceof ManualCompactionError, true)
    assert.equal(caught.code, 'cancelled')
    assert.match(caught.message, /native compaction is disabled/)

    for (const cleanup of cleanups) cleanup?.()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('kernel view folds append-origin events and numbers refs from the log', () => {
  const session = new FakeSession()
  session.push({ id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }] })
  session.push(userMessage('u1', 'first question'))
  session.push(assistantMessage('a1', 'first answer'))
  session.push({ id: 'call', role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' }] })
  session.push({ id: 'res', role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] })
  // A replacement written by this plugin must never re-enter the view.
  session.append('user/message', {
    id: 'acp_block_b00001',
    role: 'user',
    content: [{ type: 'text', text: '[Compressed conversation section]' }],
    source: { kind: BLOCK_SOURCE_KIND, blockId: 'b00001' },
  }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] })

  const view = buildKernelView(session)
  assert.deepEqual(view.entries.map((entry) => entry.seq), [0, 1, 2, 3, 4])
  assert.equal(view.messages.length, 5)

  const first = view.messages[0]
  assert.equal(first.role, 'system')
  assert.equal(first.ledgerSeq, 1)
  assert.equal(view.protectedIds.has('sys#0'), true)

  const call = view.messages.find((message) => message.contentType === 'tool-call')
  assert.equal(call.toolName, 'read')
  assert.equal(call.toolCallId, 'call_1')
  assert.equal(call.ledgerSeq, 4)

  const result = view.messages.find((message) => message.contentType === 'tool-result')
  assert.equal(result.toolCallId, 'call_1')

  // Refs follow the log: seq N is m{N+1}.
  assert.equal(view.seqOf.get('u1#0'), 1)
  assert.equal(view.seqOf.get('res#0'), 4)
})

test('compress commits a durable surface replacement and decompress restores it', () => {
  const dir = temporaryDir()
  try {
    const session = new FakeSession()
    session.push(userMessage('u1', filler(400)))
    session.push(assistantMessage('a1', filler(2200)))
    session.push(userMessage('u2', filler(2200)))
    session.push(assistantMessage('a2', filler(2200)))
    session.push(userMessage('u3', filler(2200)))
    session.push(assistantMessage('a3', filler(2200)))
    session.push(userMessage('u4', 'young tail'))

    const options = resolveOptions({
      storageDir: dir,
      modelContextLimit: 40_000,
      kernel: { preserveRecentMessages: 0, preserveRecentTokens: 0 },
    })
    const engine = new CompactionEngine(options, new SessionStore(dir))

    const refreshed = engine.refresh(session)
    assert.equal(refreshed.tokenCount > 0, true)

    const applied = engine.compress(session, {
      content: JSON.stringify([
        {
          startId: 'm00002',
          endId: 'm00004',
          summary: '## Key Technical Concepts\nFolded the first three turns of filler text.',
        },
      ]),
    })
    assert.equal(applied.ok, true, applied.text)

    const replacements = session.events.filter((event) => typeof event.surfaceOp === 'object')
    assert.equal(replacements.length, 1)
    const replacement = replacements[0]
    assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 3 })
    assert.deepEqual(replacement.sourceEventSeqs, [1, 2, 3])
    assert.equal(replacement.data.source.kind, BLOCK_SOURCE_KIND)
    assert.match(replacement.data.content[0].text, /^\[Compressed conversation section\]/)
    assert.match(replacement.data.content[0].text, /Key Technical Concepts/)

    // dsh's own fold: the replaced nodes leave the surface, one takes their place.
    assert.deepEqual(session.surfaceNodes, [0, 4, 5, 6, 7])

    const blockId = replacement.data.source.blockId
    assert.match(blockId, /^b\d+$/)

    const status = engine.status(session)
    assert.match(status, new RegExp(blockId))
    assert.match(status, /1 active/)

    const restored = engine.decompress(session, blockId)
    assert.match(restored, /lorem ipsum/)
    assert.match(restored, /3 item\(s\)/)

    // A later turn must not resurrect or re-compress the folded range.
    session.push(assistantMessage('a4', filler(200)))
    const again = engine.refresh(session)
    assert.equal(again.tokenCount > 0, true)
    assert.equal(session.events.filter((event) => typeof event.surfaceOp === 'object').length, 1)
    assert.match(engine.status(session), new RegExp(blockId))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status advertises only refs the kernel will actually fold', () => {
  const dir = temporaryDir()
  try {
    const session = new FakeSession()
    session.push({ id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }] })
    session.push(userMessage('u1', filler(2400)))
    session.push(assistantMessage('a1', filler(2400)))
    session.push(userMessage('u2', filler(2400)))
    session.push(assistantMessage('a2', filler(2400)))
    session.push(userMessage('u3', 'young tail'))

    const options = resolveOptions({
      storageDir: dir,
      modelContextLimit: 40_000,
      kernel: { preserveRecentMessages: 0, preserveRecentTokens: 0 },
    })
    const engine = new CompactionEngine(options, new SessionStore(dir))
    engine.refresh(session)
    const status = engine.status(session)

    // The protected system prompt must never leak as a literal "BLOCKED" ref.
    assert.equal(status.includes('BLOCKED'), false, status)
    assert.equal(status.includes('refs unresolvable'), false, status)
    assert.match(status, /Compressible ranges \(\d+, oldest first\)/)

    const line = status
      .split('\n')
      .find((entry) => /^\s+m\d{5}–m\d{5}/.test(entry) && !entry.includes('protected'))
    assert.ok(line, status)
    const [startId, endId] = line.match(/m\d{5}–m\d{5}/)[0].split('–')

    const applied = engine.compress(session, {
      content: JSON.stringify([
        { startId, endId, summary: '## Folding\nFolded the advertised range verbatim, keeping every filler turn in one section.' },
      ]),
    })
    assert.equal(applied.ok, true, `${applied.text}\n\nadvertised: ${line}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status hides ranges another compactor already folded', () => {
  const dir = temporaryDir()
  try {
    const session = new FakeSession()
    session.push(userMessage('u1', filler(6000)))
    session.push(assistantMessage('a1', filler(6000)))
    session.push(userMessage('u2', filler(6000)))
    // A native/foreign checkpoint folds the first two original messages. The
    // append-origin view still contains them, but they are no longer surface
    // nodes and must not be advertised as compressible.
    session.append(
      'user/message',
      {
        id: 'native_compaction_summary',
        role: 'user',
        content: [{ type: 'text', text: '[native summary]' }],
        source: { kind: 'native-compaction' },
      },
      { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] },
    )

    const options = resolveOptions({
      storageDir: dir,
      modelContextLimit: 40_000,
      kernel: { preserveRecentMessages: 0, preserveRecentTokens: 0 },
    })
    const engine = new CompactionEngine(options, new SessionStore(dir))
    engine.refresh(session)
    const status = engine.status(session)
    assert.equal(status.includes('m00002'), false, status)
    assert.match(status, /hidden — no longer on the current dsh surface/, status)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a partial multi-block range is rejected before any durable write', () => {
  const dir = temporaryDir()
  try {
    const session = new FakeSession()
    session.push(userMessage('u1', filler(400)))
    session.push({
      id: 'a1',
      role: 'assistant',
      content: [
        { type: 'text', text: filler(6000) },
        { type: 'reasoning', text: filler(6000) },
      ],
      source: { kind: 'model', provider: 'test', model: 'test-model' },
    })
    session.push(userMessage('u2', filler(400)))

    const options = resolveOptions({
      storageDir: dir,
      modelContextLimit: 40_000,
      kernel: { preserveRecentMessages: 0, preserveRecentTokens: 0 },
    })
    const store = new SessionStore(dir)
    const engine = new CompactionEngine(options, store)
    engine.refresh(session)

    const partial = engine.compress(session, {
      content: JSON.stringify([
        {
          startId: 'm00002',
          endId: 'm00002',
          summary: '## Partial\nThis must not be committed because it misses the reasoning sibling entirely.',
        },
      ]),
    })
    assert.equal(partial.ok, false)
    assert.match(partial.text, /covers only part of its content/)
    assert.match(partial.text, /No durable replacement was written/)
    assert.equal(session.events.filter((event) => typeof event.surfaceOp === 'object').length, 0)
    assert.deepEqual(session.surfaceNodes, [0, 1, 2])
    assert.deepEqual(store.load(session.id).state.blocks, [])

    const full = engine.compress(session, {
      content: JSON.stringify([
        {
          startId: 'm00002',
          endId: 'm00003',
          summary: '## Full event\nBoth the visible text and its reasoning sibling are covered by this fold.',
        },
      ]),
    })
    assert.equal(full.ok, true, full.text)

    const replacements = session.events.filter((event) => typeof event.surfaceOp === 'object')
    assert.equal(replacements.length, 1)
    assert.deepEqual(replacements[0].surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 })
    assert.deepEqual(session.surfaceNodes, [0, 2, 3])
    assert.equal(engine.decompress(session, replacements[0].data.source.blockId).includes('lorem ipsum'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rejected commit does not persist an active block', () => {
  const dir = temporaryDir()
  try {
    const session = new FakeSession()
    session.push(userMessage('u1', filler(6000)))
    session.push({
      id: 'img',
      role: 'user',
      content: [
        { type: 'text', text: 'look at this image' },
        { type: 'image', data: 'base64-image-bytes' },
      ],
      source: { kind: 'user' },
    })
    session.push(userMessage('u2', filler(6000)))

    const options = resolveOptions({
      storageDir: dir,
      modelContextLimit: 40_000,
      kernel: { preserveRecentMessages: 0, preserveRecentTokens: 0 },
    })
    const store = new SessionStore(dir)
    const engine = new CompactionEngine(options, store)
    engine.refresh(session)

    const rejected = engine.compress(session, {
      content: JSON.stringify([
        {
          startId: 'm00001',
          endId: 'm00003',
          summary: '## Rejected\nA media-bearing message sits in the middle and must keep this fold from landing.',
        },
      ]),
    })
    assert.equal(rejected.ok, false)
    assert.match(rejected.text, /the span contains img/)
    assert.equal(session.events.filter((event) => typeof event.surfaceOp === 'object').length, 0)
    assert.deepEqual(store.load(session.id).state.blocks, [])

    // The failed batch must not make the older messages look covered.
    const retry = engine.compress(session, {
      content: JSON.stringify([
        {
          startId: 'm00001',
          endId: 'm00001',
          summary: '## Retry\nOnly the first user message is folded now; the image message remains visible.',
        },
      ]),
    })
    assert.equal(retry.ok, true, retry.text)
    assert.equal(session.events.filter((event) => typeof event.surfaceOp === 'object').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('explicit compress keeps the protected recent tail visible', () => {
  const dir = temporaryDir()
  try {
    const session = new FakeSession()
    session.push(userMessage('u1', filler(3000)))
    session.push(assistantMessage('a1', filler(3000)))
    session.push(userMessage('u2', filler(3000)))
    session.push(assistantMessage('a2', filler(3000)))
    session.push(userMessage('u3', 'THE LATEST USER QUESTION — must stay visible'))

    const options = resolveOptions({
      storageDir: dir,
      modelContextLimit: 60_000,
      kernel: { preserveRecentMessages: 2, preserveRecentTokens: 0 },
    })
    const store = new SessionStore(dir)
    const engine = new CompactionEngine(options, store)
    engine.refresh(session)

    const applied = engine.compress(session, {
      content: JSON.stringify([
        {
          startId: 'm00001',
          endId: 'm00005',
          summary: '## Older turns\nThis fold may keep the recent user question and its answer outside the block.',
        },
      ]),
    })
    assert.equal(applied.ok, true, applied.text)
    assert.equal(session.surfaceNodes.includes(4), true)

    const block = store.load(session.id).state.blocks.find((entry) => entry.active)
    assert.ok(block)
    assert.equal(block.effectiveMessageIds.includes('u3#0'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session-advertised window replaces the static default', () => {
  const dir = temporaryDir()
  try {
    const session = new FakeSession()
    session.push(userMessage('u1', filler(400)))
    session.requestContext = () => ({ contextWindow: 8000 })

    const defaultOptions = resolveOptions({ storageDir: dir })
    const defaultEngine = new CompactionEngine(defaultOptions, new SessionStore(dir))
    const auto = defaultEngine.status(session, { totalTokens: 4000, surfaceTokens: 4000, nodes: [] })
    assert.match(auto, /8\.0K/)

    // An operator-pinned limit stays authoritative even when the route
    // advertises a different window.
    const pinnedOptions = resolveOptions({ storageDir: dir, modelContextLimit: 40_000 })
    const pinnedEngine = new CompactionEngine(pinnedOptions, new SessionStore(dir))
    const pinned = pinnedEngine.status(session, { totalTokens: 4000, surfaceTokens: 4000, nodes: [] })
    assert.match(pinned, /40\.0K/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a suppressed nudge does not advance the watermark', () => {
  const dir = temporaryDir()
  try {
    const session = new FakeSession()
    session.push(userMessage('u1', filler(6000)))
    session.push(assistantMessage('a1', filler(6000)))
    session.push(userMessage('u2', filler(6000)))
    session.push(assistantMessage('a2', filler(6000)))
    session.push(userMessage('u3', 'young tail'))

    const options = resolveOptions({
      storageDir: dir,
      modelContextLimit: 40_000,
      kernel: { preserveRecentMessages: 0, preserveRecentTokens: 0 },
    })
    const store = new SessionStore(dir)
    const engine = new CompactionEngine(options, store)
    // The plugin's pre-step passes advanceNudge:false whenever it will not
    // deliver the nudge, so an undelivered prompt has to stay pending.
    const refreshed = engine.refresh(
      session,
      { totalTokens: 30_000, surfaceTokens: 30_000, nodes: [] },
      { advanceNudge: false },
    )
    assert.equal(refreshed.decision?.shouldInject, true)
    assert.equal(store.load(session.id).state.nudge.lastNudgeShownTokens, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read-only status does not consume the nudge watermark', () => {
  const dir = temporaryDir()
  try {
    const session = new FakeSession()
    session.push(userMessage('u1', filler(30_000)))
    session.push(assistantMessage('a1', filler(30_000)))

    const options = resolveOptions({ storageDir: dir, modelContextLimit: 8000 })
    const store = new SessionStore(dir)
    const engine = new CompactionEngine(options, store)
    engine.refresh(session)
    const before = store.load(session.id).state.nudge
    engine.status(session, { totalTokens: 15_000, surfaceTokens: 15_000, nodes: [] })
    assert.deepEqual(store.load(session.id).state.nudge, before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reset resumes block ids above checkpoints already in the log', () => {
  const dir = temporaryDir()
  try {
    const session = new FakeSession()
    session.push(userMessage('u1', filler(6000)))
    session.push(assistantMessage('a1', filler(6000)))
    const options = resolveOptions({
      storageDir: dir,
      modelContextLimit: 40_000,
      kernel: { preserveRecentMessages: 0, preserveRecentTokens: 0 },
    })
    const store = new SessionStore(dir)
    const engine = new CompactionEngine(options, store)
    engine.refresh(session)
    const applied = engine.compress(session, {
      content: JSON.stringify([
        { startId: 'm00001', endId: 'm00002', summary: '## First block\nThis summary is long enough for the kernel to accept it as a real fold.' },
      ]),
    })
    assert.equal(applied.ok, true, applied.text)
    assert.equal(store.load(session.id).state.nextBlockId, 2)

    engine.reset(session)
    assert.equal(store.load(session.id).state.nextBlockId, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('compress rejects an unknown ref instead of folding the log', () => {
  const dir = temporaryDir()
  try {
    const session = new FakeSession()
    session.push(userMessage('u1', filler(200)))
    session.push(assistantMessage('a1', filler(6000)))

    const options = resolveOptions({ storageDir: dir, modelContextLimit: 40_000 })
    const engine = new CompactionEngine(options, new SessionStore(dir))
    engine.refresh(session)

    const applied = engine.compress(session, {
      content: JSON.stringify([{ startId: 'm09001', endId: 'm09002', summary: 'nothing' }]),
    })
    assert.equal(applied.ok, false)
    assert.equal(session.events.filter((event) => typeof event.surfaceOp === 'object').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
