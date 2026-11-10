'use strict'

const vscode = require('vscode')
const { Baseline } = require('./baseline')
const { ReviewModel } = require('./model')
const { BASE_SCHEME, BaseContent } = require('./baseContent')
const { ChangesTree } = require('./tree')
const { EditorUi } = require('./editorUi')
const { Actions } = require('./actions')
const { ReviewPanel } = require('./reviewPanel')

// Delay before re-diffing after file events; agents often write the same file several times in a row.
const REFRESH_DELAY_MS = 250

/**
 * Batches paths from file events into one {@link ReviewModel.refresh} call.
 *
 * @param {ReviewModel} model
 * @returns {(rel: string) => void}
 */
function batchedRefresh(model) {
  const pending = new Set()
  let timer
  return (rel) => {
    pending.add(rel)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const rels = [...pending]
      pending.clear()
      model.refresh(rels)
    }, REFRESH_DELAY_MS)
  }
}

/**
 * Watches the workspace on disk (any agent: Claude Code, Codex, ...) and the user's own typing.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @param {ReviewModel} model
 * @returns {vscode.Disposable[]}
 */
function watch(folder, model) {
  const schedule = batchedRefresh(model)
  const onPath = (uri) => {
    const rel = model.relOf(uri)
    if (rel && model.active && !model.isExcluded(rel)) schedule(rel)
  }
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'))
  return [
    watcher,
    watcher.onDidCreate(onPath),
    watcher.onDidChange(onPath),
    watcher.onDidDelete(onPath),
    vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length && onPath(e.document.uri)),
  ]
}

/**
 * @param {ReviewModel} model
 * @param {ReviewPanel} panel
 */
async function start(model, panel) {
  if (model.active) {
    const answer = await vscode.window.showWarningMessage(
      'Reset the VibeReview baseline to the current files? All pending changes will count as approved.',
      { modal: true },
      'Reset',
    )
    if (answer !== 'Reset') return
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'VibeReview: snapshotting workspace…' },
    () => model.snapshot(),
  )
  vscode.window.setStatusBarMessage('VibeReview: baseline saved, agent edits will now show up for review', 4000)
  await panel.open()
}

/**
 * Opens the review layout whenever pending changes appear while it is closed, so reviewing is the
 * default rather than something to remember.
 *
 * @param {ReviewModel} model
 * @param {ReviewPanel} panel
 * @returns {vscode.Disposable}
 */
function autoOpen(model, panel) {
  let had = 0
  return model.onDidChange(() => {
    const has = model.changes.size
    const enabled = vscode.workspace.getConfiguration('vibereview').get('autoOpen', true)
    if (enabled && has && !had && !panel.isOpen) panel.open()
    had = has
  })
}

/** @param {ReviewModel} model */
async function stop(model) {
  const answer = await vscode.window.showWarningMessage(
    'Stop the review session? Files stay as they are; the baseline in .vibereview is deleted.',
    { modal: true },
    'Stop',
  )
  if (answer === 'Stop') model.stop()
}

/**
 * @param {ReviewModel} model
 * @param {Actions} actions
 * @param {ReviewPanel} panel
 * @returns {vscode.Disposable[]}
 */
function registerCommands(model, actions, panel) {
  /** @type {Record<string, (...args: any[]) => unknown>} */
  const commands = {
    'vibereview.open': () => panel.open(),
    'vibereview.start': () => start(model, panel),
    'vibereview.stop': () => stop(model),
    'vibereview.refresh': () => model.fullScan(),
    'vibereview.approve': (t) => actions.decide(t, true),
    'vibereview.reject': (t) => actions.decide(t, false),
    'vibereview.approveFile': (t) => actions.decideFileCommand(t, true),
    'vibereview.rejectFile': (t) => actions.decideFileCommand(t, false),
    'vibereview.approveAll': () => actions.decideAll(true),
    'vibereview.rejectAll': () => actions.decideAll(false),
    'vibereview.next': () => actions.next(),
    'vibereview.prev': () => actions.prev(),
    'vibereview.openDiff': (t) => actions.openDiff(t),
    'vibereview.reveal': (t) => actions.reveal(t),
  }
  return Object.entries(commands).map(([id, run]) =>
    vscode.commands.registerCommand(id, async (...args) => {
      try {
        await run(...args)
      } catch (err) {
        vscode.window.showErrorMessage(`VibeReview: ${err.message}`)
      }
    }),
  )
}

/** @param {ReviewModel} model */
function updateContext(model) {
  vscode.commands.executeCommand('setContext', 'vibereview.active', model.active)
  vscode.commands.executeCommand('setContext', 'vibereview.hasChanges', model.changes.size > 0)
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return
  const config = vscode.workspace.getConfiguration('vibereview')
  const baseline = new Baseline(folder.uri.fsPath)
  const model = new ReviewModel(folder.uri.fsPath, baseline, {
    excludeDirs: config.get('excludeDirs', []),
    maxBytes: config.get('maxFileSizeKB', 1024) * 1024,
  })
  const baseContent = new BaseContent(baseline)
  const actions = new Actions(model, baseContent)
  const panel = new ReviewPanel(context, model, actions)

  context.subscriptions.push(
    model,
    baseContent,
    panel,
    autoOpen(model, panel),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseContent),
    vscode.window.registerTreeDataProvider('vibereview.changes', new ChangesTree(model)),
    new EditorUi(model),
    model.onDidChange(() => updateContext(model)),
    ...registerCommands(model, actions, panel),
    ...watch(folder, model),
  )
  updateContext(model)
  if (model.active) model.fullScan()
}

function deactivate() {}

module.exports = { activate, deactivate }
