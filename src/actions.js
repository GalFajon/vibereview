'use strict'

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { computeChange, approveHunk, rejectHunk, sameHunk } = require('./diff')
const { BASE_SCHEME, baseUri, relFromBaseUri } = require('./baseContent')

/** @typedef {import('./tree').Target} Target */

/**
 * @param {import('./diff').Hunk} hunk
 * @param {number} line
 * @param {number} lineCount
 * @returns {boolean} Whether the cursor line sits on the hunk (a deletion sits on the line after it).
 */
function covers(hunk, line, lineCount) {
  const start = Math.min(hunk.curStart, lineCount - 1)
  return line >= start && line < start + Math.max(hunk.curLines.length, 1)
}

/** Approve/reject and navigation. Approve moves the baseline; reject rewrites the real file. */
class Actions {
  /**
   * @param {import('./model').ReviewModel} model
   * @param {import('./baseContent').BaseContent} baseContent
   */
  constructor(model, baseContent) {
    this.model = model
    this.baseContent = baseContent
  }

  /** @returns {Target[]} Every pending hunk in navigation order. */
  entries() {
    return this.model
      .sortedChanges()
      .flatMap((c) => c.hunks.map((hunk) => ({ type: 'hunk', rel: c.rel, kind: c.kind, hunk })))
  }

  /** @returns {{ rel: string, line: number, editor: vscode.TextEditor } | null} */
  cursor() {
    const editor = vscode.window.activeTextEditor
    if (!editor) return null
    const { uri } = editor.document
    // In a deleted file's diff there is no real line, so navigation moves on to the next file.
    if (uri.scheme === BASE_SCHEME) return { rel: relFromBaseUri(uri), line: Infinity, editor }
    const rel = this.model.relOf(uri)
    return rel ? { rel, line: editor.selection.active.line, editor } : null
  }

  /** @returns {Target | null} */
  hunkAtCursor() {
    const c = this.cursor()
    if (!c) return null
    if (c.line === Infinity) {
      const change = this.model.changes.get(c.rel)
      return change ? { type: 'hunk', rel: c.rel, kind: change.kind, hunk: change.hunks[0] } : null
    }
    const doc = c.editor.document
    const change = this.model.changeForDocument(doc)
    const hunk = change?.hunks.find((h) => covers(h, c.line, doc.lineCount))
    return hunk ? { type: 'hunk', rel: c.rel, kind: change.kind, hunk } : null
  }

  /** @param {boolean} [inclusive] - Also accept a hunk starting on the cursor line (after a decision). */
  async next(inclusive = false) {
    const list = this.entries()
    if (!list.length) return void vscode.window.setStatusBarMessage('VibeReview: nothing left to review', 3000)
    const c = this.cursor()
    let i = c
      ? list.findIndex(
          (e) => e.rel > c.rel || (e.rel === c.rel && (inclusive ? e.hunk.curStart >= c.line : e.hunk.curStart > c.line)),
        )
      : 0
    if (i < 0) i = 0
    await this.reveal(list[i])
  }

  async prev() {
    const list = this.entries()
    if (!list.length) return
    const c = this.cursor()
    let i = c ? list.findLastIndex((e) => e.rel < c.rel || (e.rel === c.rel && e.hunk.curStart < c.line)) : -1
    if (i < 0) i = list.length - 1
    await this.reveal(list[i])
  }

  /**
   * @param {Target} target
   * @param {vscode.ViewColumn} [viewColumn]
   */
  async reveal(target, viewColumn) {
    if (target.kind === 'deleted') return this.openDiff(target, { viewColumn })
    const doc = await vscode.workspace.openTextDocument(this.model.uriOf(target.rel))
    const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn })
    const last = doc.lineCount - 1
    const line = Math.min(target.hunk.curStart, last)
    const end = Math.min(line + Math.max(target.hunk.curLines.length - 1, 0), last)
    editor.selection = new vscode.Selection(line, 0, line, 0)
    editor.revealRange(new vscode.Range(line, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  /**
   * Side-by-side diff of the approved baseline against the file now, scrolled to the hunk if given.
   *
   * @param {Target} [target]
   * @param {{ viewColumn?: vscode.ViewColumn, preserveFocus?: boolean }} [options]
   */
  async openDiff(target, options = {}) {
    const rel = target?.rel ?? this.cursor()?.rel
    if (!rel) return
    const deleted = this.model.changes.get(rel)?.kind === 'deleted'
    const right = deleted ? baseUri(rel, true) : this.model.uriOf(rel)
    const title = `${path.posix.basename(rel)} (approved ↔ now)`
    const line = target?.hunk && !deleted ? target.hunk.curStart : undefined
    await vscode.commands.executeCommand('vscode.diff', baseUri(rel), right, title, {
      preview: true,
      viewColumn: options.viewColumn,
      preserveFocus: options.preserveFocus,
      selection: line === undefined ? undefined : new vscode.Range(line, 0, line, 0),
    })
  }

  /**
   * Entry point for approve/reject. Without a target (keyboard) it acts on the hunk under the
   * cursor and then jumps to the next one, so Alt+Y / Alt+N can be pressed repeatedly.
   *
   * @param {Target | undefined} target
   * @param {boolean} approve
   */
  async decide(target, approve) {
    const fromKeyboard = !target
    const t = target ?? this.hunkAtCursor()
    if (!t) {
      vscode.window.setStatusBarMessage('VibeReview: no change under the cursor (Alt+J jumps to the next)', 3000)
      return
    }
    const hunks = this.model.changes.get(t.rel)?.hunks.length ?? 1
    const done = t.type === 'file' ? await this.decideFile(t.rel, approve) : await this.decideHunk(t, approve)
    if (done) this.model.decided += t.type === 'file' ? hunks : 1
    this.model.refresh([t.rel])
    if (done && fromKeyboard) await this.next(true)
  }

  /**
   * @param {Target | undefined} target - A tree node, or the active editor's file when omitted.
   * @param {boolean} approve
   */
  async decideFileCommand(target, approve) {
    const rel = target?.rel ?? this.cursor()?.rel
    if (!rel) return
    const hunks = this.model.changes.get(rel)?.hunks.length ?? 0
    if (await this.decideFile(rel, approve)) this.model.decided += hunks
    this.model.refresh([rel])
  }

  /**
   * @param {Target} target
   * @param {boolean} approve
   * @returns {Promise<boolean>} Whether anything was applied.
   */
  async decideHunk(target, approve) {
    const base = this.model.baseline.read(target.rel)
    const cur = this.model.readCurrent(target.rel)
    if (cur.skipped) return false
    // Re-diff right now: the agent may have written the file since the UI was drawn.
    const change = computeChange(base, cur.text)
    const hunk = change?.hunks.find((h) => sameHunk(h, target.hunk))
    if (!hunk) {
      vscode.window.setStatusBarMessage('VibeReview: that change moved, refreshed', 3000)
      return false
    }
    if (change.kind !== 'modified') return this.decideFile(target.rel, approve)
    if (approve) {
      this.model.baseline.write(target.rel, approveHunk(base, hunk))
      this.baseContent.refresh(target.rel)
    } else {
      await this.writeCurrent(target.rel, rejectHunk(cur.text, hunk))
    }
    return true
  }

  /**
   * @param {string} rel
   * @param {boolean} approve
   * @returns {Promise<boolean>}
   */
  async decideFile(rel, approve) {
    const base = this.model.baseline.read(rel)
    const cur = this.model.readCurrent(rel)
    if (cur.skipped) return false
    if (approve) {
      if (cur.text === null) this.model.baseline.remove(rel)
      else this.model.baseline.write(rel, cur.text)
      this.baseContent.refresh(rel)
    } else if (base === null) {
      await this.deleteCurrent(rel)
    } else {
      await this.writeCurrent(rel, base)
    }
    return true
  }

  /** @param {boolean} approve */
  async decideAll(approve) {
    const rels = [...this.model.changes.keys()]
    if (!rels.length) return
    if (!approve) {
      const answer = await vscode.window.showWarningMessage(
        `Reject all pending changes in ${rels.length} file(s)? Files are restored to their approved state and new files go to the trash.`,
        { modal: true },
        'Reject All',
      )
      if (answer !== 'Reject All') return
    }
    for (const rel of rels) {
      const hunks = this.model.changes.get(rel)?.hunks.length ?? 0
      if (await this.decideFile(rel, approve)) this.model.decided += hunks
    }
    this.model.refresh(rels)
  }

  /**
   * Applies a batch of staged decisions (the review panel's transaction). Each file is re-diffed
   * once and its approvals and rejections are applied bottom-up from that one diff, so positions stay
   * valid. Approvals only touch the baseline and rejections only touch the file, so both sides
   * apply independently.
   *
   * @param {Array<{ target: Target, approve: boolean }>} decisions
   * @returns {Promise<{ applied: number, skipped: number }>} `skipped` counts hunks that changed
   *   since they were staged and were left pending.
   */
  async commit(decisions) {
    /** @type {Map<string, Array<{ target: Target, approve: boolean }>>} */
    const byFile = new Map()
    for (const d of decisions) byFile.set(d.target.rel, [...(byFile.get(d.target.rel) ?? []), d])
    let applied = 0
    let skipped = 0
    for (const [rel, items] of byFile) {
      const base = this.model.baseline.read(rel)
      const cur = this.model.readCurrent(rel)
      const change = cur.skipped ? null : computeChange(base, cur.text)
      if (!change) {
        skipped += items.length
        continue
      }
      if (change.kind !== 'modified') {
        if (await this.decideFile(rel, items[0].approve)) applied++
        continue
      }
      const matched = items
        .map((d) => ({ hunk: change.hunks.find((h) => sameHunk(h, d.target.hunk)), approve: d.approve }))
        .filter((m) => m.hunk)
        .sort((a, b) => b.hunk.curStart - a.hunk.curStart)
      skipped += items.length - matched.length
      let nextBase = base
      let nextCur = cur.text
      for (const m of matched) {
        if (m.approve) nextBase = approveHunk(nextBase, m.hunk)
        else nextCur = rejectHunk(nextCur, m.hunk)
      }
      if (nextBase !== base) {
        this.model.baseline.write(rel, nextBase)
        this.baseContent.refresh(rel)
      }
      if (nextCur !== cur.text) await this.writeCurrent(rel, nextCur)
      applied += matched.length
    }
    this.model.decided += applied
    this.model.refresh([...byFile.keys()])
    return { applied, skipped }
  }

  /**
   * Writes through an open editor when there is one, so undo (Ctrl+Z) can bring the change back.
   *
   * @param {string} rel
   * @param {string} text
   */
  async writeCurrent(rel, text) {
    const doc = this.model.openDocument(rel)
    if (doc && !doc.isClosed) {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text)
      await vscode.workspace.applyEdit(edit)
      await doc.save()
      return
    }
    const file = this.model.absOf(rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text, 'utf8')
  }

  /** @param {string} rel */
  async deleteCurrent(rel) {
    const uri = this.model.uriOf(rel)
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true })
    } catch {
      await vscode.workspace.fs.delete(uri, { useTrash: false })
    }
  }
}

module.exports = { Actions }
