'use strict'

const fs = require('fs')
const path = require('path')

// Folder in the reviewed workspace that holds all VibeReview state.
const STATE_DIR = '.vibereview'

/**
 * The last approved content of every tracked file, mirrored under `.vibereview/baseline/`.
 * "Pending" is simply "current file differs from its baseline", so no git is involved.
 * Paths are workspace-relative with `/` separators.
 */
class Baseline {
  /** @param {string} root - Workspace folder path. */
  constructor(root) {
    this.stateDir = path.join(root, STATE_DIR)
    this.dir = path.join(this.stateDir, 'baseline')
    /** @type {Map<string, string | null>} */
    this.cache = new Map()
  }

  /** @returns {boolean} Whether a review session is running. */
  exists() {
    return fs.existsSync(this.dir)
  }

  /**
   * @param {string} rel
   * @returns {string}
   */
  pathOf(rel) {
    return path.join(this.dir, ...rel.split('/'))
  }

  /**
   * @param {string} rel
   * @returns {string | null} `null` when the file was not in the baseline.
   */
  read(rel) {
    if (this.cache.has(rel)) return this.cache.get(rel)
    let text = null
    try {
      text = fs.readFileSync(this.pathOf(rel), 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EISDIR') throw err
    }
    this.cache.set(rel, text)
    return text
  }

  /**
   * @param {string} rel
   * @param {string} text
   */
  write(rel, text) {
    const file = this.pathOf(rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text, 'utf8')
    this.cache.set(rel, text)
  }

  /** @param {string} rel */
  remove(rel) {
    fs.rmSync(this.pathOf(rel), { force: true })
    this.cache.set(rel, null)
  }

  /** @returns {string[]} Every file in the baseline. */
  list() {
    const out = []
    const walk = (dir, prefix) => {
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
        else out.push(rel)
      }
    }
    walk(this.dir, '')
    return out
  }

  /** Empties the baseline, creating the state folder if needed. */
  reset() {
    fs.rmSync(this.dir, { recursive: true, force: true })
    fs.mkdirSync(this.dir, { recursive: true })
    // Makes git ignore the state folder without touching the project's own .gitignore.
    fs.writeFileSync(path.join(this.stateDir, '.gitignore'), '*\n')
    this.cache.clear()
  }

  /** Deletes all VibeReview state, ending the session. */
  destroy() {
    fs.rmSync(this.stateDir, { recursive: true, force: true })
    this.cache.clear()
  }
}

module.exports = { Baseline, STATE_DIR }
