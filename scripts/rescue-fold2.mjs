import fs from 'node:fs'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'

/**
 * Second offline fold pass: condense the oldest still-visible messages into one
 * durable summary replacement, keeping the newest stretch verbatim.
 *
 * Used when the first fold left the session too close to the window for the
 * harness's completion reservation to fit. Unlike `rescue-session.mjs` this
 * understands an already-folded log (existing replacements are treated as
 * visible nodes and never folded again) and writes its own mechanical digest,
 * so it needs no model call.
 *
 * Usage: node scripts/rescue-fold2.mjs <sessionId> [--target-chars N] [--apply]
 */

const SESSIONS = 'C:/Users/moment/.dsh/sessions'
const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

const args = process.argv.slice(2)
const sessionId = args.find((a) => !a.startsWith('--'))
const at = args.indexOf('--target-chars')
const targetChars = at === -1 ? 950_000 : Number(args[at + 1])
const apply = args.includes('--apply')

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
        const parsed = JSON.parse(line)
        if (typeof parsed?.seq === 'number') events.push(parsed)
      } catch {
        // ignore
      }
    }
  }
  return events
}

function textOf(blocks) {
  let n = 0
  for (const block of blocks ?? []) if (typeof block?.text === 'string') n += block.text.length
  return n
}

function messageOf(event) {
  return event.data?.message ?? event.data
}

/** Visible surface in order: appends plus landed replacements, shadowed ones dropped. */
function visibleNodes(events) {
  const shadowed = new Set()
  for (const e of events) if (e.surfaceOp?.op === 'replace') for (const s of e.sourceEventSeqs ?? []) shadowed.add(s)
  const nodes = []
  for (const e of events) {
    if (!SURFACE.has(e.type)) continue
    if (shadowed.has(e.seq)) continue
    const append = e.surfaceOp === 'append'
    const replace = e.surfaceOp?.op === 'replace'
    if (!append && !replace) continue
    nodes.push({
      event: e,
      seq: e.seq,
      order: replace ? e.surfaceOp.startSeq : e.seq,
      type: e.type,
      replace,
      chars: textOf(messageOf(e).content),
      message: messageOf(e),
    })
  }
  nodes.sort((a, b) => a.order - b.order || a.seq - b.seq)
  return nodes
}

const file = findSessionFile(sessionId)
const events = load(file)
let nodes = visibleNodes(events)
const systemEnd = nodes.findIndex((n) => n.type !== 'system/message')

// Start after the last replacement: earlier replacements already summarize that
// stretch and must not be folded twice.
const lastReplaceOrder = nodes.filter((n) => n.replace).reduce((best, n) => Math.max(best, n.order), -Infinity)
const startIdx = nodes.findIndex((n, index) => index > systemEnd && n.order > lastReplaceOrder && !n.replace)

const cuts = []
for (let k = startIdx + 1; k < nodes.length; k++) {
  if (nodes[k].type !== 'user/message' || nodes[k].replace) continue
  const kept = nodes.slice(k).reduce((sum, n) => sum + n.chars, 0)
  cuts.push({ k, kept })
}
const pick = cuts.filter((c) => c.kept <= targetChars).sort((a, b) => b.kept - a.kept)[0]
if (pick === undefined) throw new Error('no cut candidate fits; raise --target-chars')

const folded = nodes.slice(startIdx, pick.k)
const digest = []
let turn = null
for (const node of folded) {
  const message = node.message ?? {}
  if (node.type === 'user/message') {
    const text = (message.content ?? []).filter((b) => typeof b.text === 'string').map((b) => b.text).join('\n').trim()
    if (text.length > 0) digest.push(`- 用户：${text.slice(0, 900)}`)
  } else if (node.type === 'assistant/message') {
    for (const block of message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        digest.push(`- 助手：${block.text.trim().slice(0, 320)}`)
      } else if (block.type === 'tool-call') {
        digest.push(`- 调用 ${block.name ?? '?'}：${String(block.arguments ?? '').replace(/\s+/g, ' ').slice(0, 110)}`)
      }
    }
  }
}
let body = digest.join('\n')
const cap = 9_000
if (body.length > cap) {
  const head = body.slice(0, Math.floor(cap * 0.7))
  const tail = body.slice(body.length - (cap - head.length - 60))
  body = `${head}\n\n…（中段略）…\n\n${tail}`
}

const startSeq = folded[0].seq
const endSeq = folded[folded.length - 1].seq
const header =
  'This is a second rescue checkpoint written offline (no model call) because the resumed log still did not fit the model window. ' +
  `It condenses the stretch that follows the previous checkpoint; the most recent messages after it are kept verbatim. Block ${startSeq}-${endSeq}.`
const summary = [
  { type: 'text', text: header },
  { type: 'text', text: `<compacted-summary>\n${body}\n</compacted-summary>` },
]
const event = {
  type: 'user/message',
  seq: events[events.length - 1].seq + 1,
  time: Date.now(),
  data: {
    content: summary,
    source: { kind: 'bili-compaction', blockId: 'b00002' },
    role: 'user',
    id: randomUUID(),
  },
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: folded.map((n) => n.seq),
}

console.log(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      file,
      foldedNodes: folded.length,
      foldedChars: folded.reduce((sum, n) => sum + n.chars, 0),
      keptChars: pick.kept,
      digestChars: body.length,
      startSeq,
      endSeq,
      appendedSeq: event.seq,
      expectedVisibleChars: pick.kept + header.length + body.length + 40,
    },
    null,
    2,
  ),
)

if (!apply) process.exit(0)
const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
fs.copyFileSync(file, backup)
fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')))
console.log(JSON.stringify({ backup, bytes: fs.statSync(file).size }, null, 2))
