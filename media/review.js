// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

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
  /** 'inline' | 'split' */
  diffMode: 'inline',
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

// ── Message handler ────────────────────────────────────────────────────────

window.addEventListener('message', (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'load':
      // Refresh comments + selected set (sent after any comment mutation)
      state.comments       = msg.comments       ?? [];
      state.selectedHashes = new Set(msg.selectedHashes ?? []);
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
      renderTopBar();
      renderDiff();
      break;
    case 'focusFile':
      if (msg.file) scrollToFile(/** @type {string} */ (msg.file));
      break;
  }
});

// ── Event delegation ───────────────────────────────────────────────────────

document.addEventListener('click', (/** @type {MouseEvent} */ e) => {
  const target = /** @type {HTMLElement} */ (e.target);

  // Close inline composer when clicking outside it
  if (composerRow && !composerRow.contains(target)) {
    if (composerJustOpened) {
      composerJustOpened = false; // opened by mouseup — ignore this click
    } else {
      closeComposer();
      const actionEl = target.closest('[data-action]');
      if (!actionEl) return;
    }
  }

  const btn = /** @type {HTMLElement|null} */ (target.closest('[data-action]'));
  if (!btn) return;
  const action = btn.getAttribute('data-action') ?? '';

  switch (action) {
    case 'toggle-diff-mode':
      state.diffMode = state.diffMode === 'inline' ? 'split' : 'inline';
      updateDiffModeBtn();
      renderDiff();
      break;

    case 'toggle-reviewed':
      toggleMarkReviewed();
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
      if (header) toggleFile(/** @type {HTMLElement} */ (header));
      break;
    }

    case 'mark-addressed':
      vscode.postMessage({ type: 'updateStatus', id: btn.getAttribute('data-id'), status: 'addressed' });
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

  updateDiffModeBtn();
}

function updateDiffModeBtn() {
  const btn = document.getElementById('diff-mode-btn');
  if (!btn) return;
  if (state.diffMode === 'split') {
    btn.textContent = 'Inline';
    btn.classList.add('active');
  } else {
    btn.textContent = 'Split';
    btn.classList.remove('active');
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

  let rows;
  if (state.diffMode === 'split') {
    rows = fileDiff.hunks.map(
      /** @param {any} hunk */ hunk => renderHunkSplit(hunk, fileDiff.file, fileComments, newestHash)
    ).join('');
  } else {
    rows = fileDiff.hunks.map(
      /** @param {any} hunk */ hunk => renderHunk(hunk, fileDiff.file, fileComments, newestHash)
    ).join('');
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
    <table class="diff-table${state.diffMode === 'split' ? ' split' : ''}"><tbody>${rows}</tbody></table>
  </div>
</div>`;
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
  const headerRow = `<tr class="hunk-header"><td colspan="4">${esc(hunk.header)}</td></tr>`;

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
    const commentRows = lineComments.map(c => renderThreadRow(c, 4)).join('');

    return `
<tr class="${trClass}" data-line="${lineNum}" data-file="${esc(file)}">
  <td class="line-num old">${leftLineNum}</td>
  <td class="line-content old">${leftContent}</td>
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
    <span class="thread-author ${r.author !== 'reviewer' ? 'agent' : ''}">${esc(r.author)}</span>
    <span class="thread-date">${formatDate(r.createdAt)}</span>
  </div>
  <div class="thread-body">${esc(r.body)}</div>
</div>`).join('');

  // Determine available actions based on status
  let actionButtons = '';
  if (comment.status !== 'addressed') {
    actionButtons += `<button class="btn success" data-action="mark-addressed" data-id="${comment.id}">Mark Addressed</button>`;
  }
  if (comment.status === 'open') {
    actionButtons += `<button class="btn" data-action="ask-question" data-id="${comment.id}">Ask Question</button>`;
  }
  if (comment.status === 'question') {
    // Awaiting agent response — no action buttons beyond what's shown
  }

  const statusIndicator = comment.status === 'question'
    ? `<span class="thread-status question">awaiting agent</span>`
    : `<span class="thread-status ${comment.status}">${esc(comment.status)}</span>`;

  return `
<tr class="thread-row" data-comment-id="${comment.id}">
  <td colspan="${tdColspan}">
    <div class="thread-container">
      <div class="thread-comment">
        <div class="thread-header">
          <span class="thread-author">${esc(comment.author)}</span>
          <span class="thread-date">${formatDate(comment.createdAt)}</span>
          ${statusIndicator}
        </div>
        ${comment.codeSnippet ? `<div class="code-snippet">${escCode(comment.codeSnippet)}</div>` : ''}
        <div class="thread-body" style="margin-top:6px">${esc(comment.body)}</div>
        ${actionButtons ? `<div class="thread-actions">${actionButtons}</div>` : ''}
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

  const colCount = state.diffMode === 'split' ? 4 : 3;
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

/** @param {HTMLElement} header */
function toggleFile(header) {
  header.classList.toggle('collapsed');
  const body = header.nextElementSibling;
  if (body) body.classList.toggle('collapsed');
}

/** @param {string} file */
function scrollToFile(file) {
  const block = /** @type {HTMLElement|null} */ (
    document.querySelector(`.file-block[data-file="${CSS.escape(file)}"]`)
  );
  block?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
