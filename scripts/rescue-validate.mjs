import fs from 'node:fs'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

/**
 * Offline validation of a rescue append against dsh's canonical surface fold.
 * Loads a session file, optionally appends the planned replacement in memory,
 * then runs `foldSurface` from the installed dsh and reports the visible tail.
 *
 * Usage: node scripts/rescue-validate.mjs <sessionFile> [plan.json summary.md]
 *
 * The dsh package is located through `dsh` on PATH (its `lib/bin.js` lives next
 * to the workspace packages); set `DSH_SESSION_MODULE` to override the exact
 * `@deepseek-ai/dsh-session/lib/index.js` path.
 */

function locateDshSession() {
  if (process.env.DSH_SESSION_MODULE) return process.env.DSH_SESSION_MODULE
  const roots = [
    process.env.APPDATA ? `${process.env.APPDATA}/fnm/node-versions` : undefined,
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/fnm/node-versions` : undefined,
  ].filter(Boolean)
  for (const root of roots) {
    let versions = []
    try {
      versions = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const version of versions.reverse()) {
      const candidate = `${root}/${version}/installation/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error('cannot locate @deepseek-ai/dsh-session; set DSH_SESSION_MODULE to its lib/index.js')
}

const DSH_SESSION = pathToFileURL(locateDshSession()).href

const { foldSurface, deriveEventMessage } = await import(DSH_SESSION)

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

const [file, planPath, summaryPath] = process.argv.slice(2)
const events = load(file)
if (planPath && summaryPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
  const summary = fs.readFileSync(summaryPath, 'utf8').trim()
  const header =
    'This is a rescue checkpoint written offline (no model call) because the resumed log had already crossed the model context window. ' +
    `It condenses turns up to the split point; the most recent turns are kept verbatim after it. Block ${plan.startSeq}-${plan.endSeq}.`
  events.push({
    type: 'user/message',
    seq: events[events.length - 1].seq + 1,
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
  })
}

const folded = foldSurface(events)
const nodes = folded.nodes
let chars = 0
const kinds = new Map()
const projected = new Map()
for (const seq of nodes) {
  const event = events.find((e) => e.seq === seq)
  const message = deriveEventMessage(event)
  if (message === null) {
    kinds.set('NULL', (kinds.get('NULL') ?? 0) + 1)
    continue
  }
  projected.set(seq, message)
  const label = `${String(message.role)}${message.source?.kind ? `:${message.source.kind}` : ''}`
  kinds.set(label, (kinds.get(label) ?? 0) + 1)
  for (const block of message.content ?? []) if (typeof block?.text === 'string') chars += block.text.length
}

console.log(
  JSON.stringify(
    {
      foldOk: true,
      nodes: nodes.length,
      chars,
      approxTokens: Math.round(chars / 2.2),
      head: nodes.slice(0, 4).map((seq) => {
        const event = events.find((e) => e.seq === seq)
        return { seq, type: event?.type, op: event?.surfaceOp }
      }),
      tailKinds: [...kinds.entries()].slice(0, 12),
    },
    null,
    2,
  ),
)
