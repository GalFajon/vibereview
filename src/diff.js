'use strict'

// Pure line-diff logic. No `vscode` import so it can be unit tested with plain Node.

/**
 * One contiguous change between the baseline and the current text.
 *
 * @typedef {Object} Hunk
 * @property {number} baseStart - 0-based first baseline line the hunk replaces.
 * @property {string[]} baseLines - Baseline lines that the hunk replaces (empty for a pure insertion).
 * @property {number} curStart - 0-based first current line of the hunk.
 * @property {string[]} curLines - Current lines that replace them (empty for a pure deletion).
 */

/**
 * @typedef {Object} Change
 * @property {'added' | 'deleted' | 'modified'} kind - `added`/`deleted` mean the whole file is new or gone.
 * @property {Hunk[]} hunks - For `added`/`deleted` a single display-only hunk covering the file.
 */

// Above this many LCS cells the changed middle of a file becomes one block instead of a fine diff,
// which keeps huge rewrites from allocating hundreds of MB.
const MAX_CELLS = 4_000_000

// Hunks separated by at most this many unchanged lines are merged, so one logical edit stays one hunk.
const MERGE_GAP = 2

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  return text.split(/\r?\n/)
}

/**
 * @param {string} text
 * @returns {string}
 */
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Edit script between two line arrays via a classic LCS table.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<'=' | 'd' | 'i'>}
 */
function editScript(a, b) {
  const n = a.length
  const m = b.length
  if (n * m > MAX_CELLS) return [...Array(n).fill('d'), ...Array(m).fill('i')]
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }
  /** @type {Array<'=' | 'd' | 'i'>} */
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('=')
      i++
      j++
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      ops.push('d')
      i++
    } else {
      ops.push('i')
      j++
    }
  }
  for (; i < n; i++) ops.push('d')
  for (; j < m; j++) ops.push('i')
  return ops
}

/**
 * Line-level hunks turning `baseText` into `curText`. Line endings are ignored when comparing.
 *
 * @param {string} baseText
 * @param {string} curText
 * @returns {Hunk[]}
 */
function diffLines(baseText, curText) {
  const a = splitLines(baseText)
  const b = splitLines(curText)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const ops = editScript(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf))

  const ranges = []
  let ai = pre
  let bi = pre
  let open = null
  for (const op of ops) {
    if (op === '=') {
      open = null
      ai++
      bi++
      continue
    }
    if (!open) {
      open = { a0: ai, a1: ai, b0: bi, b1: bi }
      ranges.push(open)
    }
    if (op === 'd') open.a1 = ++ai
    else open.b1 = ++bi
  }

  const merged = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.a0 - last.a1 <= MERGE_GAP) {
      last.a1 = r.a1
      last.b1 = r.b1
    } else {
      merged.push({ ...r })
    }
  }
  return merged.map((r) => ({
    baseStart: r.a0,
    baseLines: a.slice(r.a0, r.a1),
    curStart: r.b0,
    curLines: b.slice(r.b0, r.b1),
  }))
}

/**
 * Lines for display, without the empty string that a trailing newline produces.
 *
 * @param {string} text
 * @returns {string[]}
 */
function displayLines(text) {
  const lines = splitLines(text)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Classifies a file and lists its hunks. `null` text means the file does not exist on that side.
 *
 * @param {string | null} baseText
 * @param {string | null} curText
 * @returns {Change | null} `null` when there is nothing to review.
 */
function computeChange(baseText, curText) {
  if (baseText === null && curText === null) return null
  if (baseText === null) {
    return { kind: 'added', hunks: [{ baseStart: 0, baseLines: [], curStart: 0, curLines: displayLines(curText) }] }
  }
  if (curText === null) {
    return { kind: 'deleted', hunks: [{ baseStart: 0, baseLines: displayLines(baseText), curStart: 0, curLines: [] }] }
  }
  const hunks = diffLines(baseText, curText)
  return hunks.length ? { kind: 'modified', hunks } : null
}

/**
 * @param {string} text
 * @param {number} start
 * @param {number} count
 * @param {string[]} lines
 * @returns {string} `text` with `count` lines at `start` replaced, keeping its line ending style.
 */
function replaceLines(text, start, count, lines) {
  const all = splitLines(text)
  all.splice(start, count, ...lines)
  return all.join(detectEol(text))
}

/**
 * @param {string} baseText
 * @param {Hunk} hunk - A `modified` hunk computed from `baseText`.
 * @returns {string} New baseline with this hunk accepted.
 */
function approveHunk(baseText, hunk) {
  return replaceLines(baseText, hunk.baseStart, hunk.baseLines.length, hunk.curLines)
}

/**
 * @param {string} curText
 * @param {Hunk} hunk - A `modified` hunk computed against `curText`.
 * @returns {string} New current text with this hunk reverted to the baseline.
 */
function rejectHunk(curText, hunk) {
  return replaceLines(curText, hunk.curStart, hunk.curLines.length, hunk.baseLines)
}

/**
 * Whether `a` and `b` are the same hunk. Content must match and at least one side's position, because
 * approving shifts baseline positions and rejecting shifts current positions of the other hunks.
 *
 * @param {Hunk} a
 * @param {Hunk} b
 * @returns {boolean}
 */
function sameHunk(a, b) {
  return (
    (a.baseStart === b.baseStart || a.curStart === b.curStart) &&
    a.baseLines.join('\n') === b.baseLines.join('\n') &&
    a.curLines.join('\n') === b.curLines.join('\n') &&
    a.baseLines.length === b.baseLines.length &&
    a.curLines.length === b.curLines.length
  )
}

module.exports = { diffLines, computeChange, approveHunk, rejectHunk, sameHunk, splitLines }
