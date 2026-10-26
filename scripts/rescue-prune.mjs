import fs from 'node:fs'
import zlib from 'node:zlib'

/**
 * One-off rescue pass 2: shorten oversized tool results in a session that is
 * still too large to send. Appends durable `tool/result` replacements (the same
 * shape dsh's own tool-result pruner writes) for the oldest over-budget results
 * until the visible surface fits the target, keeping every turn's narration and
 * the newest results untouched.
 *
 * Usage: node scripts/rescue-prune.mjs <sessionId> [--target-chars N] [--budget N] [--apply]
 */

const SESSIONS = 'C:/Users/moment/.dsh/sessions'
const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const MARKER = '\n\n[... tool result middle pruned by bili-compaction rescue ...]\n\n'

const args = process.argv.slice(2)
const sessionId = args.find((a) => !a.startsWith('--'))
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : Number(args[at + 1])
}
const apply = args.includes('--apply')
const targetChars = flag('target-chars', 1_150_000)
const budget = flag('budget', 400)
const newestKept = flag('newest', 40)

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

const file = findSessionFile(sessionId)
const events = load(file)
const shadowed = new Set()
for (const e of events) if (e.surfaceOp?.op === 'replace') for (const s of e.sourceEventSeqs ?? []) shadowed.add(s)

const visible = events.filter(
  (e) => SURFACE.has(e.type) && e.surfaceOp === 'append' && !shadowed.has(e.seq),
)
const totalChars = visible.reduce((sum, e) => {
  const msg = e.data?.message ?? e.data
  return sum + textOf(msg?.content)
}, 0)

// Oldest first, keep the newest results intact.
const targets = visible
  .filter((e) => e.type === 'tool/result')
  .slice(0, Math.max(0, visible.length - newestKept))
  .map((e) => ({ event: e, message: e.data?.message ?? e.data }))
  .map((entry) => ({ ...entry, chars: textOf(entry.message?.content) }))
  .filter((entry) => entry.chars > budget)

let remaining = totalChars - targetChars
const picked = []
for (const entry of targets) {
  if (remaining <= 0) break
  picked.push(entry)
  remaining -= entry.chars - budget
}

let seq = events[events.length - 1].seq + 1
const appended = []
for (const { event, message, chars } of picked) {
  const blocks = message?.content ?? []
  const textIndex = blocks.findIndex((block) => typeof block?.text === 'string')
  if (textIndex === -1) continue
  const text = blocks[textIndex].text
  const head = Math.max(0, budget - 90)
  const tail = Math.max(40, Math.floor(budget * 0.2))
  const clipped = text.length <= budget ? text : `${text.slice(0, head)}${MARKER}${text.slice(text.length - tail)}`
  const content = blocks.map((block, index) => (index === textIndex ? { ...block, text: clipped } : block))
  appended.push({
    type: 'tool/result',
    seq: seq++,
    time: Date.now(),
    // The replacement may change only `message.content`: every other field of
    // the event data (turn, step, meta, ...) must stay byte-identical.
    data: { ...event.data, message: { ...message, content } },
    surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
    sourceEventSeqs: [event.seq],
  })
}

const savedChars = picked.reduce((sum, entry) => sum + entry.chars - budget, 0)
console.log(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      file,
      visibleChars: totalChars,
      prunedResults: appended.length,
      savedChars,
      expectedChars: totalChars - savedChars,
      firstSeq: appended[0]?.seq,
      lastSeq: appended[appended.length - 1]?.seq,
    },
    null,
    2,
  ),
)

if (!apply) process.exit(0)
if (appended.length === 0) {
  console.log('nothing to do')
  process.exit(0)
}

const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
fs.copyFileSync(file, backup)
for (const event of appended) {
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')))
}

const after = load(file)
const shadowedAfter = new Set()
for (const e of after) if (e.surfaceOp?.op === 'replace') for (const s of e.sourceEventSeqs ?? []) shadowedAfter.add(s)
const afterChars = after
  .filter((e) => SURFACE.has(e.type) && e.surfaceOp === 'append' && !shadowedAfter.has(e.seq))
  .reduce((sum, e) => sum + textOf((e.data?.message ?? e.data)?.content), 0)
console.log(JSON.stringify({ backup, afterChars, ok: afterChars < totalChars }, null, 2))
