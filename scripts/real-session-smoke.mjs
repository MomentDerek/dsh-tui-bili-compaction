// End-to-end smoke test against a REAL @deepseek-ai/dsh Session instance.
//
// The point of this script is the one thing the unit tests cannot prove: that
// dsh's own session validators accept the durable replacement our plugin emits
// (surfaceOp + sourceEventSeqs completeness), and that deriveMessages() then
// collapses the folded range.
//
// Usage: node scripts/real-session-smoke.mjs
// The dsh installation is located through `npm root -g`, PATH lookups, or the
// DSH_NODE_MODULES environment variable (the directory holding @deepseek-ai/dsh).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

function findDshModules() {
  const candidates = []
  if (process.env.DSH_NODE_MODULES) candidates.push(process.env.DSH_NODE_MODULES)
  // fnm/volta style shims put node.exe next to the global node_modules.
  candidates.push(join(dirname(process.execPath), 'node_modules'))
  candidates.push(join(dirname(dirname(process.execPath)), 'lib', 'node_modules'))
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  try {
    const root = execFileSync(npm, ['root', '-g'], { encoding: 'utf8' }).trim()
    if (root) candidates.push(root)
  } catch {}
  for (const dir of candidates) {
    const nested = join(dir, '@deepseek-ai', 'dsh', 'node_modules')
    if (existsSync(join(nested, '@deepseek-ai', 'dsh-session'))) return nested
    if (existsSync(join(dir, '@deepseek-ai', 'dsh-session'))) return dir
  }
  throw new Error('cannot locate the @deepseek-ai/dsh installation; set DSH_NODE_MODULES')
}

const modules = findDshModules()
const load = (spec) => import(pathToFileURL(join(modules, ...spec.split('/'))).href)

const { Session } = await load('@deepseek-ai/dsh-session/lib/index.js')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm/lib/types/message.js')
const { CompactionEngine } = await import('../dist/engine.js')
const { SessionStore } = await import('../dist/store.js')
const { buildKernelView } = await import('../dist/session-view.js')

const dir = mkdtempSync(join(tmpdir(), 'bili-compaction-smoke-'))
const options = {
  modelContextLimit: 1_000_000,
  disableNativeCompaction: false,
  storageDir: dir,
  languagePreservation: false,
  injectNudge: false,
  kernel: {},
}

try {
  const session = Session.create('smoke-session')
  const filler = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '.repeat(40)
  for (let i = 0; i < 6; i += 1) {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `turn ${i}: ${filler}` }] }), {
      surfaceOp: 'append',
    })
  }
  assert(session.surface.nodes.length === 6, `expected 6 surface nodes, got ${session.surface.nodes.length}`)

  const engine = new CompactionEngine(options, new SessionStore(dir))
  engine.refresh(session)
  const view = buildKernelView(session)
  const first = view.messages[0]
  const last = view.messages[2]
  assert(first && last, 'kernel view is empty')
  const refOf = (id) => {
    const seq = view.seqOf.get(id)
    assert(seq !== undefined, `no seq for ${id}`)
    return `m${String(seq + 1).padStart(5, '0')}`
  }
  const args = JSON.stringify([
    { startId: refOf(first.id), endId: refOf(last.id), summary: '## Primary Request and Intent\nfolded smoke range for validation' },
  ])

  const result = engine.compress(session, { content: args })
  assert(result.ok, `compress failed: ${result.text}`)
  const blockId = /(b\d+)/.exec(result.text)?.[1]
  assert(blockId, `compress did not report a block id: ${result.text}`)
  assert(session.surface.nodes.length === 4, `expected 4 surface nodes after replace, got ${session.surface.nodes.length}`)

  const messages = session.deriveMessages()
  assert(messages.length === 4, `expected 4 derived messages, got ${messages.length}`)
  const head = messages[0]
  const text = head.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  assert(text.startsWith('[Compressed conversation section]'), `summary message text was: ${text.slice(0, 80)}`)
  assert(head.source.kind === 'bili-compaction', `unexpected summary source: ${JSON.stringify(head.source)}`)

  const restored = engine.decompress(session, { blockId })
  assert(restored.includes('turn 0:'), 'decompress did not return the original text')
  assert(restored.includes('turn 2:'), 'decompress lost part of the range')

  const status = engine.status(session)
  console.log('OK real-session smoke')
  console.log(status.split('\n').slice(0, 6).join('\n'))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
