// Review list webview. Receives `state` messages from ReviewPanel and sends back user decisions.
// Hunks are addressed by the `index` the extension assigned in the last state it posted.
;(function () {
  const vscode = acquireVsCodeApi()
  const root = document.getElementById('root')

  let state = null
  // Selected hunk, identified by content and position so it survives state updates.
  let sel = null

  const KIND_BADGE = { modified: 'M', added: 'A', deleted: 'D' }
  const ICONS = {
    check: 'M3 8.5l3.2 3.2L13 4.8',
    x: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
    edit: 'M10.5 2.5l3 3-8 8H2.5v-3z',
    logo: 'M8 3C4.5 3 2 8 2 8s2.5 5 6 5 6-5 6-5-2.5-5-6-5zm0 7.5A2.5 2.5 0 118 5.5a2.5 2.5 0 010 5z',
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
      else if (key === 'class') el.className = value
      else el.setAttribute(key, value === true ? '' : value)
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue
      el.append(child instanceof Node ? child : String(child))
    }
    return el
  }

  function icon(name, filled) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('class', 'icon')
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', ICONS[name])
    if (filled) p.setAttribute('fill', 'currentColor')
    else {
      p.setAttribute('fill', 'none')
      p.setAttribute('stroke', 'currentColor')
      p.setAttribute('stroke-width', '1.6')
      p.setAttribute('stroke-linecap', 'round')
      p.setAttribute('stroke-linejoin', 'round')
    }
    svg.append(p)
    return svg
  }

  const flat = () => (state ? state.files.flatMap((f) => f.hunks.map((hk) => ({ f, hk }))) : [])
  const post = (type, extra) => vscode.postMessage({ type, ...extra })
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

  function keyOf(f, hk, i) {
    return { rel: f.rel, curStart: hk.curStart, baseStart: hk.baseStart, added: hk.added, removed: hk.removed, flat: i, decided: false }
  }

  // Keeps the selection on the same hunk across updates. After a decision it stays at the same list
  // position, which is the next hunk. Returns whether the selection moved to a different hunk.
  function reconcile() {
    const list = flat()
    if (!list.length) {
      sel = null
      return false
    }
    let i = -1
    if (sel && !sel.decided) {
      i = list.findIndex(
        ({ f, hk }) =>
          f.rel === sel.rel &&
          (hk.curStart === sel.curStart || hk.baseStart === sel.baseStart) &&
          hk.added === sel.added &&
          hk.removed === sel.removed,
      )
    }
    const moved = i < 0
    if (i < 0) i = sel ? Math.min(sel.flat, list.length - 1) : 0
    sel = keyOf(list[i].f, list[i].hk, i)
    return moved
  }

  function current() {
    return sel ? flat()[sel.flat] : undefined
  }

  function select(i) {
    const list = flat()
    if (!list.length) return
    const clamped = Math.max(0, Math.min(i, list.length - 1))
    sel = keyOf(list[clamped].f, list[clamped].hk, clamped)
    render()
    show()
  }

  function show() {
    const item = current()
    if (item) post('select', { index: item.hk.index })
  }

  // Stages a decision on the selected hunk (pressing the same key again clears it) and moves on.
  function mark(decision) {
    const item = current()
    if (!item) return
    post('mark', { index: item.hk.index, decision })
    if (decision && sel.flat < flat().length - 1) select(sel.flat + 1)
  }

  function markFile(rel, decision) {
    post('markFile', { rel, decision })
  }

  function staged() {
    const list = flat()
    return {
      approve: list.filter(({ hk }) => hk.decision === 'approve').length,
      reject: list.filter(({ hk }) => hk.decision === 'reject').length,
    }
  }

  function commit() {
    const s = staged()
    if (!s.approve && !s.reject) return
    // Applied hunks disappear, so keep the selection at the same list position.
    if (sel) sel.decided = true
    post('commit')
  }

  function edit() {
    const item = current()
    if (item) post('edit', { index: item.hk.index })
  }

  function stats(added, removed) {
    return h(
      'span',
      { class: 'stats' },
      added ? h('span', { class: 'add' }, `+${added}`) : null,
      removed ? h('span', { class: 'del' }, `−${removed}`) : null,
    )
  }

  function iconButton(name, title, onclick, extraClass) {
    return h(
      'button',
      {
        class: `icon-btn ${extraClass || ''}`,
        title,
        onclick: (e) => {
          e.stopPropagation()
          onclick()
        },
      },
      icon(name),
    )
  }

  function button(label, key, cls, onclick) {
    return h(
      'button',
      {
        class: `btn ${cls}`,
        onclick: (e) => {
          e.stopPropagation()
          onclick()
        },
      },
      label,
      key ? h('kbd', {}, key) : null,
    )
  }

  function previewBlock(hk) {
    return h(
      'div',
      { class: 'preview' },
      hk.preview.lines.map((l) => h('div', { class: `l ${l.k === '+' ? 'add' : 'del'}` }, h('span', { class: 'sign' }, l.k), l.s || ' ')),
      hk.preview.more ? h('div', { class: 'l more' }, `… ${plural(hk.preview.more, 'more line')} in the diff`) : null,
    )
  }

  function decisionPill(decision) {
    if (decision === 'approve') return h('span', { class: 'pill ok' }, icon('check'), 'keep')
    if (decision === 'reject') return h('span', { class: 'pill no' }, icon('x'), 'drop')
    return null
  }

  function hunkRow(f, hk, i) {
    const selected = sel && sel.flat === i
    const label = f.kind === 'added' ? 'new file' : f.kind === 'deleted' ? 'deleted' : `L${hk.line}`
    const state = hk.decision === 'approve' ? ' staged-ok' : hk.decision === 'reject' ? ' staged-no' : ''
    return h(
      'div',
      { class: `hunk${selected ? ' sel' : ''}${state}`, onclick: () => select(i), ondblclick: edit },
      h(
        'div',
        { class: 'hunk-line' },
        h('span', { class: 'ln' }, label),
        stats(hk.added, hk.removed),
        h('span', { class: 'snippet' }, hk.snippet),
        decisionPill(hk.decision),
      ),
      selected ? previewBlock(hk) : null,
      selected
        ? h(
            'div',
            { class: 'hunk-actions' },
            button('Approve', 'Y', `primary${hk.decision === 'approve' ? ' on' : ''}`, () => mark('approve')),
            button('Reject', 'N', `danger${hk.decision === 'reject' ? ' on' : ''}`, () => mark('reject')),
            hk.decision ? button('Unstage', 'U', 'ghost', () => mark(null)) : null,
            f.kind === 'deleted' ? null : button('Edit', 'E', 'ghost', edit),
          )
        : null,
    )
  }

  function fileCard(f, firstIndex) {
    return h(
      'section',
      { class: `file ${f.kind}` },
      h(
        'div',
        { class: 'file-head', title: f.rel },
        h('span', { class: `badge ${f.kind}` }, KIND_BADGE[f.kind]),
        h('span', { class: 'name' }, f.name),
        h('span', { class: 'dir' }, f.dir),
        stats(f.added, f.removed),
        h(
          'span',
          { class: 'file-actions' },
          iconButton('check', 'Stage approve for the whole file (Shift+Y)', () => markFile(f.rel, 'approve'), 'ok'),
          iconButton('x', 'Stage reject for the whole file (Shift+N)', () => markFile(f.rel, 'reject'), 'no'),
        ),
      ),
      f.hunks.map((hk, j) => hunkRow(f, hk, firstIndex + j)),
    )
  }

  function header(total) {
    const done = state.decided
    const pct = done + total ? Math.round((done / (done + total)) * 100) : 100
    const bar = h('div', { class: 'bar' })
    bar.style.width = `${pct}%`
    return h(
      'header',
      {},
      h(
        'div',
        { class: 'top' },
        h('span', { class: 'title' }, icon('logo', true), 'VibeReview'),
        h('span', { class: 'count' }, total ? `${plural(total, 'hunk')} · ${plural(state.files.length, 'file')}` : 'clean'),
      ),
      h('div', { class: 'progress', title: `${done} reviewed, ${total} left` }, bar),
      total
        ? h(
            'div',
            { class: 'bulk' },
            button('Approve all', null, 'secondary small', () => post('markAll', { decision: 'approve' })),
            button('Reject all', null, 'danger small', () => post('markAll', { decision: 'reject' })),
          )
        : null,
    )
  }

  function emptyView(mark, title, text, action) {
    return h('div', { class: 'empty' }, h('div', { class: 'mark' }, mark), h('h2', {}, title), h('p', {}, text), action || null)
  }

  // Hints while nothing is staged; the apply/cancel bar of the transaction once something is.
  function footer() {
    const s = staged()
    if (s.approve || s.reject) {
      return h(
        'footer',
        { class: 'commit' },
        h(
          'div',
          { class: 'summary' },
          s.approve ? h('span', { class: 'add' }, `${s.approve} keep`) : null,
          s.reject ? h('span', { class: 'del' }, `${s.reject} drop`) : null,
          h('span', { class: 'muted' }, 'staged'),
        ),
        h(
          'div',
          { class: 'commit-actions' },
          button('Apply', '⏎', 'primary', commit),
          button('Cancel', 'Esc', 'ghost', () => post('cancel')),
        ),
      )
    }
    const k = (key, what) => h('span', { class: 'hint' }, h('kbd', {}, key), what)
    return h('footer', {}, k('J K', 'move'), k('Y', 'keep'), k('N', 'drop'), k('⇧Y ⇧N', 'file'), k('⏎', 'apply'), k('E', 'edit'))
  }

  function render() {
    root.replaceChildren()
    if (!state) return
    if (!state.active) {
      root.append(
        emptyView(
          icon('logo', true),
          'No review session',
          'Snapshot the workspace, then let Claude Code, Codex or any other agent work. Every change shows up here, hunk by hunk.',
          button('Start review session', null, 'primary', () => post('start')),
        ),
      )
      return
    }
    const total = flat().length
    root.append(header(total))
    if (!total) {
      root.append(emptyView(icon('check'), 'All clear', 'Nothing left to review. New agent edits will appear here.'))
      return
    }
    let index = 0
    const main = h('main', {})
    for (const f of state.files) {
      main.append(fileCard(f, index))
      index += f.hunks.length
    }
    root.append(main, footer())
    document.querySelector('.hunk.sel')?.scrollIntoView({ block: 'nearest' })
  }

  window.addEventListener('message', (event) => {
    if (event.data.type !== 'state') return
    state = event.data
    const moved = reconcile()
    render()
    if (moved) show()
  })

  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !state) return
    const handlers = {
      j: () => select(sel ? sel.flat + 1 : 0),
      ArrowDown: () => select(sel ? sel.flat + 1 : 0),
      k: () => select(sel ? sel.flat - 1 : 0),
      ArrowUp: () => select(sel ? sel.flat - 1 : 0),
      y: () => mark('approve'),
      n: () => mark('reject'),
      u: () => mark(null),
      Backspace: () => mark(null),
      Y: () => sel && markFile(sel.rel, 'approve'),
      N: () => sel && markFile(sel.rel, 'reject'),
      Enter: commit,
      Escape: () => post('cancel'),
      e: edit,
      d: show,
    }
    const run = handlers[e.key]
    if (!run) return
    e.preventDefault()
    run()
  })

  post('ready')
})()
