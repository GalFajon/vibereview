'use strict'

const vscode = require('vscode')
const { stats } = require('./tree')

/**
 * @param {import('./diff').Hunk} hunk
 * @param {string} languageId
 * @returns {vscode.MarkdownString | undefined} The replaced baseline code, for hovering.
 */
function beforeHover(hunk, languageId) {
  if (!hunk.baseLines.length) return undefined
  return new vscode.MarkdownString('**VibeReview · before:**').appendCodeblock(hunk.baseLines.join('\n'), languageId)
}

/**
 * Everything drawn inside editors: green added lines, a red marker where lines were removed
 * (hover shows them), Approve/Reject CodeLens over each hunk, and the status bar counter.
 */
class EditorUi {
  /** @param {import('./model').ReviewModel} model */
  constructor(model) {
    this.model = model
    this.lensEmitter = new vscode.EventEmitter()
    this.onDidChangeCodeLenses = this.lensEmitter.event
    this.addedType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    })
    this.removedType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderStyle: 'solid',
      borderWidth: '2px 0 0 0',
      borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      after: {
        color: new vscode.ThemeColor('editorGutter.deletedBackground'),
        margin: '0 0 0 2em',
        fontStyle: 'italic',
      },
    })
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.status.show()
    this.disposables = [
      this.addedType,
      this.removedType,
      this.status,
      this.lensEmitter,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
      model.onDidChange(() => this.renderAll()),
    ]
    this.renderAll()
  }

  renderAll() {
    for (const editor of vscode.window.visibleTextEditors) this.render(editor)
    this.lensEmitter.fire()
    this.renderStatus()
  }

  /** @param {vscode.TextEditor} editor */
  render(editor) {
    const doc = editor.document
    const change = doc.uri.scheme === 'file' ? this.model.changeForDocument(doc) : null
    const added = []
    const removed = []
    const last = doc.lineCount - 1
    for (const hunk of change?.hunks ?? []) {
      const start = Math.min(hunk.curStart, last)
      const hoverMessage = beforeHover(hunk, doc.languageId)
      if (hunk.curLines.length) {
        const end = Math.min(start + hunk.curLines.length - 1, last)
        added.push({ range: new vscode.Range(start, 0, end, 0), hoverMessage })
      }
      if (hunk.baseLines.length) {
        const n = hunk.baseLines.length
        const what = hunk.curLines.length ? 'replaced' : 'removed'
        removed.push({
          range: doc.lineAt(start).range,
          hoverMessage,
          renderOptions: { after: { contentText: `−${n} line${n === 1 ? '' : 's'} ${what} (hover)` } },
        })
      }
    }
    editor.setDecorations(this.addedType, added)
    editor.setDecorations(this.removedType, removed)
  }

  renderStatus() {
    if (!this.model.active) {
      this.status.text = '$(eye) VibeReview: start'
      this.status.tooltip = 'Snapshot the workspace and start reviewing agent edits'
      this.status.command = 'vibereview.start'
      return
    }
    const files = this.model.changes.size
    const hunks = [...this.model.changes.values()].reduce((n, c) => n + c.hunks.length, 0)
    this.status.text = files ? `$(eye) ${hunks} hunk${hunks === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}` : '$(check) VibeReview'
    this.status.tooltip = files ? 'Open the review (Ctrl+Alt+R)' : 'No pending changes'
    this.status.command = 'vibereview.open'
  }

  /**
   * @param {vscode.TextDocument} doc
   * @returns {vscode.CodeLens[]}
   */
  provideCodeLenses(doc) {
    const change = this.model.changeForDocument(doc)
    if (!change) return []
    const isNew = change.kind === 'added'
    return change.hunks.flatMap((hunk) => {
      const line = Math.min(hunk.curStart, doc.lineCount - 1)
      const range = new vscode.Range(line, 0, line, 0)
      const target = { type: 'hunk', rel: change.rel, kind: change.kind, hunk }
      return [
        new vscode.CodeLens(range, {
          title: isNew ? '$(check) Approve new file' : '$(check) Approve',
          tooltip: 'Alt+Y',
          command: 'vibereview.approve',
          arguments: [target],
        }),
        new vscode.CodeLens(range, {
          title: isNew ? '$(trash) Reject (delete file)' : '$(discard) Reject',
          tooltip: 'Alt+N',
          command: 'vibereview.reject',
          arguments: [target],
        }),
        new vscode.CodeLens(range, {
          title: isNew ? 'new file' : stats(hunk),
          tooltip: 'Open diff (Alt+D)',
          command: 'vibereview.openDiff',
          arguments: [target],
        }),
      ]
    })
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
  }
}

module.exports = { EditorUi }
