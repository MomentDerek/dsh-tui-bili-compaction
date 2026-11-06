import assert from 'node:assert/strict'
import test from 'node:test'

import { formatRanges } from '../vendor/acp-kernel/dist/index.js'

/** Minimal compressible range; indices are contiguous so entries merge. */
function compressible(refStart, refEnd, startIndex, endIndex, count, tokens, toolPct) {
  return {
    startRef: refStart,
    endRef: refEnd,
    startIndex,
    endIndex,
    count,
    tokens,
    toolPct,
    textPct: 100 - toolPct,
    userMsgs: 0,
  }
}

function protectedRange(ref, index, tokens, tools = []) {
  return { startRef: ref, endRef: ref, startIndex: index, endIndex: index, count: 1, tokens, tools }
}

test('adjacent compressible ranges keep a weighted tool percentage', () => {
  // 3 text messages (0% tool) followed by 27 tool-heavy ones (74%) must not
  // report 0% just because the first fragment was text-only.
  const text = formatRanges(
    [
      compressible('m00012', 'm00014', 11, 13, 3, 3_000, 0),
      compressible('m00015', 'm00076', 14, 75, 27, 6_000, 74),
    ],
    [],
    { hideProtectedOnly: true },
  )
  assert.match(text, /Compressible ranges \(1, oldest first\):/)
  assert.match(text, /30 msgs {2}9\.0K \[tool 67% \| text 33%\]/)
  assert.doesNotMatch(text, /tool 0%/)
})

test('a following protected run does not drag the tool percentage down', () => {
  const text = formatRanges(
    [compressible('m00012', 'm00029', 11, 28, 18, 8_000, 60)],
    [protectedRange('m00030', 29, 41)],
    { hideProtectedOnly: true },
  )
  assert.match(text, /\[8\.0K compressible \| 41 protected\]/)
  assert.doesNotMatch(text, /tool 0%/)
})

test('protected-only groups are folded into one footnote for nudges', () => {
  const text = formatRanges(
    [compressible('m00012', 'm00014', 11, 13, 3, 3_000, 0)],
    [protectedRange('m00100', 99, 61), protectedRange('m00200', 199, 52)],
    { hideProtectedOnly: true },
  )
  assert.match(text, /Compressible ranges \(1, oldest first\):/)
  assert.doesNotMatch(text, /PROTECTED/)
  assert.match(text, /\(2 protected ranges omitted \\u2014 not compressible\)|\(2 protected ranges omitted — not compressible\)/)
})

test('status keeps protected-only groups unless asked to hide them', () => {
  const text = formatRanges(
    [compressible('m00012', 'm00014', 11, 13, 3, 3_000, 0)],
    [protectedRange('m00100', 99, 61)],
  )
  assert.match(text, /m00100–m00100 {2}1 msgs {2}61 \[PROTECTED — not compressible\]/)
  assert.match(text, /Compressible ranges \(2, oldest first\)/)
})

test('all-protected input renders zero ranges plus the footnote', () => {
  const text = formatRanges([], [protectedRange('m00100', 99, 61)], { hideProtectedOnly: true })
  assert.match(text, /Compressible ranges \(0, oldest first\):/)
  assert.match(text, /1 protected range omitted/)
})

test('empty input keeps the guidance line', () => {
  assert.match(formatRanges([], [], { hideProtectedOnly: true }), /No specific ranges detected/)
})
