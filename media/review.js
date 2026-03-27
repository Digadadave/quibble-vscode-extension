// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

// ── Icon constants (codicon IDs) ────────────────────────────────────────────
const ICONS = {
  COMMENT_UNRESOLVED: 'comment-unresolved',
  CHECK:              'check',
  CHECK_ALL:          'check-all',
  VERIFIED_FILLED:    'verified-filled',
  SYNC_IGNORED:       'sync-ignored',
  TRASH:              'trash',
  ARROW_RIGHT:        'arrow-right',
};

// ── Status transition options ───────────────────────────────────────────────
const STATUS_OPTIONS = [
  { status: 'open',      icon: ICONS.COMMENT_UNRESOLVED, label: 'Reopen',   cssVar: '--status-open' },
  { status: 'addressed', icon: ICONS.CHECK,              label: 'Addressed', cssVar: '--status-addressed' },
  { status: 'closed',    icon: ICONS.CHECK_ALL,          label: 'Close',    cssVar: '--status-closed' },
  { status: 'dismissed', icon: ICONS.SYNC_IGNORED,       label: 'Dismiss',  cssVar: '--status-dismissed' },
];

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  /** @type {any[]} */
  comments: [],
  /** @type {Set<string>} selected hashes */
  selectedHashes: new Set(),
  /** @type {Set<string>} */
  reviewedCommits: new Set(),
  /** @type {any[]} */
  currentDiff: [],
  /** @type {any[]} */
  currentChangedFiles: [],
  /** @type {string} */
  currentOldestShort: '',
  /** @type {string} */
  currentNewestShort: '',
  /** @type {string} Git user name for display (fallback: 'reviewer') */
  gitUserName: 'reviewer',
  /** @type {string} Active repo folder name */
  repoName: '',
  /** @type {number} Number of discovered repos (show button only when > 1) */
  repoCount: 1,
};

let pendingCommentFile = '';
let pendingCommentLine = 0;
let pendingCommentLineEnd = 0;
let pendingCommentCommitHash = '';
let pendingCommentSnippet = '';
/** The currently open inline composer <tr>, or null. */
let composerRow = /** @type {HTMLTableRowElement|null} */ (null);
/** Guard against double-submit. */
let submittingComment = false;
/** Set true by mouseup-open to stop the subsequent click from closing the composer. */
let composerJustOpened = false;

/** Split-view drag state */
let splitDragging = false;
let splitDragStartX = 0;   // clientX at drag start
let splitDragStartPx = 0;  // old-column pixel width at drag start

/** Expander drag state */
let expanderDragging = false;
let expanderDragRow  = /** @type {HTMLElement|null} */ (null);
let expanderDragLastY = 0;
let expanderDragAccum = 0;   // accumulated pixels (positive = down, negative = up)
let expanderFetchPending = false;
const EXPANDER_PX_PER_LINE = 18;

// ── Message handler ────────────────────────────────────────────────────────

window.addEventListener('message', (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'loading': {
      state.selectedHashes  = new Set();
      state.currentDiff     = [];
      const main = document.getElementById('main');
      if (main) main.innerHTML = '<div class="empty-state"><p>Loading\u2026</p></div>';
      break;
    }
    case 'load':
      // Refresh comments + selected set (sent after any comment mutation)
      state.comments       = msg.comments       ?? [];
      state.selectedHashes = new Set(msg.selectedHashes ?? []);
      if (msg.gitUserName) state.gitUserName = msg.gitUserName;
      if (msg.repoName  !== undefined) state.repoName  = msg.repoName;
      if (msg.repoCount !== undefined) state.repoCount = msg.repoCount;
      renderTopBar();
      renderDiff();
      break;
    case 'diffResult':
      state.currentDiff         = msg.parsedDiff    ?? [];
      state.currentChangedFiles = msg.changedFiles   ?? [];
      state.currentOldestShort  = msg.oldestShort   ?? '';
      state.currentNewestShort  = msg.newestShort   ?? '';
      state.selectedHashes      = new Set(msg.selectedHashes ?? []);
      state.comments            = msg.comments      ?? state.comments;
      if (msg.gitUserName) state.gitUserName = msg.gitUserName;
      if (msg.repoName  !== undefined) state.repoName  = msg.repoName;
      if (msg.repoCount !== undefined) state.repoCount = msg.repoCount;
      renderTopBar();
      renderDiff();
      if (msg.focusCommentId) scrollToComment(/** @type {string} */ (msg.focusCommentId));
      break;
    case 'repoInfo':
      state.repoName  = msg.repoName  ?? '';
      state.repoCount = msg.repoCount ?? 1;
      updateRepoButton();
      break;
    case 'focusFile':
      if (msg.file) scrollToFile(/** @type {string} */ (msg.file));
      break;
    case 'focusComment':
      if (msg.id) scrollToComment(/** @type {string} */ (msg.id));
      break;

    case 'contextLines':
      insertContextLines(msg.key, msg.direction, msg.lines ?? []);
      break;
  }
});

// ── Event delegation ───────────────────────────────────────────────────────

document.addEventListener('click', (/** @type {MouseEvent} */ e) => {
  const target = /** @type {HTMLElement} */ (e.target);

  // Close inline composer when clicking outside it
  if (composerRow && !composerRow.contains(target)) {
    if (composerJustOpened) {
      composerJustOpened = false; // opened by mouseup — ignore this click entirely
      return;
    }
    const ta = /** @type {HTMLTextAreaElement|null} */ (composerRow.querySelector('textarea'));
    if (ta?.value?.trim()) {
      // Textarea has content — keep composer open, don't process as line click
      return;
    }
    closeComposer();
    // fall through — if the click was on a line row, open a new composer for it
  }

  const btn = /** @type {HTMLElement|null} */ (target.closest('[data-action]'));
  if (btn) {
    const action = btn.getAttribute('data-action') ?? '';

    switch (action) {
      case 'toggle-reviewed':
        toggleMarkReviewed();
        break;

      case 'select-repo':
        vscode.postMessage({ type: 'selectRepo' });
        break;

      case 'close-composer':
        closeComposer();
        break;

      case 'submit-comment':
        submitComment();
        break;

      case 'export-reviews':
        vscode.postMessage({ type: 'exportReviews' });
        break;

      case 'copy-agent-prompt':
        vscode.postMessage({ type: 'copyAgentPrompt' });
        break;

      case 'toggle-file': {
        const header = btn.closest('.file-header');
        if (header) toggleFile(/** @type {HTMLElement} */ (header), e.altKey);
        break;
      }

      case 'change-status':
        vscode.postMessage({ type: 'updateStatus', id: btn.getAttribute('data-id'), status: btn.getAttribute('data-status') });
        break;

      case 'delete-comment':
        vscode.postMessage({ type: 'deleteComment', id: btn.getAttribute('data-id') });
        break;

      case 'open-source':
        vscode.postMessage({
          type: 'openSource',
          file:       btn.getAttribute('data-file'),
          line:       Number(btn.getAttribute('data-line')),
          commitHash: btn.getAttribute('data-commit'),
        });
        break;

      case 'ask-question': {
        const id = btn.getAttribute('data-id') ?? '';
        showQuestionForm(id);
        break;
      }

      case 'submit-question': {
        const id = btn.getAttribute('data-id') ?? '';
        submitQuestion(id);
        break;
      }

      case 'cancel-question': {
        const id = btn.getAttribute('data-id') ?? '';
        hideQuestionForm(id);
        break;
      }

      case 'toggle-reply':
        toggleReplyForm(btn.getAttribute('data-id') ?? '');
        break;

      case 'submit-reply':
        submitReply(btn.getAttribute('data-id') ?? '');
        break;

      case 'cancel-reply':
        toggleReplyForm(btn.getAttribute('data-id') ?? '');
        break;

      case 'expand-down': {
        const row = btn.closest('.hunk-expander');
        if (!row) break;
        const gapNewStart = parseInt(row.getAttribute('data-gap-new-start') ?? '0');
        const gapNewEnd   = parseInt(row.getAttribute('data-gap-new-end')   ?? '0');
        const gapOldStart = parseInt(row.getAttribute('data-gap-old-start') ?? '0');
        const count = Math.min(10, gapNewEnd - gapNewStart + 1);
        if (count <= 0) break;
        vscode.postMessage({
          type: 'fetchContext',
          file:        row.getAttribute('data-file'),
          commitHash:  row.getAttribute('data-commit'),
          newStart:    gapNewStart,
          newEnd:      gapNewStart + count - 1,
          oldStart:    gapOldStart,
          direction:   'down',
          key:         row.getAttribute('data-key'),
        });
        break;
      }

      case 'expand-up': {
        const row = btn.closest('.hunk-expander');
        if (!row) break;
        const gapNewStart = parseInt(row.getAttribute('data-gap-new-start') ?? '0');
        const gapNewEnd   = parseInt(row.getAttribute('data-gap-new-end')   ?? '0');
        const gapOldEnd   = parseInt(row.getAttribute('data-gap-old-end')   ?? '0');
        const count = Math.min(10, gapNewEnd - gapNewStart + 1);
        if (count <= 0) break;
        vscode.postMessage({
          type: 'fetchContext',
          file:        row.getAttribute('data-file'),
          commitHash:  row.getAttribute('data-commit'),
          newStart:    gapNewEnd - count + 1,
          newEnd:      gapNewEnd,
          oldStart:    gapOldEnd - count + 1,
          direction:   'up',
          key:         row.getAttribute('data-key'),
        });
        break;
      }

      case 'expand-all': {
        const row = btn.closest('.hunk-expander');
        if (!row) break;
        const gapNewStart = parseInt(row.getAttribute('data-gap-new-start') ?? '0');
        const gapNewEnd   = parseInt(row.getAttribute('data-gap-new-end')   ?? '0');
        const gapOldStart = parseInt(row.getAttribute('data-gap-old-start') ?? '0');
        if (gapNewEnd < gapNewStart) break;
        vscode.postMessage({
          type: 'fetchContext',
          file:        row.getAttribute('data-file'),
          commitHash:  row.getAttribute('data-commit'),
          newStart:    gapNewStart,
          newEnd:      gapNewEnd,
          oldStart:    gapOldStart,
          direction:   'all',
          key:         row.getAttribute('data-key'),
        });
        break;
      }
    }
    return;
  }

  // ── Click on a diff line row → open composer for that line ──────────────
  const lineRow = /** @type {HTMLElement|null} */ (target.closest('tr[data-line]'));
  if (
    lineRow &&
    !lineRow.classList.contains('thread-row') &&
    !lineRow.classList.contains('inline-composer-row') &&
    !target.closest('.thread-container') &&
    !target.closest('.inline-composer')
  ) {
    const line = parseInt(lineRow.getAttribute('data-line') ?? '0', 10);
    const file = lineRow.getAttribute('data-file') ?? '';
    const commitHash = [...state.selectedHashes][0] ?? '';
    if (line && file && commitHash) {
      openComposer(commitHash, file, line, line, '', /** @type {HTMLTableRowElement} */ (lineRow));
      // Do NOT set composerJustOpened here — that flag is only for the mouseup→click
      // suppression path. Setting it here would swallow the very next outside-click.
    }
  }
});

// ── Selection → comment composer ───────────────────────────────────────────

document.addEventListener('mouseup', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;

  const selText = sel.toString().trim();
  if (!selText) return;

  // Only trigger if the selection is within a diff table
  const range = sel.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const el = /** @type {Element|null} */ (
    container.nodeType === Node.ELEMENT_NODE
      ? /** @type {Element} */ (container)
      : /** @type {Element} */ (container).parentElement
  );
  if (!el?.closest('.diff-table')) return;

  /** @param {Node|null} node @returns {HTMLTableRowElement|null} */
  const getRow = (node) => {
    if (!node) return null;
    const elem = node.nodeType === Node.TEXT_NODE
      ? /** @type {Element} */ (node).parentElement
      : /** @type {Element} */ (node);
    return /** @type {HTMLTableRowElement|null} */ (elem?.closest('tr[data-line]') ?? null);
  };

  const anchorRow = getRow(sel.anchorNode);
  const focusRow  = getRow(sel.focusNode);
  if (!anchorRow) return;

  const anchorLine = parseInt(anchorRow.getAttribute('data-line') ?? '0', 10);
  const focusLine  = focusRow ? parseInt(focusRow.getAttribute('data-line') ?? '0', 10) : anchorLine;
  const file = anchorRow.getAttribute('data-file') ?? '';
  if (!file || anchorLine === 0) return;

  const startLine = Math.min(anchorLine, focusLine || anchorLine);
  const endLine   = Math.max(anchorLine, focusLine || anchorLine);
  const commitHash = [...state.selectedHashes][0] ?? '';

  // Insert composer after the last row of the selection (in DOM order)
  const insertAfter = /** @type {HTMLTableRowElement} */ (
    focusRow && focusLine >= anchorLine ? focusRow : anchorRow
  );

  openComposer(commitHash, file, startLine, endLine, selText, insertAfter);
  composerJustOpened = true;
});

// ── Split-pane drag ────────────────────────────────────────────────────────

document.addEventListener('mousedown', (/** @type {MouseEvent} */ e) => {
  const target = /** @type {HTMLElement} */ (e.target);

  // Split-gutter drag
  if (target.closest('.split-gutter')) {
    splitDragging = true;
    splitDragStartX = e.clientX;
    // Capture the current pixel width of an old-column cell (1:1 drag mapping)
    const oldCell = /** @type {HTMLElement|null} */ (document.querySelector('.diff-table.split .line-content.old'));
    splitDragStartPx = oldCell ? oldCell.getBoundingClientRect().width : 300;
    document.body.classList.add('split-resizing');
    e.preventDefault();
    return;
  }

  // Expander drag (not on a button — buttons have their own click handlers)
  const expanderRow = /** @type {HTMLElement|null} */ (target.closest('.hunk-expander'));
  if (expanderRow && !target.closest('button')) {
    expanderDragging  = true;
    expanderDragRow   = expanderRow;
    expanderDragLastY = e.clientY;
    expanderDragAccum = 0;
    document.body.classList.add('expander-resizing');
    e.preventDefault();
  }
});

document.addEventListener('mousemove', (/** @type {MouseEvent} */ e) => {
  if (splitDragging) {
    const newPx = Math.max(80, splitDragStartPx + (e.clientX - splitDragStartX));
    document.documentElement.style.setProperty('--split-old-w', newPx + 'px');
  }

  if (expanderDragging && expanderDragRow) {
    const dy = e.clientY - expanderDragLastY;
    expanderDragAccum += dy;
    expanderDragLastY = e.clientY;

    const steps = Math.trunc(expanderDragAccum / EXPANDER_PX_PER_LINE);
    if (steps === 0 || expanderFetchPending) return;

    expanderDragAccum -= steps * EXPANDER_PX_PER_LINE;

    const gapNewStart = parseInt(expanderDragRow.getAttribute('data-gap-new-start') ?? '0');
    const gapNewEnd   = parseInt(expanderDragRow.getAttribute('data-gap-new-end')   ?? '0');
    const gapOldStart = parseInt(expanderDragRow.getAttribute('data-gap-old-start') ?? '0');
    const gapOldEnd   = parseInt(expanderDragRow.getAttribute('data-gap-old-end')   ?? '0');
    const remaining   = gapNewEnd - gapNewStart + 1;
    if (remaining <= 0) return;

    const count = Math.min(Math.abs(steps) * 10, remaining);

    if (steps < 0) {
      // Dragged up → reveal at bottom of gap (before next hunk)
      vscode.postMessage({
        type: 'fetchContext',
        file:       expanderDragRow.getAttribute('data-file'),
        commitHash: expanderDragRow.getAttribute('data-commit'),
        newStart:   gapNewEnd - count + 1,
        newEnd:     gapNewEnd,
        oldStart:   gapOldEnd - count + 1,
        direction:  'up',
        key:        expanderDragRow.getAttribute('data-key'),
      });
    } else {
      // Dragged down → reveal at top of gap (after prev hunk)
      vscode.postMessage({
        type: 'fetchContext',
        file:       expanderDragRow.getAttribute('data-file'),
        commitHash: expanderDragRow.getAttribute('data-commit'),
        newStart:   gapNewStart,
        newEnd:     gapNewStart + count - 1,
        oldStart:   gapOldStart,
        direction:  'down',
        key:        expanderDragRow.getAttribute('data-key'),
      });
    }
    expanderFetchPending = true;
  }
});

document.addEventListener('mouseup', () => {
  if (splitDragging) {
    splitDragging = false;
    document.body.classList.remove('split-resizing');
  }
  if (expanderDragging) {
    expanderDragging = false;
    expanderDragRow  = null;
    document.body.classList.remove('expander-resizing');
  }
});

// ── Top bar ────────────────────────────────────────────────────────────────

function renderTopBar() {
  const selectedComments = state.comments.filter(c => state.selectedHashes.has(c.commitHash));
  const open      = selectedComments.filter(c => c.status === 'open').length;
  const question  = selectedComments.filter(c => c.status === 'question' || c.status === 'agent-replied').length;
  const addressed = selectedComments.filter(c => c.status === 'addressed').length;

  setEl('badge-open',      `${open} open`);
  setEl('badge-question',  `${question} questions`);
  setEl('badge-addressed', `${addressed} addressed`);

  const n = state.selectedHashes.size;
  setEl('selected-count', `${n} commit${n !== 1 ? 's' : ''} selected`);

  const allReviewed = n > 0 && [...state.selectedHashes].every(h => state.reviewedCommits.has(h));
  const btn = document.getElementById('mark-reviewed-btn');
  if (btn) {
    btn.textContent = allReviewed ? '\u2713 Reviewed' : 'Mark as reviewed';
    btn.classList.toggle('reviewed', allReviewed);
  }

  updateRepoButton();
}

/** Show/hide and label the repo-selector button based on current state. */
function updateRepoButton() {
  const repoBtn = /** @type {HTMLElement|null} */ (document.getElementById('repo-select-btn'));
  if (!repoBtn) return;
  if (state.repoCount > 1) {
    repoBtn.style.display = '';
    repoBtn.textContent = state.repoName || 'Select Repo';
  } else {
    repoBtn.style.display = 'none';
  }
}

// ── Diff rendering ─────────────────────────────────────────────────────────

function renderDiff() {
  const main = document.getElementById('main');
  if (!main) return;

  if (state.selectedHashes.size === 0) {
    main.innerHTML = '<div class="empty-state"><h2>Commit Review</h2><p>Select a commit in the sidebar to begin reviewing.</p></div>';
    return;
  }
  if (state.currentDiff.length === 0) {
    main.innerHTML = '<div class="empty-state"><h2>No diff available</h2><p>This selection has no changed files.</p></div>';
    return;
  }

  const fileStatus = new Map(
    (state.currentChangedFiles ?? []).map(/** @param {any} f */ f => [f.path, f.status])
  );

  const n = state.selectedHashes.size;
  const rangeLabel = n === 1
    ? `Commit ${state.currentNewestShort}`
    : `${state.currentOldestShort} \u2192 ${state.currentNewestShort} (${n} commits)`;

  const relevantComments = state.comments.filter(c => state.selectedHashes.has(c.commitHash));
  const fileBlocks = state.currentDiff.map(
    fd => renderFileBlock(fd, relevantComments, fileStatus)
  ).join('');

  main.innerHTML = `
<div class="range-header">
  <span class="range-label">${esc(rangeLabel)}</span>
  <span class="range-file-count">${state.currentDiff.length} file${state.currentDiff.length !== 1 ? 's' : ''} changed</span>
</div>
${fileBlocks}`;
}

/**
 * @param {{ file: string, hunks: any[] }} fileDiff
 * @param {any[]} comments
 * @param {Map<string, string>} fileStatus
 */
function renderFileBlock(fileDiff, comments, fileStatus) {
  const fileComments = comments.filter(c => c.file === fileDiff.file);
  const status = fileStatus.get(fileDiff.file) ?? 'M';
  const openCount = fileComments.filter(
    c => c.status === 'open' || c.status === 'question' || c.status === 'agent-replied'
  ).length;

  // Use the first selected hash as the commit for new comments
  const newestHash = [...state.selectedHashes][0] ?? '';
  const hunks = fileDiff.hunks;

  let rows = '';
  for (let i = 0; i < hunks.length; i++) {
    rows += renderHunkSplit(hunks[i], fileDiff.file, fileComments, newestHash);

    // Between adjacent hunks — render a collapsible gap row if lines are hidden
    if (i < hunks.length - 1) {
      rows += renderExpanderRow(fileDiff.file, newestHash, hunks[i], hunks[i + 1]);
    }
  }

  return `
<div class="file-block" data-file="${esc(fileDiff.file)}">
  <div class="file-header" data-action="toggle-file">
    <span class="chevron">\u25be</span>
    <span class="file-name">${esc(fileDiff.file)}</span>
    <span class="file-status ${esc(status)}">${esc(status)}</span>
    ${openCount > 0 ? `<span class="badge open">${openCount} comment${openCount !== 1 ? 's' : ''}</span>` : ''}
  </div>
  <div class="file-body">
    <table class="diff-table split"><colgroup><col class="split-col-num"><col class="split-col-old"><col class="split-col-gutter"><col class="split-col-num"><col></colgroup><tbody>${rows}</tbody></table>
  </div>
</div>`;
}

// ── Hunk gap / expander ────────────────────────────────────────────────────

/**
 * Parse a hunk header like "@@ -10,7 +10,7 @@" into its numeric parts.
 * @param {string} header
 * @returns {{ oldStart:number, oldCount:number, newStart:number, newCount:number }|null}
 */
function parseHunkHeader(header) {
  const m = header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return null;
  return {
    oldStart: parseInt(m[1]),
    oldCount: m[2] !== undefined ? parseInt(m[2]) : 1,
    newStart: parseInt(m[3]),
    newCount: m[4] !== undefined ? parseInt(m[4]) : 1,
  };
}

/**
 * Between two adjacent hunks, render an expandable "N hidden lines" row.
 * @param {string} file
 * @param {string} commitHash
 * @param {any} prevHunk
 * @param {any} nextHunk
 */
function renderExpanderRow(file, commitHash, prevHunk, nextHunk) {
  const prev = parseHunkHeader(prevHunk.header);
  const next = parseHunkHeader(nextHunk.header);
  if (!prev || !next) return '';

  const gapNewStart = prev.newStart + prev.newCount;   // first hidden new-file line
  const gapNewEnd   = next.newStart - 1;               // last hidden new-file line
  const gapOldStart = prev.oldStart + prev.oldCount;
  const gapOldEnd   = next.oldStart - 1;

  if (gapNewEnd < gapNewStart) return '';              // nothing hidden

  const hidden   = gapNewEnd - gapNewStart + 1;
  const colCount = 5;
  const key      = `${file}:${gapNewStart}:${gapNewEnd}`;

  return `
<tr class="hunk-expander"
    data-file="${esc(file)}"
    data-commit="${esc(commitHash)}"
    data-gap-new-start="${gapNewStart}"
    data-gap-new-end="${gapNewEnd}"
    data-gap-old-start="${gapOldStart}"
    data-gap-old-end="${gapOldEnd}"
    data-key="${esc(key)}">
  <td colspan="${colCount}" class="expander-td">
    <div class="expander-inner">
      <button class="expand-btn" data-action="expand-down" title="Show 10 lines below prev hunk">&#9660;</button>
      <span class="expander-label" data-action="expand-all">${hidden} hidden line${hidden !== 1 ? 's' : ''}</span>
      <button class="expand-btn" data-action="expand-up" title="Show 10 lines above next hunk">&#9650;</button>
    </div>
  </td>
</tr>`;
}

/**
 * Insert fetched context lines into the DOM adjacent to their expander row.
 * @param {string} key
 * @param {string} direction  'up' | 'down' | 'all'
 * @param {Array<{oldLineNum:number, newLineNum:number, content:string}>} lines
 */
function insertContextLines(key, direction, lines) {
  expanderFetchPending = false;
  if (!lines.length) return;

  const expander = /** @type {HTMLElement|null} */ (
    document.querySelector(`.hunk-expander[data-key="${CSS.escape(key)}"]`)
  );
  if (!expander) return;

  const isSplit = !!expander.closest('.diff-table.split');
  const file    = expander.getAttribute('data-file') ?? '';

  const rowsHtml = lines.map(/** @param {any} l */ l => {
    if (isSplit) {
      return `<tr data-line="${l.newLineNum}" data-file="${esc(file)}">
  <td class="line-num old">${l.oldLineNum}</td>
  <td class="line-content old">${escCode(l.content)}</td>
  <td class="split-gutter"></td>
  <td class="line-num new">${l.newLineNum}</td>
  <td class="line-content new">${escCode(l.content)}</td>
</tr>`;
    }
    return `<tr data-line="${l.newLineNum}" data-file="${esc(file)}">
  <td class="line-num old">${l.oldLineNum}</td>
  <td class="line-num new">${l.newLineNum}</td>
  <td class="line-content"> ${escCode(l.content)}</td>
</tr>`;
  }).join('');

  const tmpl = document.createElement('template');
  tmpl.innerHTML = rowsHtml;

  if (direction === 'up') {
    expander.after(tmpl.content);
    const newEnd = parseInt(expander.getAttribute('data-gap-new-end') ?? '0') - lines.length;
    const newOldEnd = parseInt(expander.getAttribute('data-gap-old-end') ?? '0') - lines.length;
    expander.setAttribute('data-gap-new-end', String(newEnd));
    expander.setAttribute('data-gap-old-end', String(newOldEnd));
  } else {
    // 'down' or 'all' — insert before expander (right after prev hunk)
    expander.before(tmpl.content);
    if (direction !== 'all') {
      const newStart = parseInt(expander.getAttribute('data-gap-new-start') ?? '0') + lines.length;
      const newOldStart = parseInt(expander.getAttribute('data-gap-old-start') ?? '0') + lines.length;
      expander.setAttribute('data-gap-new-start', String(newStart));
      expander.setAttribute('data-gap-old-start', String(newOldStart));
    }
  }

  if (direction === 'all') {
    expander.remove();
    return;
  }

  const gapNewStart = parseInt(expander.getAttribute('data-gap-new-start') ?? '0');
  const gapNewEnd   = parseInt(expander.getAttribute('data-gap-new-end')   ?? '0');
  const remaining   = gapNewEnd - gapNewStart + 1;

  if (remaining <= 0) {
    expander.remove();
  } else {
    const label = expander.querySelector('.expander-label');
    if (label) label.textContent = `${remaining} hidden line${remaining !== 1 ? 's' : ''}`;
  }
}

/**
 * @param {any} hunk
 * @param {string} file
 * @param {any[]} comments
 * @param {string} commitHash
 */
function renderHunk(hunk, file, comments, commitHash) {
  const headerRow = `<tr class="hunk-header"><td colspan="3">${esc(hunk.header)}</td></tr>`;

  const lineRows = hunk.lines.map(/** @param {any} line */ line => {
    const lineNum = line.newLineNum ?? line.oldLineNum ?? 0;
    const cls     = line.type === 'add' ? 'add-line' : line.type === 'delete' ? 'del-line' : '';
    const prefix  = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';

    const lineComments = comments.filter(
      c => c.line === line.newLineNum || c.line === line.oldLineNum
    );
    const commentRows = lineComments.map(c => renderThreadRow(c, 3)).join('');

    return `
<tr class="${cls}" data-line="${lineNum}" data-file="${esc(file)}">
  <td class="line-num old">${line.oldLineNum ?? ''}</td>
  <td class="line-num new">${line.newLineNum ?? ''}</td>
  <td class="line-content">${prefix}${escCode(line.content)}</td>
</tr>${commentRows}`;
  }).join('');

  return headerRow + lineRows;
}

/**
 * @param {any} hunk
 * @param {string} file
 * @param {any[]} comments
 * @param {string} commitHash
 */
function renderHunkSplit(hunk, file, comments, commitHash) {
  const headerRow = `<tr class="hunk-header"><td colspan="5">${esc(hunk.header)}</td></tr>`;

  const pairs = buildSideBySidePairs(hunk.lines);

  const lineRows = pairs.map(/** @param {any} pair */ pair => {
    const { left, right, type } = pair;

    const trClass = type === 'del' ? 'split-del' : type === 'add' ? 'split-add' : '';

    const leftLineNum   = left  ? (left.oldLineNum  ?? '') : '';
    const rightLineNum  = right ? (right.newLineNum ?? '') : '';
    const leftContent   = left  ? escCode(left.content)  : '';
    const rightContent  = right ? escCode(right.content) : '';

    // Thread comments matched from either side
    const lineNum = right ? (right.newLineNum ?? right.oldLineNum ?? 0) : (left ? (left.oldLineNum ?? 0) : 0);
    const lineComments = comments.filter(
      c => c.line === (right?.newLineNum) || c.line === (left?.oldLineNum)
    );
    const commentRows = lineComments.map(c => renderThreadRow(c, 5)).join('');

    return `
<tr class="${trClass}" data-line="${lineNum}" data-file="${esc(file)}">
  <td class="line-num old">${leftLineNum}</td>
  <td class="line-content old">${leftContent}</td>
  <td class="split-gutter" rowspan="1"></td>
  <td class="line-num new">${rightLineNum}</td>
  <td class="line-content new">${rightContent}</td>
</tr>${commentRows}`;
  }).join('');

  return headerRow + lineRows;
}

/**
 * Pair up deleted and added lines for side-by-side display.
 * @param {any[]} lines
 * @returns {Array<{left: any|null, right: any|null, type: string}>}
 */
function buildSideBySidePairs(lines) {
  const pairs = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === 'context') {
      pairs.push({ left: line, right: line, type: 'context' });
      i++;
    } else if (line.type === 'delete') {
      // Collect consecutive deletes and adds and pair them
      const dels = [];
      while (i < lines.length && lines[i].type === 'delete') {
        dels.push(lines[i++]);
      }
      const adds = [];
      while (i < lines.length && lines[i].type === 'add') {
        adds.push(lines[i++]);
      }
      const maxLen = Math.max(dels.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        const left  = dels[j] ?? null;
        const right = adds[j] ?? null;
        const type  = left && right ? 'del' : left ? 'del' : 'add';
        pairs.push({ left, right, type });
      }
    } else if (line.type === 'add') {
      pairs.push({ left: null, right: line, type: 'add' });
      i++;
    } else {
      i++;
    }
  }
  return pairs;
}

/**
 * @param {any} comment
 * @param {number} [colspan]
 */
function renderThreadRow(comment, colspan) {
  const tdColspan = colspan ?? 4;
  const replies = (comment.thread ?? []).map(/** @param {any} r */ r => `
<div class="thread-comment ${r.author !== 'reviewer' ? 'agent-comment' : ''}">
  <div class="thread-header">
    <span class="thread-author ${r.author !== 'reviewer' ? 'agent' : ''}">${esc(r.author === 'reviewer' ? state.gitUserName : r.author)}</span>
    <span class="thread-date">${formatDate(r.createdAt)}</span>
  </div>
  <div class="thread-body">${esc(r.body)}</div>
</div>`).join('');

  // Status transition buttons — show all statuses except the current one
  let actionButtons = STATUS_OPTIONS
    .filter(o => o.status !== comment.status)
    .map(o => `<button class="btn status-action-btn" title="${o.label}" data-action="change-status" data-status="${o.status}" data-id="${comment.id}" style="color:var(${o.cssVar})"><i class="codicon codicon-${o.icon}"></i></button>`)
    .join('');
  if (comment.status === 'open') {
    actionButtons += `<button class="btn" data-action="ask-question" data-id="${comment.id}">Ask Question</button>`;
  }
  // Open source file at comment line
  actionButtons += `<button class="btn" title="Go to source file" data-action="open-source" data-file="${esc(comment.file)}" data-line="${comment.line}" data-commit="${esc(comment.commitHash)}"><i class="codicon codicon-${ICONS.ARROW_RIGHT}"></i></button>`;
  // Delete pushed to the far right
  actionButtons += `<span class="thread-actions-spacer"></span><button class="btn danger" data-action="delete-comment" data-id="${comment.id}"><i class="codicon codicon-${ICONS.TRASH}"></i></button>`;

  const statusIndicator = comment.status === 'question'
    ? `<span class="thread-status question">awaiting agent</span>`
    : `<span class="thread-status ${comment.status}">${esc(comment.status)}</span>`;

  return `
<tr class="thread-row" data-comment-id="${comment.id}">
  <td colspan="${tdColspan}">
    <div class="thread-container status-${comment.status}">
      <div class="thread-comment">
        <div class="thread-header">
          <span class="thread-author">${esc(comment.author === 'reviewer' ? state.gitUserName : comment.author)}</span>
          <span class="thread-date">${formatDate(comment.createdAt)}</span>
          ${statusIndicator}
        </div>
        ${comment.codeSnippet ? `<div class="code-snippet">${escCode(comment.codeSnippet)}</div>` : ''}
        <div class="thread-body" style="margin-top:6px">${esc(comment.body)}</div>
        <div class="thread-actions">${actionButtons}</div>
        <div id="question-form-${comment.id}" class="thread-question-form" style="display:none">
          <textarea placeholder="Ask the agent a question about this comment\u2026" id="question-text-${comment.id}"></textarea>
          <div class="thread-question-actions">
            <button class="btn" data-action="cancel-question" data-id="${comment.id}">Cancel</button>
            <button class="btn primary" data-action="submit-question" data-id="${comment.id}">Ask</button>
          </div>
        </div>
        <div id="reply-form-${comment.id}" class="thread-reply-form" style="display:none">
          <textarea placeholder="Add a reply\u2026" id="reply-text-${comment.id}"></textarea>
          <div class="thread-reply-actions">
            <button class="btn" data-action="cancel-reply" data-id="${comment.id}">Cancel</button>
            <button class="btn primary" data-action="submit-reply" data-id="${comment.id}">Reply</button>
          </div>
        </div>
      </div>
      ${replies}
    </div>
  </td>
</tr>`;
}

// ── Actions ────────────────────────────────────────────────────────────────

/** @param {string} id */
function showQuestionForm(id) {
  const form = document.getElementById(`question-form-${id}`);
  if (!form) return;
  form.style.display = 'flex';
  const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById(`question-text-${id}`));
  ta?.focus();
}

/** @param {string} id */
function hideQuestionForm(id) {
  const form = document.getElementById(`question-form-${id}`);
  if (form) form.style.display = 'none';
}

/** @param {string} id */
function submitQuestion(id) {
  const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById(`question-text-${id}`));
  const question = ta?.value?.trim();
  if (!question) return;
  vscode.postMessage({ type: 'askQuestion', id, question });
  hideQuestionForm(id);
}

/**
 * Insert an inline comment composer row after a diff row.
 * @param {string} commitHash
 * @param {string} file
 * @param {number} startLine
 * @param {number} endLine
 * @param {string} snippet   — highlighted text (may be empty)
 * @param {HTMLTableRowElement|null} anchorRow
 */
function openComposer(commitHash, file, startLine, endLine, snippet, anchorRow) {
  closeComposer();

  pendingCommentCommitHash = commitHash;
  pendingCommentFile       = file;
  pendingCommentLine       = startLine;
  pendingCommentLineEnd    = endLine;
  pendingCommentSnippet    = snippet;
  submittingComment        = false;

  const colCount = 5;
  const lineLabel = endLine > startLine ? `${startLine}–${endLine}` : `${startLine}`;
  const snippetHtml = snippet
    ? `<pre class="inline-composer-snippet">${esc(snippet.length > 400 ? snippet.slice(0, 400) + '\u2026' : snippet)}</pre>`
    : '';

  const tr = document.createElement('tr');
  tr.className = 'inline-composer-row';
  tr.innerHTML = `
<td colspan="${colCount}">
  <div class="inline-composer">
    <div class="inline-composer-header">${esc(file)} line ${esc(lineLabel)}</div>
    ${snippetHtml}
    <textarea class="inline-composer-ta" placeholder="Leave a comment\u2026" rows="3"></textarea>
    <div class="inline-composer-actions">
      <button class="btn" data-action="close-composer">Cancel</button>
      <button class="btn primary" data-action="submit-comment">Comment</button>
    </div>
  </div>
</td>`;

  if (anchorRow && anchorRow.parentNode) {
    anchorRow.after(tr);
  } else {
    const tbody = document.querySelector('.diff-table tbody');
    tbody?.appendChild(tr);
  }

  composerRow = tr;
  const ta = /** @type {HTMLTextAreaElement} */ (tr.querySelector('textarea'));
  ta?.focus();
}

function closeComposer() {
  composerRow?.remove();
  composerRow = null;
  submittingComment = false;
}

function submitComment() {
  if (submittingComment) return;
  const ta = /** @type {HTMLTextAreaElement|null} */ (composerRow?.querySelector('textarea'));
  const body = ta?.value?.trim();
  if (!body) return;
  submittingComment = true;
  vscode.postMessage({
    type: 'addComment',
    commitHash: pendingCommentCommitHash,
    file:        pendingCommentFile,
    line:        pendingCommentLine,
    lineEnd:     pendingCommentLineEnd,
    snippet:     pendingCommentSnippet,
    body,
  });
  closeComposer();
}

/** @param {string} id */
function toggleReplyForm(id) {
  const form = document.getElementById(`reply-form-${id}`);
  if (!form) return;
  const visible = form.style.display !== 'none';
  form.style.display = visible ? 'none' : 'flex';
  if (!visible) {
    const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById(`reply-text-${id}`));
    ta?.focus();
  }
}

/** @param {string} id */
function submitReply(id) {
  const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById(`reply-text-${id}`));
  const body = ta?.value?.trim();
  if (!body) return;
  vscode.postMessage({ type: 'addReply', id, body });
}

function toggleMarkReviewed() {
  const allReviewed = [...state.selectedHashes].every(h => state.reviewedCommits.has(h));
  for (const h of state.selectedHashes) {
    if (allReviewed) state.reviewedCommits.delete(h);
    else             state.reviewedCommits.add(h);
  }
  renderTopBar();
}

/**
 * @param {HTMLElement} header
 * @param {boolean} [allFiles]  true when Alt/Option held — collapse/expand every file
 */
function toggleFile(header, allFiles = false) {
  if (allFiles) {
    const willCollapse = !header.classList.contains('collapsed');
    document.querySelectorAll('.file-header').forEach(h => {
      const hEl = /** @type {HTMLElement} */ (h);
      hEl.classList.toggle('collapsed', willCollapse);
      const body = hEl.nextElementSibling;
      if (body) /** @type {HTMLElement} */ (body).classList.toggle('collapsed', willCollapse);
    });
  } else {
    header.classList.toggle('collapsed');
    const body = header.nextElementSibling;
    if (body) body.classList.toggle('collapsed');
  }
}

/** @param {string} file */
function scrollToFile(file) {
  const block = /** @type {HTMLElement|null} */ (
    document.querySelector(`.file-block[data-file="${CSS.escape(file)}"]`)
  );
  block?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Scroll to a comment thread row and briefly highlight it. @param {string} id */
function scrollToComment(id) {
  const row = /** @type {HTMLElement|null} */ (
    document.querySelector(`tr.thread-row[data-comment-id="${CSS.escape(id)}"]`)
  );
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('comment-highlight');
  setTimeout(() => row.classList.remove('comment-highlight'), 1800);
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** @param {string} s */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** @param {string} s */
function escCode(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {string} id @param {string} text */
function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/** @param {string} iso */
function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}
