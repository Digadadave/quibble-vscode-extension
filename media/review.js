// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────

/** @type {{ commits: any[], comments: any[], selectedHash: string, reviewedCommits: Set<string> }} */
const state = {
  commits: [],
  comments: [],
  selectedHash: '',
  reviewedCommits: new Set(),
};

// Pending comment placement
let pendingCommentFile = '';
let pendingCommentLine = 0;
let pendingCommentCommitHash = '';

// ── VSCode message handler ────────────────────────────────────────────────

window.addEventListener('message', (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'load':
      state.commits = msg.commits ?? [];
      state.comments = msg.comments ?? [];
      state.selectedHash = msg.selectedHash ?? (state.commits[0]?.hash ?? '');
      renderAll();
      break;
    case 'focusFile':
      if (msg.file) scrollToFile(msg.file);
      break;
  }
});

// ── Event delegation ──────────────────────────────────────────────────────
// All click handling goes through this single listener (CSP-safe).

document.addEventListener('click', (/** @type {MouseEvent} */ e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  const btn = target.closest('[data-action]');
  if (!btn) {
    // Close composer on outside click
    const composer = document.getElementById('comment-composer');
    if (composer && composer.style.display === 'block' && !composer.contains(target)) {
      composer.style.display = 'none';
    }
    return;
  }

  const action = btn.getAttribute('data-action');
  e.stopPropagation();

  switch (action) {
    case 'navigate-prev':
      navigateCommit('prev');
      break;
    case 'navigate-next':
      navigateCommit('next');
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
    case 'add-comment': {
      const commitHash = btn.getAttribute('data-commit') ?? '';
      const file = btn.getAttribute('data-file') ?? '';
      const line = parseInt(btn.getAttribute('data-line') ?? '0', 10);
      openComposer(commitHash, file, line, e);
      break;
    }
    case 'toggle-file': {
      const header = btn.closest('.file-header');
      if (header) toggleFile(/** @type {HTMLElement} */ (header));
      break;
    }
    case 'mark-addressed': {
      const id = btn.getAttribute('data-id') ?? '';
      vscode.postMessage({ type: 'updateStatus', id, status: 'addressed' });
      break;
    }
    case 'resolve-thread': {
      const id = btn.getAttribute('data-id') ?? '';
      vscode.postMessage({ type: 'updateStatus', id, status: 'resolved' });
      break;
    }
    case 'toggle-reply': {
      const id = btn.getAttribute('data-id') ?? '';
      toggleReplyForm(id);
      break;
    }
    case 'submit-reply': {
      const id = btn.getAttribute('data-id') ?? '';
      submitReply(id);
      break;
    }
    case 'cancel-reply': {
      const id = btn.getAttribute('data-id') ?? '';
      toggleReplyForm(id);
      break;
    }
  }
});

// Also handle commit select change
document.addEventListener('change', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.id === 'commit-select') {
    selectCommit(/** @type {HTMLSelectElement} */(target).value);
  }
});

// ── Rendering ─────────────────────────────────────────────────────────────

function renderAll() {
  renderCommitSelect();
  renderSummaryBadges();
  renderDiff();
}

function renderCommitSelect() {
  const sel = /** @type {HTMLSelectElement} */ (document.getElementById('commit-select'));
  if (!sel) return;
  sel.innerHTML = '';
  for (const c of state.commits) {
    const opt = document.createElement('option');
    opt.value = c.hash;
    opt.textContent = `${c.shortHash} \u2014 ${c.message}`;
    if (c.hash === state.selectedHash) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderSummaryBadges() {
  const forCommit = state.comments.filter(c => c.commitHash === state.selectedHash);
  const open = forCommit.filter(c => c.status === 'open').length;
  const replied = forCommit.filter(c => c.status === 'agent-replied').length;
  const addressed = forCommit.filter(c => c.status === 'addressed' || c.status === 'resolved').length;

  setEl('badge-open', `${open} open`);
  setEl('badge-replied', `${replied} in review`);
  setEl('badge-addressed', `${addressed} addressed`);

  const btn = document.getElementById('mark-reviewed-btn');
  if (btn) {
    const isReviewed = state.reviewedCommits.has(state.selectedHash);
    btn.textContent = isReviewed ? '\u2713 Reviewed' : 'Mark as reviewed';
    btn.classList.toggle('reviewed', isReviewed);
  }
}

function renderDiff() {
  const main = document.getElementById('main');
  if (!main) return;

  const commit = state.commits.find(c => c.hash === state.selectedHash);
  if (!commit) {
    main.innerHTML = '<div class="empty-state"><h2>No commit selected</h2><p>Select a commit from the dropdown above.</p></div>';
    return;
  }

  const forCommit = state.comments.filter(c => c.commitHash === state.selectedHash);

  if (!commit.parsedDiff || commit.parsedDiff.length === 0) {
    main.innerHTML = '<div class="empty-state"><h2>No diff available</h2><p>This commit has no changed files, or the diff could not be loaded.</p></div>';
    return;
  }

  main.innerHTML = commit.parsedDiff.map(fileDiff => renderFileBlock(fileDiff, forCommit, commit)).join('');
}

/**
 * @param {{ file: string, hunks: any[] }} fileDiff
 * @param {any[]} comments
 * @param {any} commit
 */
function renderFileBlock(fileDiff, comments, commit) {
  const fileComments = comments.filter(c => c.file === fileDiff.file);
  const status = commit.changedFiles?.find(/** @param {any} f */ (f) => f.path === fileDiff.file)?.status ?? 'M';

  const rows = fileDiff.hunks.map(/** @param {any} hunk */ (hunk) => renderHunk(hunk, fileDiff.file, fileComments, commit.hash)).join('');

  return `
<div class="file-block" data-file="${esc(fileDiff.file)}">
  <div class="file-header" data-action="toggle-file">
    <span class="chevron">\u25be</span>
    <span class="file-name">${esc(fileDiff.file)}</span>
    <span class="file-status ${esc(status)}">${esc(status)}</span>
    ${fileComments.length > 0 ? `<span class="badge open">${fileComments.filter(c => c.status === 'open' || c.status === 'agent-replied').length} comments</span>` : ''}
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

  const lineRows = hunk.lines.map(/** @param {any} line */ (line) => {
    const lineNum = line.newLineNum ?? line.oldLineNum ?? 0;
    const cls = line.type === 'add' ? 'add-line' : line.type === 'delete' ? 'del-line' : '';
    const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';

    const lineComments = comments.filter(c => {
      return c.line === line.newLineNum || c.line === line.oldLineNum;
    });

    const commentRows = lineComments.map(c => renderThreadRow(c)).join('');

    // Only show "+" button for added/context lines (right side)
    const addBtn = line.type !== 'delete'
      ? `<button class="line-add-btn" title="Add comment" data-action="add-comment" data-commit="${esc(commitHash)}" data-file="${esc(file)}" data-line="${lineNum}">+</button>`
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
  const replies = (comment.thread ?? []).map(/** @param {any} r */ (r) => `
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

// ── Actions ───────────────────────────────────────────────────────────────

/** @param {string} hash */
function selectCommit(hash) {
  state.selectedHash = hash;
  renderSummaryBadges();
  renderDiff();
}

function navigateCommit(/** @type {'prev'|'next'} */ direction) {
  const idx = state.commits.findIndex(c => c.hash === state.selectedHash);
  const next = direction === 'prev' ? idx - 1 : idx + 1;
  if (next >= 0 && next < state.commits.length) {
    state.selectedHash = state.commits[next].hash;
    const sel = /** @type {HTMLSelectElement} */ (document.getElementById('commit-select'));
    if (sel) sel.value = state.selectedHash;
    renderSummaryBadges();
    renderDiff();
  }
}

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
  if (ta) { ta.value = ''; }

  const h4 = composer.querySelector('h4');
  if (h4) h4.textContent = `Comment on ${file}:${line}`;

  composer.style.display = 'block';
  // Position near the click
  const x = Math.min(event.clientX, window.innerWidth - 440);
  const y = Math.min(event.clientY + 10, window.innerHeight - 200);
  composer.style.left = `${x}px`;
  composer.style.top = `${y}px`;

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
  if (state.reviewedCommits.has(state.selectedHash)) {
    state.reviewedCommits.delete(state.selectedHash);
  } else {
    state.reviewedCommits.add(state.selectedHash);
  }
  renderSummaryBadges();
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

// ── Helpers ───────────────────────────────────────────────────────────────

/** @param {string} s */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @param {string} s */
function escCode(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** @param {string} id @param {string} text */
function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/** @param {string} iso */
function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}
