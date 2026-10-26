import fs from 'node:fs'
import zlib from 'node:zlib'

const SESSION = process.argv[2]
const OUT_DIR = process.argv[3] ?? 'tmp-rescue'
const TARGET_KEPT_CHARS = Number(process.argv[4] ?? 1_650_000)

const SESSIONS = 'C:/Users/moment/.dsh/sessions'
const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

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
  const lines = []
  for (let k = 0; k < offs.length; k++) {
    lines.push(...zlib.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1] ?? buf.length)).toString('utf8').split('\n').filter(Boolean))
  }
  return lines.slice(1).map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  }).filter(Boolean)
}

const file = findSessionFile(SESSION)
const events = load(file)
const shadowedBy = new Set()
for (const e of events) {
  if (e.surfaceOp && e.surfaceOp.op === 'replace' && Array.isArray(e.sourceEventSeqs)) {
    for (const seq of e.sourceEventSeqs) shadowedBy.add(seq)
  }
}

const nodes = []
for (const e of events) {
  if (!SURFACE.has(e.type)) continue
  if (e.surfaceOp !== 'append') continue
  if (shadowedBy.has(e.seq)) continue
  const msg = e.data?.message ?? e.data
  let chars = 0
  for (const b of msg?.content ?? []) if (typeof b?.text === 'string') chars += b.text.length
  nodes.push({ seq: e.seq, type: e.type, role: msg?.role, chars, turn: e.data?.turn })
}

const total = nodes.reduce((s, n) => s + n.chars, 0)
const firstNonSystem = nodes.findIndex((n) => n.type !== 'system/message')
const cuts = []
for (let k = firstNonSystem + 1; k < nodes.length; k++) {
  if (nodes[k].type !== 'user/message') continue
  const kept = nodes.slice(k).reduce((s, n) => s + n.chars, 0)
  cuts.push({ k, seq: nodes[k].seq, kept })
}
const pick = cuts.filter((c) => c.kept <= TARGET_KEPT_CHARS).sort((a, b) => b.kept - a.kept)[0]
if (pick === undefined) throw new Error('no cut candidate fits the target')

const folded = nodes.slice(0, pick.k)
const keptNodes = nodes.slice(pick.k)
const plan = {
  session: SESSION,
  file,
  totalChars: total,
  cutSeq: pick.seq,
  keptChars: pick.kept,
  startSeq: nodes[firstNonSystem].seq,
  endSeq: folded[folded.length - 1].seq,
  shadowed: folded.map((n) => n.seq),
  foldedNodes: folded.length,
  keptNodes: keptNodes.length,
  nextSeq: events[events.length - 1].seq + 1,
}

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(`${OUT_DIR}/plan.json`, JSON.stringify(plan, null, 2))

// Narrative extraction: user messages in full, assistant text heads, tool calls by name.
const lines = []
let turn = null
let step = null
for (const e of events) {
  if (e.type === 'turn/start') {
    turn = e.data?.turn ?? null
    lines.push(`\n=== TURN ${turn} ===`)
  }
  if (!SURFACE.has(e.type) || e.surfaceOp !== 'append' || shadowedBy.has(e.seq)) continue
  if (e.seq > plan.endSeq) continue
  const msg = e.data?.message ?? e.data
  if (e.type === 'user/message') {
    const text = (msg.content ?? []).filter((b) => typeof b.text === 'string').map((b) => b.text).join('\n')
    if (msg.source?.kind === 'user' || msg.source?.kind === undefined) lines.push(`[user] ${text}`)
  } else if (e.type === 'tool/result') {
    const head = (msg.content ?? []).filter((b) => typeof b.text === 'string').map((b) => b.text).join('').slice(0, 160)
    lines.push(`[tool ${msg.toolCallId ?? ''}] ${head.replace(/\s+/g, ' ')}`)
  } else if (e.type === 'assistant/message') {
    for (const b of msg.content ?? []) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
        lines.push(`[assistant] ${b.text.slice(0, 1200)}`)
      } else if (b.type === 'tool-call') {
        const args = typeof b.arguments === 'string' ? b.arguments.replace(/\s+/g, ' ').slice(0, 160) : ''
        lines.push(`[call ${b.name ?? '?'}] ${args}`)
      }
    }
  }
}
fs.writeFileSync(`${OUT_DIR}/narrative.txt`, lines.join('\n'))
console.log(JSON.stringify({ plan: { ...plan, shadowed: plan.shadowed.length }, narrativeChars: lines.join('\n').length }, null, 2))
