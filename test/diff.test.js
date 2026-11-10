'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { diffLines, computeChange, approveHunk, rejectHunk, sameHunk } = require('../src/diff')

test('identical texts have no hunks', () => {
  assert.deepEqual(diffLines('a\nb\n', 'a\nb\n'), [])
  assert.equal(computeChange('a\n', 'a\n'), null)
})

test('a modified line is one hunk', () => {
  assert.deepEqual(diffLines('a\nb\nc\n', 'a\nB\nc\n'), [{ baseStart: 1, baseLines: ['b'], curStart: 1, curLines: ['B'] }])
})

test('pure insertion and pure deletion', () => {
  assert.deepEqual(diffLines('a\nc\n', 'a\nb\nc\n'), [{ baseStart: 1, baseLines: [], curStart: 1, curLines: ['b'] }])
  assert.deepEqual(diffLines('a\nb\nc\n', 'a\nc\n'), [{ baseStart: 1, baseLines: ['b'], curStart: 1, curLines: [] }])
})

test('nearby edits merge, distant edits stay separate', () => {
  const base = '1\n2\n3\n4\n5\n6\n7\n8\n9\n'
  assert.equal(diffLines(base, '1\nX\n3\nY\n5\n6\n7\n8\n9\n').length, 1)
  assert.equal(diffLines(base, 'X\n2\n3\n4\n5\n6\n7\n8\nY\n').length, 2)
})

test('added and deleted files', () => {
  assert.deepEqual(computeChange(null, 'x\ny\n'), {
    kind: 'added',
    hunks: [{ baseStart: 0, baseLines: [], curStart: 0, curLines: ['x', 'y'] }],
  })
  assert.equal(computeChange('x\n', null).kind, 'deleted')
  assert.equal(computeChange(null, null), null)
})

test('CRLF is preserved on both sides', () => {
  const base = 'a\r\nb\r\nc\r\n'
  const cur = 'a\r\nB\r\nc\r\n'
  const [hunk] = diffLines(base, cur)
  assert.equal(approveHunk(base, hunk), cur)
  assert.equal(rejectHunk(cur, hunk), base)
})

test('sameHunk tolerates shifts on one side only', () => {
  const h = { baseStart: 3, baseLines: ['x'], curStart: 5, curLines: ['y'] }
  assert.ok(sameHunk(h, { ...h, baseStart: 9 }))
  assert.ok(sameHunk(h, { ...h, curStart: 9 }))
  assert.ok(!sameHunk(h, { ...h, baseStart: 9, curStart: 9 }))
  assert.ok(!sameHunk(h, { ...h, curLines: ['z'] }))
})

test('approving or rejecting hunks one at a time, in any order, converges', () => {
  let seed = 7
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  const words = ['a', 'b', 'c', 'd', '']
  const randText = () =>
    Array.from({ length: Math.floor(rand() * 14) }, () => words[Math.floor(rand() * words.length)]).join('\n')

  for (let round = 0; round < 2000; round++) {
    const base = randText()
    const cur = randText()

    let b = base
    for (let steps = 0, h = diffLines(b, cur); h.length; h = diffLines(b, cur)) {
      b = approveHunk(b, h[Math.floor(rand() * h.length)])
      assert.ok(++steps < 50, 'approve did not converge')
    }
    assert.equal(b, cur)

    let c = cur
    for (let steps = 0, h = diffLines(base, c); h.length; h = diffLines(base, c)) {
      c = rejectHunk(c, h[Math.floor(rand() * h.length)])
      assert.ok(++steps < 50, 'reject did not converge')
    }
    assert.equal(c, base)
  }
})

test('a batch of mixed decisions applied bottom-up from one diff resolves every hunk', () => {
  let seed = 11
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  const words = ['a', 'b', 'c', 'd', '']
  const randText = () =>
    Array.from({ length: Math.floor(rand() * 14) }, () => words[Math.floor(rand() * words.length)]).join('\n')

  for (let round = 0; round < 2000; round++) {
    const base = randText()
    const cur = randText()
    const hunks = diffLines(base, cur).sort((x, y) => y.curStart - x.curStart)
    let nextBase = base
    let nextCur = cur
    for (const hunk of hunks) {
      if (rand() < 0.5) nextBase = approveHunk(nextBase, hunk)
      else nextCur = rejectHunk(nextCur, hunk)
    }
    assert.equal(nextBase, nextCur)
  }
})
