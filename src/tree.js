'use strict'

const vscode = require('vscode')
const path = require('path')

/**
 * Tree node, also the argument passed to commands from the tree and from CodeLens.
 *
 * @typedef {Object} Target
 * @property {'file' | 'hunk'} type
 * @property {string} rel
 * @property {'added' | 'deleted' | 'modified'} [kind]
 * @property {import('./diff').Hunk} [hunk] - Set when `type` is `hunk`.
 * @property {import('./model').FileChange} [change] - Set on file nodes built by the tree.
 */

// Lines shown in a hunk's hover preview before it is cut off.
const PREVIEW_LINES = 40

/**
 * @param {import('./diff').Hunk} hunk
 * @returns {string}
 */
function stats(hunk) {
  return `+${hunk.curLines.length} −${hunk.baseLines.length}`
}

/**
 * @param {import('./diff').Hunk} hunk
 * @returns {vscode.MarkdownString}
 */
function diffPreview(hunk) {
  const lines = [...hunk.baseLines.map((l) => `- ${l}`), ...hunk.curLines.map((l) => `+ ${l}`)]
  const shown = lines.slice(0, PREVIEW_LINES)
  if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more lines`)
  return new vscode.MarkdownString().appendCodeblock(shown.join('\n'), 'diff')
}

/** "Changes" view in the Source Control sidebar: files, each with its hunks. */
class ChangesTree {
  /** @param {import('./model').ReviewModel} model */
  constructor(model) {
    this.model = model
    this.emitter = new vscode.EventEmitter()
    this.onDidChangeTreeData = this.emitter.event
    this.subscription = model.onDidChange(() => this.emitter.fire())
  }

  /**
   * @param {Target} [node]
   * @returns {Target[]}
   */
  getChildren(node) {
    if (!node) return this.model.sortedChanges().map((change) => ({ type: 'file', rel: change.rel, kind: change.kind, change }))
    if (node.type !== 'file' || node.kind !== 'modified') return []
    return node.change.hunks.map((hunk) => ({ type: 'hunk', rel: node.rel, kind: node.kind, hunk }))
  }

  /**
   * @param {Target} node
   * @returns {vscode.TreeItem}
   */
  getTreeItem(node) {
    return node.type === 'file' ? this.fileItem(node) : hunkItem(node)
  }

  /**
   * @param {Target} node
   * @returns {vscode.TreeItem}
   */
  fileItem(node) {
    const { change } = node
    const modified = change.kind === 'modified'
    const item = new vscode.TreeItem(
      this.model.uriOf(node.rel),
      modified ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    )
    const dir = path.posix.dirname(node.rel)
    const added = change.hunks.reduce((n, h) => n + h.curLines.length, 0)
    const removed = change.hunks.reduce((n, h) => n + h.baseLines.length, 0)
    const summary = modified ? `+${added} −${removed}` : change.kind
    item.id = `file:${node.rel}`
    item.description = dir === '.' ? summary : `${dir}  ${summary}`
    item.contextValue = 'file'
    item.command = { command: 'vibereview.openDiff', title: 'Open Diff', arguments: [node] }
    if (!modified) item.tooltip = diffPreview(change.hunks[0])
    return item
  }

  dispose() {
    this.subscription.dispose()
    this.emitter.dispose()
  }
}

/**
 * @param {Target} node
 * @returns {vscode.TreeItem}
 */
function hunkItem(node) {
  const { hunk } = node
  const item = new vscode.TreeItem(`Line ${hunk.curStart + 1}`, vscode.TreeItemCollapsibleState.None)
  const snippet = [...hunk.curLines, ...hunk.baseLines].find((l) => l.trim())?.trim() ?? ''
  item.id = `hunk:${node.rel}:${hunk.curStart}:${hunk.baseStart}`
  item.description = `${stats(hunk)}  ${snippet}`
  item.tooltip = diffPreview(hunk)
  item.contextValue = 'hunk'
  item.iconPath = new vscode.ThemeIcon(
    !hunk.baseLines.length ? 'diff-added' : !hunk.curLines.length ? 'diff-removed' : 'diff-modified',
  )
  item.command = { command: 'vibereview.reveal', title: 'Reveal Hunk', arguments: [node] }
  return item
}

module.exports = { ChangesTree, stats }
