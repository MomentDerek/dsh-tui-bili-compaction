import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveOptions } from '../dist/config.js'
import { CompactionEngine } from '../dist/engine.js'
import { stripNativeCompaction } from '../dist/index.js'
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

test('session store round-trips kernel state and falls back on corruption', () => {
  const dir = temporaryDir()
  try {
    const store = new SessionStore(dir)
    assert.equal(store.path('abc').startsWith(dir), true)

    store.save('abc', {
      version: 1,
      state: { blocks: [{ blockId: 'b00001' }] },
      contentStore: { entries: {} },
    })
    const loaded = store.load('abc')
    assert.equal(loaded.state.blocks.length, 1)
    assert.deepEqual(loaded.contentStore, { entries: {} })
    assert.equal(JSON.parse(readFileSync(store.path('abc'), 'utf8')).version, 1)

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

test('native compaction rows are disabled, including group rows', () => {
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

    const options = resolveOptions({ storageDir: dir, modelContextLimit: 40_000 })
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
