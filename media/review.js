// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  /** @type {any[]} */
  comments: [],
  /** @type {Set<string>} selected hashes — received from extension */
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
};

let pendingCommentFile = '';
let pendingCommentLine = 0;
let pendingCommentCommitHash = '';

// ── Message handler ────────────────────────────────────────────────────────

window.addEventListener('message', (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'load':
      // Refresh comments + selected set (sent after any comment mutation)
      state.comments       = msg.comments       ?? [];
      state.selectedHashes = new Set(msg.selectedHashes ?? []);
      renderTopBar();
      renderDiff();   // re-render threads inline
      break;
    case 'diffResult':
      state.currentDiff        = msg.parsedDiff    ?? [];
      state.currentChangedFiles = msg.changedFiles  ?? [];
      state.currentOldestShort = msg.oldestShort   ?? '';
      state.currentNewestShort = msg.newestShort   ?? '';
      state.selectedHashes     = new Set(msg.selectedHashes ?? []);
      state.comments           = msg.comments      ?? state.comments;
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

  // Close composer on outside click
  const composer = document.getElementById('comment-composer');
  if (composer && composer.style.display === 'block' && !composer.contains(target)) {
    const actionEl = target.closest('[data-action]');
    if (!actionEl || actionEl.getAttribute('data-action') !== 'add-comment') {
      composer.style.display = 'none';
      return;
    }
  }

  const btn = /** @type {HTMLElement|null} */ (target.closest('[data-action]'));
  if (!btn) return;
  const action = btn.getAttribute('data-action') ?? '';

  switch (action) {
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
    case 'add-comment': {
      const commitHash = btn.getAttribute('data-commit') ?? '';
      const file       = btn.getAttribute('data-file')   ?? '';
      const line       = parseInt(btn.getAttribute('data-line') ?? '0', 10);
      openComposer(commitHash, file, line, e);
      break;
    }
    case 'toggle-file': {
      const header = btn.closest('.file-header');
      if (header) toggleFile(/** @type {HTMLElement} */ (header));
      break;
    }
    case 'mark-addressed':
      vscode.postMessage({ type: 'updateStatus', id: btn.getAttribute('data-id'), status: 'addressed' });
      break;
    case 'resolve-thread':
      vscode.postMessage({ type: 'updateStatus', id: btn.getAttribute('data-id'), status: 'resolved' });
      break;
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

// ── Top bar ────────────────────────────────────────────────────────────────

function renderTopBar() {
  const selectedComments = state.comments.filter(c => state.selectedHashes.has(c.commitHash));
  const open     = selectedComments.filter(c => c.status === 'open').length;
  const replied  = selectedComments.filter(c => c.status === 'agent-replied').length;
  const addressed = selectedComments.filter(
    c => c.status === 'addressed' || c.status === 'resolved'
  ).length;

  setEl('badge-open',      `${open} open`);
  setEl('badge-replied',   `${replied} in review`);
  setEl('badge-addressed', `${addressed} addressed`);

  const n = state.selectedHashes.size;
  setEl('selected-count', `${n} commit${n !== 1 ? 's' : ''} selected`);

  const allReviewed = n > 0 && [...state.selectedHashes].every(h => state.reviewedCommits.has(h));
  const btn = document.getElementById('mark-reviewed-btn');
  if (btn) {
    btn.textContent = allReviewed ? '\u2713 Reviewed' : 'Mark as reviewed';
    btn.classList.toggle('reviewed', allReviewed);
  }
}

// ── Diff rendering ─────────────────────────────────────────────────────────

function renderDiff() {
  const main = document.getElementById('main');
  if (!main) return;

  if (state.selectedHashes.size === 0) {
    main.innerHTML = '<div class="empty-state"><h2>No commits selected</h2><p>Select commits in the graph to review their diffs.</p></div>';
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
    c => c.status === 'open' || c.status === 'agent-replied'
  ).length;

  // Use the newest selected commit hash for new comments
  const newestHash = [...state.selectedHashes].reduce((best, h) => {
    const idxBest = state.currentDiff.findIndex ? -1 : 0; // fallback
    const iBest = [...state.selectedHashes].indexOf(best);
    const iH    = [...state.selectedHashes].indexOf(h);
    return iH < iBest ? h : best;
  }, [...state.selectedHashes][0] ?? '');

  const rows = fileDiff.hunks.map(
    /** @param {any} hunk */ hunk => renderHunk(hunk, fileDiff.file, fileComments, newestHash)
  ).join('');

  return `
<div class="file-block" data-file="${esc(fileDiff.file)}">
  <div class="file-header" data-action="toggle-file">
    <span class="chevron">\u25be</span>
    <span class="file-name">${esc(fileDiff.file)}</span>
    <span class="file-status ${esc(status)}">${esc(status)}</span>
    ${openCount > 0 ? `<span class="badge open">${openCount} comment${openCount !== 1 ? 's' : ''}</span>` : ''}
  </div>
  <div class="file-body">
    <table class="diff-table"><tbody>${rows}</tbody></table>
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
  const headerRow = `<tr class="hunk-header"><td colspan="4">${esc(hunk.header)}</td></tr>`;

  const lineRows = hunk.lines.map(/** @param {any} line */ line => {
    const lineNum = line.newLineNum ?? line.oldLineNum ?? 0;
    const cls     = line.type === 'add' ? 'add-line' : line.type === 'delete' ? 'del-line' : '';
    const prefix  = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';

    const lineComments = comments.filter(
      c => c.line === line.newLineNum || c.line === line.oldLineNum
    );
    const commentRows = lineComments.map(c => renderThreadRow(c)).join('');

    const addBtn = line.type !== 'delete'
      ? `<button class="line-add-btn" title="Add comment" data-action="add-comment"
           data-commit="${esc(commitHash)}" data-file="${esc(file)}" data-line="${lineNum}">+</button>`
      : '';

    return `
<tr class="${cls}" data-line="${lineNum}" data-file="${esc(file)}">
  <td class="line-num old">${line.oldLineNum ?? ''}</td>
  <td class="line-num new">${line.newLineNum ?? ''}</td>
  <td class="line-content">${prefix}${escCode(line.content)}</td>
  <td class="line-add-cell">${addBtn}</td>
</tr>${commentRows}`;
  }).join('');

  return headerRow + lineRows;
}

/** @param {any} comment */
function renderThreadRow(comment) {
  const replies = (comment.thread ?? []).map(/** @param {any} r */ r => `
<div class="thread-comment ${r.author !== 'reviewer' ? 'agent-comment' : ''}">
  <div class="thread-header">
    <span class="thread-author ${r.author !== 'reviewer' ? 'agent' : ''}">${esc(r.author)}</span>
    <span class="thread-date">${formatDate(r.createdAt)}</span>
  </div>
  <div class="thread-body">${esc(r.body)}</div>
</div>`).join('');

  return `
<tr class="thread-row" data-comment-id="${comment.id}">
  <td colspan="4">
    <div class="thread-container">
      <div class="thread-comment">
        <div class="thread-header">
          <span class="thread-author">${esc(comment.author)}</span>
          <span class="thread-date">${formatDate(comment.createdAt)}</span>
          <span class="thread-status ${comment.status}">${esc(comment.status)}</span>
        </div>
        ${comment.codeSnippet ? `<div class="code-snippet">${escCode(comment.codeSnippet)}</div>` : ''}
        <div class="thread-body" style="margin-top:6px">${esc(comment.body)}</div>
        <div class="thread-actions">
          ${comment.status !== 'addressed' && comment.status !== 'resolved'
            ? `<button class="btn success" data-action="mark-addressed" data-id="${comment.id}">Mark addressed</button>`
            : ''}
          ${comment.status !== 'resolved'
            ? `<button class="btn danger" data-action="resolve-thread" data-id="${comment.id}">Resolve</button>`
            : ''}
          <button class="btn" data-action="toggle-reply" data-id="${comment.id}">Reply</button>
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

/**
 * @param {string} commitHash
 * @param {string} file
 * @param {number} line
 * @param {MouseEvent} event
 */
function openComposer(commitHash, file, line, event) {
  pendingCommentCommitHash = commitHash;
  pendingCommentFile = file;
  pendingCommentLine = line;

  const composer = document.getElementById('comment-composer');
  if (!composer) return;
  const ta = /** @type {HTMLTextAreaElement} */ (composer.querySelector('textarea'));
  if (ta) ta.value = '';

  const h4 = composer.querySelector('h4');
  if (h4) h4.textContent = `Comment on ${file}:${line}`;

  composer.style.display = 'block';
  const x = Math.min(event.clientX, window.innerWidth - 440);
  const y = Math.min(event.clientY + 10, window.innerHeight - 200);
  composer.style.left = `${x}px`;
  composer.style.top  = `${y}px`;
  if (ta) ta.focus();
}

function closeComposer() {
  const c = document.getElementById('comment-composer');
  if (c) c.style.display = 'none';
}

function submitComment() {
  const ta = /** @type {HTMLTextAreaElement} */ (
    document.querySelector('#comment-composer textarea')
  );
  const body = ta?.value?.trim();
  if (!body) return;
  vscode.postMessage({
    type: 'addComment',
    commitHash: pendingCommentCommitHash,
    file: pendingCommentFile,
    line: pendingCommentLine,
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
