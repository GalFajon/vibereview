# 👁️ VibeReview

**Look at every line your AI agent wrote, then keep or drop each one.**

AI agents are fast. A bit too fast: you ask for a feature, a few seconds later twelve files have
changed, and you never really read any of them. Over time you understand your own codebase less
and less.

VibeReview is a small VS Code extension that brings back the "show me each change and let me decide"
feeling. It watches your workspace, gathers whatever your agent changed into small, readable hunks,
and lets you go through them one at a time with the keyboard: keep, drop, keep, drop. Nothing is
applied until you press Enter.

- 🤖 **Works with any agent.** Claude Code, Codex (CLI, desktop or IDE), Copilot, or a human. If it
  writes files, VibeReview sees it.
- 🌿 **No git required.** It keeps its own snapshot of your approved code, so you can review between
  commits, before commits, or without git at all.
- 🧾 **Transactional.** Stage keep/drop for each hunk, then apply everything at once or cancel and
  nothing happens.
- ⌨️ **Keyboard first.** `J` `K` `Y` `N` `Enter`, and you're done.
- 🪶 **Tiny.** Plain JavaScript, no dependencies, no build step.

## What it looks like

```
┌──────────┬───────────────────┬────────────────────────────────────────┐
│ Explorer │ 👁 VibeReview     │   approved            │    now          │
│          │ ━━━━━━━━━░░░░░░░  │                       │                 │
│          │ M pipeStyle.js    │   RADIUS = 7          │   RADIUS = 9    │
│          │   L32  +1 −1 ✓keep│                       │                 │
│          │   L75  +1 −1 ✕drop│   side-by-side diff of the hunk you    │
│          │ ▸ L129 +3         │   have selected, following your cursor │
│          │ A vibereviewTest  │                       │                 │
│          │ ───────────────── │                       │                 │
│          │ 1 keep · 1 drop   │                       │                 │
│          │ [Apply ⏎] [Esc]   │                       │                 │
└──────────┴───────────────────┴────────────────────────────────────────┘
```

The review list sits next to your Explorer and the diff of the selected hunk fills the rest of
the window. Open it with `Ctrl+Alt+R` (or the 👁 in the status bar). It also opens by itself when
new changes show up.

## The review loop

1. **Start a session.** Click `👁 VibeReview: start` in the status bar. Your current files become
   the *approved* baseline.
2. **Let your agent work.** Its changes appear in the review list as they happen.
3. **Go through them:**

   | Key                   | What it does                                                   |
   | --------------------- | -------------------------------------------------------------- |
   | `J` / `K` or arrows   | next / previous hunk (the diff follows)                        |
   | `Y`                   | stage **keep** and move on                                     |
   | `N`                   | stage **drop** and move on                                     |
   | `U` / `Backspace`     | unstage                                                        |
   | `Shift+Y` / `Shift+N` | keep / drop the whole file                                     |
   | `E`                   | open the real file and edit it yourself                        |
   | `Enter`               | ✅ **apply**: kept hunks are approved, dropped hunks are removed |
   | `Esc`                 | ↩️ **cancel**: clear all staged decisions, touch nothing         |

4. Repeat. When the list says **All clear**, everything you have is code you've seen.

Dropping a brand-new file sends it to the trash, so you can still get it back.

### Quick single decisions in the editor

In normal editors, changed lines are highlighted green, and a red marker shows where lines were
removed (hover it to see the old code). Every hunk has **Approve / Reject** buttons above it, and
these keys apply immediately:

| Key                 | Action                                     |
| ------------------- | ------------------------------------------ |
| `Alt+J` / `Alt+K`   | next / previous hunk across files          |
| `Alt+Y` / `Alt+N`   | approve / reject the hunk under the cursor |
| `Alt+D`             | full-file diff, approved ↔ now             |

## Install

There's no Marketplace release yet. Build the `.vsix` yourself:

```bash
git clone https://github.com/GalFajon/vibereview.git
cd vibereview
npx @vscode/vsce package
code --install-extension vibereview-0.0.1.vsix
```

Then reload VS Code (**Developer: Reload Window**).

To hack on it, open the folder in VS Code and press `F5`. A second window opens with the extension
loaded.

## How it works

- **Starting a session** copies your files into `.vibereview/baseline/`. That folder ignores itself
  in git, so your project's `.gitignore` doesn't need to change.
- **Pending** means the current file (or its unsaved buffer) differs from its baseline copy. A small
  LCS line diff splits each file into hunks, and edits within 2 lines of each other count as one.
- **Keeping** a hunk writes it into the baseline. **Dropping** a hunk writes the baseline version back
  into your file, through the editor when the file is open, so `Ctrl+Z` still works.
- **Applying** staged decisions re-diffs each file once and applies them bottom-up, so line numbers
  stay correct. If the agent rewrote a hunk while you were looking at it, that hunk stays pending.

## Settings

| Setting                    | Default                         | Meaning                                       |
| -------------------------- | ------------------------------- | --------------------------------------------- |
| `vibereview.autoOpen`      | `true`                          | open the review layout when new changes appear |
| `vibereview.excludeDirs`   | `node_modules`, `dist`, `.git`… | folder names that are never tracked           |
| `vibereview.maxFileSizeKB` | `1024`                          | larger files are ignored                      |

## Limits (it's a prototype 🐣)

- First workspace folder only. Text files only; binaries are ignored.
- Staged decisions live in memory, so a window reload clears them (your files are untouched).
- Line-level diffs, no word-level highlighting in the list.

## Ideas

- An MCP tool so agents can attach a short **"why"** to each hunk, shown right next to the code
- A Claude Code `PreToolUse` hook for a strict "ask before every write" mode
- Grouping hunks by agent message or step, plus a decision log

## Development

```bash
npm test   # diff engine tests (node:test, no dependencies)
```

To restyle the review list without reloading VS Code, serve the repo (`python -m http.server`) and
open `.vscode/webview-harness.html`. It renders `media/` with a fake VS Code API and a dark theme.

---

Made for people who want to vibe *and* understand their code. 👁️✨
