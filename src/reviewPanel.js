'use strict'

const vscode = require('vscode')
const path = require('path')
const crypto = require('crypto')

// Webview type id, also used to restore the panel after a window reload.
const VIEW_TYPE = 'vibereview.review'

// Width share of the review list in the review layout; the side-by-side diff gets the rest.
const LIST_SIZE = 0.27

// Diff lines shown inline under the selected hunk in the list.
const PREVIEW_LINES = 14

/**
 * @param {import('./diff').Hunk} hunk
 * @returns {{ lines: Array<{ k: '+' | '-', s: string }>, more: number }}
 */
function preview(hunk) {
  const all = [...hunk.baseLines.map((s) => ({ k: '-', s })), ...hunk.curLines.map((s) => ({ k: '+', s }))]
  return { lines: all.slice(0, PREVIEW_LINES), more: Math.max(0, all.length - PREVIEW_LINES) }
}

/**
 * @param {import('./tree').Target} target
 * @returns {string} Identity of a hunk for staging: its file and content, not its position, so a
 *   staged mark survives the agent editing elsewhere in the same file.
 */
function markKey(target) {
  return `${target.rel}\0${target.hunk.baseLines.join('\n')}\0${target.hunk.curLines.join('\n')}`
}

/**
 * The review workspace: a list of pending hunks in the left editor column (next to the Explorer)
 * and the selected hunk's side-by-side diff in the right column. The list is a webview, so it can
 * be driven with single keys (j/k/y/n) while the diff keeps scrolling along without taking focus.
 *
 * Decisions made here are a transaction: y/n only stage a mark, Enter applies all marks at once
 * through {@link Actions.commit}, and Esc drops them, so nothing is lost until you confirm.
 */
class ReviewPanel {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./model').ReviewModel} model
   * @param {import('./actions').Actions} actions
   */
  constructor(context, model, actions) {
    this.extensionUri = context.extensionUri
    this.model = model
    this.actions = actions
    /** @type {vscode.WebviewPanel | null} */
    this.panel = null
    /** @type {import('./tree').Target[]} Hunks of the last posted state; the webview refers to them by index. */
    this.targets = []
    /** @type {Map<string, 'approve' | 'reject'>} Staged, not yet applied decisions, by {@link markKey}. */
    this.marks = new Map()
    this.subscriptions = [
      model.onDidChange(() => this.post()),
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel) => this.attach(panel),
      }),
    ]
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.panel !== null
  }

  /** Opens (or focuses) the review layout: list on the left, diffs on the right. */
  async open() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One)
      return
    }
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
      orientation: 0,
      groups: [{ size: LIST_SIZE }, { size: 1 - LIST_SIZE }],
    })
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'VibeReview', vscode.ViewColumn.One, {})
    this.attach(panel)
    // Locked, so files opened from the Explorer go to the diff column instead of replacing the list.
    await vscode.commands.executeCommand('workbench.action.lockEditorGroup')
  }

  /** @param {vscode.WebviewPanel} panel */
  attach(panel) {
    this.panel = panel
    const media = vscode.Uri.joinPath(this.extensionUri, 'media')
    panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg')
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] }
    panel.webview.html = this.html(panel.webview, media)
    panel.webview.onDidReceiveMessage((msg) =>
      this.onMessage(msg).catch((err) => vscode.window.showErrorMessage(`VibeReview: ${err.message}`)),
    )
    panel.onDidDispose(() => {
      this.panel = null
    })
  }

  /**
   * @param {vscode.Webview} webview
   * @param {vscode.Uri} media
   * @returns {string}
   */
  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64')
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'review.css'))
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'review.js'))
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>VibeReview</title>
</head>
<body tabindex="0">
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`
  }

  /** Sends the current pending changes to the webview. */
  post() {
    if (!this.panel) return
    this.targets = []
    const live = new Map()
    const mark = (target) => {
      const key = markKey(target)
      if (this.marks.has(key)) live.set(key, this.marks.get(key))
      return this.marks.get(key) ?? null
    }
    const files = this.model.sortedChanges().map((c) => ({
      rel: c.rel,
      name: path.posix.basename(c.rel),
      dir: path.posix.dirname(c.rel) === '.' ? '' : path.posix.dirname(c.rel),
      kind: c.kind,
      added: c.hunks.reduce((n, h) => n + h.curLines.length, 0),
      removed: c.hunks.reduce((n, h) => n + h.baseLines.length, 0),
      hunks: c.hunks.map((h) => ({
        index: this.targets.push({ type: 'hunk', rel: c.rel, kind: c.kind, hunk: h }) - 1,
        line: h.curStart + 1,
        curStart: h.curStart,
        baseStart: h.baseStart,
        added: h.curLines.length,
        removed: h.baseLines.length,
        snippet: [...h.curLines, ...h.baseLines].find((l) => l.trim())?.trim() ?? '',
        preview: preview(h),
        decision: mark(this.targets[this.targets.length - 1]),
      })),
    }))
    // Marks of hunks that no longer exist (the agent rewrote them) are dropped.
    this.marks = live
    this.panel.webview.postMessage({ type: 'state', active: this.model.active, decided: this.model.decided, files })
  }

  /**
   * Stages `decision` on `targets`, or clears it when every target already has it (toggle).
   *
   * @param {import('./tree').Target[]} targets
   * @param {'approve' | 'reject' | null} decision - `null` clears.
   */
  stage(targets, decision) {
    const keys = targets.map(markKey)
    const toggleOff = decision === null || keys.every((k) => this.marks.get(k) === decision)
    for (const k of keys) {
      if (toggleOff) this.marks.delete(k)
      else this.marks.set(k, decision)
    }
    this.post()
  }

  /** Applies every staged mark, then clears them. */
  async commit() {
    const decisions = this.targets
      .filter((t) => this.marks.has(markKey(t)))
      .map((target) => ({ target, approve: this.marks.get(markKey(target)) === 'approve' }))
    if (!decisions.length) return
    this.marks.clear()
    const { skipped } = await this.actions.commit(decisions)
    if (skipped) {
      vscode.window.showWarningMessage(
        `VibeReview: ${skipped} staged change(s) were modified while you reviewed and were left pending.`,
      )
    }
    this.post()
  }

  /** @param {{ type: string, index?: number, rel?: string, decision?: 'approve' | 'reject' | null }} msg */
  async onMessage(msg) {
    const target = msg.index === undefined ? undefined : this.targets[msg.index]
    const decision = msg.decision ?? null
    switch (msg.type) {
      case 'ready':
        return this.post()
      case 'select':
        return target && this.actions.openDiff(target, { viewColumn: vscode.ViewColumn.Two, preserveFocus: true })
      case 'edit':
        return target && this.actions.reveal(target, vscode.ViewColumn.Two)
      case 'mark':
        return target && this.stage([target], decision)
      case 'markFile':
        return this.stage(
          this.targets.filter((t) => t.rel === msg.rel),
          decision,
        )
      case 'markAll':
        return this.stage(this.targets, decision)
      case 'cancel':
        this.marks.clear()
        return this.post()
      case 'commit':
        return this.commit()
      case 'start':
        return vscode.commands.executeCommand('vibereview.start')
      default:
        return undefined
    }
  }

  dispose() {
    for (const s of this.subscriptions) s.dispose()
    this.panel?.dispose()
  }
}

module.exports = { ReviewPanel, VIEW_TYPE }
