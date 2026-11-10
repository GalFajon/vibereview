'use strict'

const vscode = require('vscode')

// URI scheme serving baseline content to VS Code's diff editor.
const BASE_SCHEME = 'vibereview-base'

/**
 * @param {string} rel
 * @param {boolean} [empty] - Serve an empty document instead (the "after" side of a deleted file).
 * @returns {vscode.Uri}
 */
function baseUri(rel, empty = false) {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${rel}`, query: empty ? 'empty' : '' })
}

/**
 * @param {vscode.Uri} uri
 * @returns {string}
 */
function relFromBaseUri(uri) {
  return uri.path.slice(1)
}

/** Read-only documents with the {@link Baseline} text of each file. */
class BaseContent {
  /** @param {import('./baseline').Baseline} baseline */
  constructor(baseline) {
    this.baseline = baseline
    this.emitter = new vscode.EventEmitter()
    this.onDidChange = this.emitter.event
  }

  /**
   * @param {vscode.Uri} uri
   * @returns {string}
   */
  provideTextDocumentContent(uri) {
    if (uri.query === 'empty') return ''
    return this.baseline.read(relFromBaseUri(uri)) ?? ''
  }

  /** @param {string} rel - File whose baseline just changed. */
  refresh(rel) {
    this.emitter.fire(baseUri(rel))
  }

  dispose() {
    this.emitter.dispose()
  }
}

module.exports = { BASE_SCHEME, BaseContent, baseUri, relFromBaseUri }
