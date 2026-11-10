'use strict'

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { computeChange } = require('./diff')
const { STATE_DIR } = require('./baseline')

/**
 * @typedef {Object} FileChange
 * @property {string} rel - Workspace-relative path with `/` separators.
 * @property {'added' | 'deleted' | 'modified'} kind
 * @property {import('./diff').Hunk[]} hunks
 */

/**
 * @typedef {Object} CurrentText
 * @property {string | null} text - `null` when the file does not exist.
 * @property {boolean} skipped - True for binary, oversized or unreadable files, which are not tracked.
 */

/**
 * @param {string} file
 * @param {number} maxBytes
 * @returns {CurrentText}
 */
function readTrackable(file, maxBytes) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > maxBytes) return { text: null, skipped: true }
    const buf = fs.readFileSync(file)
    if (buf.subarray(0, 8000).includes(0)) return { text: null, skipped: true }
    return { text: buf.toString('utf8'), skipped: false }
  } catch (err) {
    // A file mid-write by an agent can be briefly locked on Windows; the next event retries it.
    return err.code === 'ENOENT' ? { text: null, skipped: false } : { text: null, skipped: true }
  }
}

/**
 * Pending changes of the first workspace folder: every tracked file whose current text (open
 * buffer first, else disk) differs from its {@link Baseline} copy.
 */
class ReviewModel {
  /**
   * @param {string} root
   * @param {import('./baseline').Baseline} baseline
   * @param {{ excludeDirs: string[], maxBytes: number }} options
   */
  constructor(root, baseline, options) {
    this.root = root
    this.baseline = baseline
    this.excludeDirs = [...new Set(['.git', STATE_DIR, ...options.excludeDirs])]
    this.maxBytes = options.maxBytes
    /** @type {Map<string, FileChange>} */
    this.changes = new Map()
    // Hunks approved or rejected since the session started (or the window loaded), for the progress bar.
    this.decided = 0
    this.emitter = new vscode.EventEmitter()
    this.onDidChange = this.emitter.event
  }

  /** @returns {boolean} */
  get active() {
    return this.baseline.exists()
  }

  /**
   * @param {vscode.Uri} uri
   * @returns {string | null} Workspace-relative path, or `null` outside the workspace.
   */
  relOf(uri) {
    if (uri.scheme !== 'file') return null
    const rel = path.relative(this.root, uri.fsPath)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return rel.split(path.sep).join('/')
  }

  /**
   * @param {string} rel
   * @returns {string}
   */
  absOf(rel) {
    return path.join(this.root, ...rel.split('/'))
  }

  /**
   * @param {string} rel
   * @returns {vscode.Uri}
   */
  uriOf(rel) {
    return vscode.Uri.file(this.absOf(rel))
  }

  /**
   * @param {string} rel
   * @returns {boolean}
   */
  isExcluded(rel) {
    return rel.split('/').some((segment) => this.excludeDirs.includes(segment))
  }

  /**
   * @param {string} rel
   * @returns {vscode.TextDocument | undefined}
   */
  openDocument(rel) {
    const file = this.absOf(rel)
    const same = process.platform === 'win32' ? (p) => p.toLowerCase() === file.toLowerCase() : (p) => p === file
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && same(d.uri.fsPath))
  }

  /**
   * The file as the user sees it: an open buffer wins over disk, so unsaved edits count.
   *
   * @param {string} rel
   * @returns {CurrentText}
   */
  readCurrent(rel) {
    const file = this.absOf(rel)
    const doc = this.openDocument(rel)
    // A clean buffer of a file deleted on disk is stale, so only trust it while the file exists.
    if (doc && (doc.isDirty || fs.existsSync(file))) {
      const text = doc.getText()
      return text.length > this.maxBytes ? { text: null, skipped: true } : { text, skipped: false }
    }
    return readTrackable(file, this.maxBytes)
  }

  /**
   * @param {string} rel
   * @returns {FileChange | null}
   */
  computeFile(rel) {
    const cur = this.readCurrent(rel)
    if (cur.skipped) return null
    const change = computeChange(this.baseline.read(rel), cur.text)
    return change && { rel, ...change }
  }

  /**
   * Fresh change for an editor, computed from its live text (used for CodeLens and decorations).
   *
   * @param {vscode.TextDocument} doc
   * @returns {FileChange | null}
   */
  changeForDocument(doc) {
    const rel = this.relOf(doc.uri)
    if (!rel || !this.active || this.isExcluded(rel)) return null
    const text = doc.getText()
    if (text.length > this.maxBytes) return null
    const change = computeChange(this.baseline.read(rel), text)
    return change && { rel, ...change }
  }

  /** @returns {FileChange[]} Sorted by path, the order used for next/previous navigation. */
  sortedChanges() {
    return [...this.changes.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  }

  /** @returns {Promise<string[]>} */
  async listWorkspaceFiles() {
    const exclude = `**/{${this.excludeDirs.join(',')}}/**`
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root, '**/*'), exclude)
    return uris.map((uri) => this.relOf(uri)).filter((rel) => rel && !this.isExcluded(rel))
  }

  /**
   * Re-diffs the given paths. A path can be a deleted folder, so known files under it are included.
   *
   * @param {string[]} rels
   */
  refresh(rels) {
    if (!this.active) return
    const all = new Set()
    let baselineFiles = null
    for (const rel of rels) {
      all.add(rel)
      const prefix = `${rel}/`
      for (const known of this.changes.keys()) if (known.startsWith(prefix)) all.add(known)
      if (!fs.existsSync(this.absOf(rel)) && this.baseline.read(rel) === null) {
        baselineFiles ??= this.baseline.list()
        for (const known of baselineFiles) if (known.startsWith(prefix)) all.add(known)
      }
    }
    for (const rel of all) {
      const change = this.isExcluded(rel) ? null : this.computeFile(rel)
      if (change) this.changes.set(rel, change)
      else this.changes.delete(rel)
    }
    this.emitter.fire()
  }

  /** Diffs every tracked and every current file. */
  async fullScan() {
    if (!this.active) return
    const files = await this.listWorkspaceFiles()
    this.changes.clear()
    this.refresh([...new Set([...files, ...this.baseline.list()])])
  }

  /** Starts (or resets) a session: the current files on disk become the approved baseline. */
  async snapshot() {
    const files = await this.listWorkspaceFiles()
    this.baseline.reset()
    for (const rel of files) {
      const { text } = readTrackable(this.absOf(rel), this.maxBytes)
      if (text !== null) this.baseline.write(rel, text)
    }
    this.changes.clear()
    this.decided = 0
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => this.relOf(d.uri))
    this.refresh(dirty.filter(Boolean))
  }

  /** Ends the session and deletes its state. */
  stop() {
    this.baseline.destroy()
    this.changes.clear()
    this.emitter.fire()
  }

  dispose() {
    this.emitter.dispose()
  }
}

module.exports = { ReviewModel }
