import fs from 'node:fs'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

/**
 * Offline check of a session log against dsh's released V4 format validator —
 * the same code that rejects a log with "tool/result is outside an open turn".
 *
 * Usage: node scripts/format-check.mjs <sessionFile>
 */

const ROOT = 'C:/Users/moment/AppData/Roaming/fnm/node-versions/v24.21.0/installation/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const load = async (name, sub = 'lib/index.js') => import(pathToFileURL(`${ROOT}/${name}/${sub}`).href)

const { restoreReleasedV4Artifact } = await load('dsh-session-format-v3-to-v4')
const { KNOWN_SESSION_EVENT_TYPES } = await load('dsh-session')

const file = process.argv[2]
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
const headerLine = JSON.parse(lines[0])
const { type: _recordType, ...header } = headerLine
const events = lines.slice(1).map((line) => JSON.parse(line))
const artifact = { header, inheritedEventCount: 0, events }
try {
  restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)
  console.log(JSON.stringify({ ok: true, header: { id: header.id, version: header.version }, events: events.length }, null, 2))
} catch (error) {
  console.log(JSON.stringify({ ok: false, name: error?.name, message: error?.message }, null, 2))
  process.exitCode = 1
}
