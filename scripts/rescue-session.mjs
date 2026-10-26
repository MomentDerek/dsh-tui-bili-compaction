import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'

/**
 * One-off rescue for a session whose log is already past the model window.
 *
 * The native overflow path cannot help: its summarizer would replay the same
 * oversized region. This tool appends one durable surface replacement (the same
 * shape this plugin writes) that shadows the oldest messages with a written
 * digest, keeping the recent tail verbatim.
 *
 * Usage: node scripts/rescue-session.mjs <sessionId> <plan.json> <summary.md> [--apply]
 */

const SESSIONS = 'C:/Users/moment/.dsh/sessions'
const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

const [sessionId, planPath, summaryPath, flag] = process.argv.slice(2)
if (!sessionId || !planPath || !summaryPath) {
  console.error('usage: rescue-session.mjs <sessionId> <plan.json> <summary.md> [--apply]')
  process.exit(2)
}
const apply = flag === '--apply'

function findSessionFile(id) {
  for (const dir of fs.readdirSync(SESSIONS)) {
    const p = `${SESSIONS}/${dir}/${id}/session.v4.jsonl.zstd`
    if (fs.existsSync(p)) return p
  }
  throw new Error(`session ${id} not found`)
}

function load(file) {
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offs = []
  let i = 0
  while ((i = buf.indexOf(magic, i)) !== -1) {
    offs.push(i)
    i += 4
  }
  const events = []
  for (let k = 0; k < offs.length; k++) {
    const text = zlib.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1] ?? buf.length)).toString('utf8')
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // ignore
      }
    }
  }
  return events
}

function visibleChars(events) {
  const shadowed = new Set()
  for (const e of events) {
    if (e.surfaceOp?.op === 'replace' && Array.isArray(e.sourceEventSeqs)) {
      for (const seq of e.sourceEventSeqs) shadowed.add(seq)
    }
  }
  let chars = 0
  let nodes = 0
  for (const e of events) {
    if (!SURFACE.has(e.type) || e.surfaceOp !== 'append' || shadowed.has(e.seq)) continue
    nodes += 1
    const msg = e.data?.message ?? e.data
    for (const b of msg?.content ?? []) if (typeof b?.text === 'string') chars += b.text.length
  }
  return { chars, nodes, shadowed: shadowed.size }
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
const summary = fs.readFileSync(summaryPath, 'utf8').trim()
const file = findSessionFile(sessionId)
const events = load(file)
const before = visibleChars(events)

const last = events[events.length - 1]
const nextSeq = last.seq + 1
const existingSeqs = new Set(events.map((e) => e.seq))
for (const seq of plan.shadowed) {
  if (!existingSeqs.has(seq)) throw new Error(`plan references missing seq ${seq}`)
}

const header =
  'This is a rescue checkpoint written offline (no model call) because the resumed log had already crossed the model context window. ' +
  `It condenses turns up to the split point; the most recent turns are kept verbatim after it. Block ${plan.startSeq}-${plan.endSeq}.`

const event = {
  type: 'user/message',
  seq: nextSeq,
  time: Date.now(),
  data: {
    content: [
      { type: 'text', text: header },
      { type: 'text', text: `<compacted-summary>\n${summary}\n</compacted-summary>` },
    ],
    source: { kind: 'bili-compaction', blockId: 'b00001' },
    role: 'user',
    id: randomUUID(),
  },
  surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
  sourceEventSeqs: [...plan.shadowed].sort((a, b) => a - b),
}

const line = JSON.stringify(event)
const frame = zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))

const expectedAfterChars = plan.keptChars + header.length + summary.length + 40

console.log(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      file,
      before: { chars: before.chars, nodes: before.nodes },
      after: { chars: expectedAfterChars, nodes: before.nodes - plan.foldedNodes + 1 },
      appendedSeq: nextSeq,
      summaryChars: summary.length,
      frameBytes: frame.length,
    },
    null,
    2,
  ),
)

if (!apply) process.exit(0)

const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
fs.copyFileSync(file, backup)
fs.appendFileSync(file, frame)

const after = visibleChars(load(file))
console.log(JSON.stringify({ backup, after, ok: after.chars < before.chars }, null, 2))
