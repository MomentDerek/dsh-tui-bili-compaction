import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_REPEAT_GUARD,
  REPEAT_FAILURE_CODE,
  RepeatDetector,
  guardStream,
  installRepeatGuard,
  repeatedTail,
} from '../dist/repeat-guard.js'

function chunk(type, text) {
  return { type, index: 0, text }
}

async function drain(stream) {
  const out = []
  for await (const item of stream) out.push(item)
  return out
}

test('repeatedTail counts only consecutive meaningful lines', () => {
  assert.equal(repeatedTail('a\nb\na\nb\n', 3), false)
  // Structural lines (closers, separators) never count as a collapse.
  assert.equal(repeatedTail('}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n', 3), false)
  assert.equal(repeatedTail('好。\n好。\n好。\n', 3), true)
  assert.equal(repeatedTail('好。\n做。\n好。\n好。\n', 3), false)
})

test('the detector stays quiet until it has seen enough output', () => {
  const detector = new RepeatDetector({ ...DEFAULT_REPEAT_GUARD, minRepeatedLines: 4, minChars: 50 })
  assert.equal(detector.push('好。\n好。\n好。\n好。\n'), false)
  assert.equal(detector.push('好。\n'.repeat(40)), true)
})

test('structured output is not a collapse', () => {
  // Alternating short lines never form a consecutive run.
  const alternating = new RepeatDetector({ ...DEFAULT_REPEAT_GUARD, minRepeatedLines: 4, minChars: 10 })
  assert.equal(alternating.push('Yes\nNo\n'.repeat(30)), false)

  // A table whose rows differ: no run reaches the line threshold.
  const table = [
    '| item | status |',
    '| --- | --- |',
    ...Array(6).fill('| gate | yes |'),
    ...Array(6).fill('| proxy | no |'),
    ...Array(6).fill('| cache | warm |'),
  ].join('\n') + '\n'
  const structured = new RepeatDetector({ ...DEFAULT_REPEAT_GUARD, minRepeatedLines: 20, minChars: 10 })
  assert.equal(structured.push(table), false)

  // A genuine collapse is one short line and nothing else.
  const collapse = new RepeatDetector({ ...DEFAULT_REPEAT_GUARD, minRepeatedLines: 4, minChars: 10 })
  assert.equal(collapse.push('好。\n'.repeat(30)), true)
})

test('guardStream passes chunks through until the loop trips, then ends the attempt', async () => {
  async function* upstream() {
    yield chunk('block-start', undefined)
    yield chunk('reasoning-delta', 'working on the task\n')
    yield chunk('reasoning-delta', '好。\n'.repeat(20))
    yield chunk('reasoning-delta', 'this never arrives\n')
  }

  const out = await drain(guardStream(upstream(), { ...DEFAULT_REPEAT_GUARD, minRepeatedLines: 5, minChars: 10 }))
  assert.equal(out[0].type, 'block-start')
  assert.equal(out[1].type, 'reasoning-delta')
  const last = out[out.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'error')
  assert.equal(last.reason.failure.code, REPEAT_FAILURE_CODE)
  assert.equal(out.some((item) => item.text === 'this never arrives\n'), false)
})

test('guardStream leaves a normal stream untouched', async () => {
  async function* upstream() {
    yield chunk('reasoning-delta', 'line one\nline two\nline three\n')
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const out = await drain(guardStream(upstream(), DEFAULT_REPEAT_GUARD))
  assert.equal(out.length, 2)
  assert.equal(out[1].reason.kind, 'stop')
})

test('a disabled guard is a pass-through', async () => {
  async function* upstream() {
    yield chunk('reasoning-delta', '好。\n'.repeat(50))
  }
  const out = await drain(guardStream(upstream(), { ...DEFAULT_REPEAT_GUARD, enabled: false }))
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'reasoning-delta')
})

function fakeHost() {
  const listeners = new Map()
  return {
    listeners,
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
  }
}

test('installRepeatGuard retries the cut attempt once, then leaves it terminal', async () => {
  const host = fakeHost()
  installRepeatGuard(host, { ...DEFAULT_REPEAT_GUARD, maxRetries: 1 })

  assert.equal(typeof host.listeners.get('llm/stream'), 'function')
  assert.equal(typeof host.listeners.get('agent/request-error'), 'function')

  const requestError = host.listeners.get('agent/request-error')
  const agent = {}
  const next = async () => undefined
  const payload = { agent, failure: { code: REPEAT_FAILURE_CODE }, signal: { aborted: false } }

  assert.deepEqual(await requestError(payload, next), { kind: 'retry' })
  assert.equal(await requestError(payload, next), undefined)

  // A fresh agent gets its own budget.
  assert.deepEqual(await requestError({ ...payload, agent: {} }, next), { kind: 'retry' })

  const unrelated = await requestError({ ...payload, failure: { code: 'RATE_LIMIT' } }, next)
  assert.equal(unrelated, undefined)

  const aborted = await requestError({ ...payload, signal: { aborted: true } }, next)
  assert.equal(aborted, undefined)
})

test('an idle agent forgets its retry budget', async () => {
  const host = fakeHost()
  installRepeatGuard(host, { ...DEFAULT_REPEAT_GUARD, maxRetries: 1 })
  const requestError = host.listeners.get('agent/request-error')
  const status = host.listeners.get('agent/status')
  const agent = {}
  const next = async () => undefined

  assert.deepEqual(await requestError({ agent, failure: { code: REPEAT_FAILURE_CODE } }, next), { kind: 'retry' })
  status({ agent, status: 'idle' })
  assert.deepEqual(await requestError({ agent, failure: { code: REPEAT_FAILURE_CODE } }, next), { kind: 'retry' })
})
