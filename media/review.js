// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  /** @type {any[]} commit metadata (no diff content) */
  commits: [],
  /** @type {any[]} */
  comments: [],
  /** @type {Set<string>} selected commit hashes */
  selectedHashes: new Set(),
  /** @type {Set<string>} commits marked reviewed */
  reviewedCommits: new Set(),
  /** 'selected' | 'all' */
  commentView: 'selected',

  // Current rendered diff result
  /** @type {any[]} */
  currentDiff: [],
  /** @type {any[]} */
  currentChangedFiles: [],
  /** @type {string} */
  currentOldestShort: '',
  /** @type {string} */
  currentNewestShort: '',
  diffLoading: false,
};

// Pending comment placement
let pendingCommentFile = '';
let pendingCommentLine = 0;
let pendingCommentCommitHash = '';

// Shift+click anchor index in the commits array
let lastClickedIndex = -1;

// Debounce timer for diff requests
let diffRequestTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);

// ── VSCode message handler ────────────────────────────────────────────────

window.addEventListener('message', (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'load': {
      state.commits = msg.commits ?? [];
      state.comments = msg.comments ?? [];
      // Auto-select the first commit on initial load
      if (state.selectedHashes.size === 0 && state.commits.length > 0) {
        state.selectedHashes.add(state.commits[0].hash);
        lastClickedIndex = 0;
      }
      renderGraph();
      renderCommentList();
      renderTopBar();
      requestDiff();
      break;
    }
    case 'diffResult': {
      state.diffLoading = false;
      state.currentDiff = msg.parsedDiff ?? [];
      state.currentChangedFiles = msg.changedFiles ?? [];
      state.currentOldestShort = msg.oldestShort ?? '';
      state.currentNewestShort = msg.newestShort ?? '';
      renderDiff();
      break;
    }
    case 'focusFile':
      if (msg.file) scrollToFile(msg.file);
      break;
    case 'selectCommit':
      if (msg.hash) {
        state.selectedHashes.clear();
        state.selectedHashes.add(msg.hash);
        renderCommitList();
        renderTopBar();
        renderCommentList();
        requestDiff();
      }
      break;
  }
});

// ── Event delegation ──────────────────────────────────────────────────────

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

  const btn = target.closest('[data-action]');
  if (!btn) return;

  const action = btn.getAttribute('data-action') ?? '';
  if (action !== 'toggle-commit-checkbox') {
    e.stopPropagation();
  }

  switch (action) {
    case 'graph-row-click': {
      const hash = btn.getAttribute('data-hash') ?? '';
      const idx = parseInt(btn.getAttribute('data-index') ?? '-1', 10);
      if (e.shiftKey && lastClickedIndex >= 0 && idx >= 0) {
        // Range select: toggle all commits between lastClickedIndex and idx
        const lo = Math.min(lastClickedIndex, idx);
        const hi = Math.max(lastClickedIndex, idx);
        for (let i = lo; i <= hi; i++) {
          state.selectedHashes.add(state.commits[i].hash);
        }
      } else {
        // Single click: toggle this commit, update anchor
        if (state.selectedHashes.has(hash) && state.selectedHashes.size === 1) {
          // clicking the only selected commit — keep it selected
        } else if (state.selectedHashes.has(hash)) {
          state.selectedHashes.delete(hash);
        } else {
          state.selectedHashes.add(hash);
        }
        lastClickedIndex = idx;
      }
      renderGraph();
      renderTopBar();
      renderCommentList();
      requestDiff();
      break;
    }
    case 'select-all-commits':
      state.commits.forEach(c => state.selectedHashes.add(c.hash));
      lastClickedIndex = -1;
      renderGraph();
      renderTopBar();
      renderCommentList();
      requestDiff();
      break;
    case 'select-no-commits':
      state.selectedHashes.clear();
      state.currentDiff = [];
      lastClickedIndex = -1;
      renderGraph();
      renderTopBar();
      renderCommentList();
      renderDiff();
      break;
    case 'view-selected':
      state.commentView = 'selected';
      syncCommentViewBtns('view-selected');
      renderCommentList();
      break;
    case 'view-all-comments':
      state.commentView = 'all';
      syncCommentViewBtns('view-all-comments');
      renderCommentList();
      break;
    case 'sidebar-comment-jump': {
      const hash = btn.getAttribute('data-hash') ?? '';
      const file = btn.getAttribute('data-file') ?? '';
      if (!state.selectedHashes.has(hash)) {
        state.selectedHashes.add(hash);
        renderGraph();
        renderTopBar();
        renderCommentList();
        requestDiff();
      }
      if (file) setTimeout(() => scrollToFile(file), 150);
      break;
    }
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

// ── Tooltip on graph rows ─────────────────────────────────────────────────

const tooltip = document.getElementById('commit-tooltip');

document.addEventListener('mouseover', (e) => {
  const row = /** @type {HTMLElement|null} */ (
    (/** @type {HTMLElement} */ (e.target)).closest('.graph-row')
  );
  if (!row || !tooltip) return;
  const hash = row.getAttribute('data-hash') ?? '';
  const commit = state.commits.find(c => c.hash === hash);
  if (!commit) return;

  tooltip.innerHTML = `
    <div class="tooltip-hash">${esc(commit.hash)}</div>
    <div class="tooltip-msg">${esc(commit.message)}</div>
    <div class="tooltip-meta">${esc(commit.author)} &middot; ${formatDate(commit.date)}</div>
  `;
  tooltip.style.display = 'block';
  positionTooltip(e);
});

document.addEventListener('mousemove', (e) => {
  if (tooltip && tooltip.style.display === 'block') positionTooltip(e);
});

document.addEventListener('mouseout', (e) => {
  const row = /** @type {HTMLElement|null} */ (
    (/** @type {HTMLElement} */ (e.target)).closest('.graph-row')
  );
  if (row && !row.contains(/** @type {Node} */ (e.relatedTarget))) {
    if (tooltip) tooltip.style.display = 'none';
  }
});

/** @param {MouseEvent} e */
function positionTooltip(e) {
  if (!tooltip) return;
  const x = Math.min(e.clientX + 14, window.innerWidth - 380);
  const y = Math.min(e.clientY + 14, window.innerHeight - 100);
  tooltip.style.left = `${x}px`;
  tooltip.style.top  = `${y}px`;
}

// ── Diff request ───────────────────────────────────────────────────────────

/**
 * Ask the extension for a cumulative diff across all selected commits.
 * Debounced so rapid checkbox changes don't flood the extension.
 */
function requestDiff() {
  if (diffRequestTimer !== null) clearTimeout(diffRequestTimer);
  diffRequestTimer = setTimeout(() => {
    diffRequestTimer = null;
    const hashes = [...state.selectedHashes];
    if (hashes.length === 0) {
      state.currentDiff = [];
      renderDiff();
      return;
    }
    state.diffLoading = true;
    renderDiffLoading();
    vscode.postMessage({ type: 'requestDiff', hashes });
  }, 120);
}

// ── Rendering ─────────────────────────────────────────────────────────────

// ── Sidebar: git graph ────────────────────────────────────────────────────

const GRAPH_DOT_CX = 14;      // x-center of the dot in the 28px lane
const GRAPH_DOT_R  = 4.5;     // radius of the commit dot
const GRAPH_LINE_COLOR = '#4a9eff';
const GRAPH_DOT_COLOR  = '#4a9eff';
const GRAPH_HEAD_COLOR = '#ffffff';
const ROW_HEIGHT = 24;         // must match min-height in CSS

function renderGraph() {
  const container = document.getElementById('graph-list');
  if (!container) return;

  if (state.commits.length === 0) {
    container.innerHTML = '<div style="padding:12px;color:var(--fg-muted);font-size:12px">No commits found</div>';
    return;
  }

  // Figure out selected range boundaries for visual highlight
  const selectedIndices = state.commits
    .map((c, i) => state.selectedHashes.has(c.hash) ? i : -1)
    .filter(i => i >= 0);
  const rangeMin = selectedIndices.length ? Math.min(...selectedIndices) : -1;
  const rangeMax = selectedIndices.length ? Math.max(...selectedIndices) : -1;

  container.innerHTML = state.commits.map((commit, idx) => {
    const isSelected = state.selectedHashes.has(commit.hash);
    const isFirst = idx === 0;
    const isLast  = idx === state.commits.length - 1;
    const openCount = state.comments.filter(
      c => c.commitHash === commit.hash && (c.status === 'open' || c.status === 'agent-replied')
    ).length;

    // SVG: vertical line + dot
    // Line goes from top to bottom of row, dot is in the middle
    const dotCy  = ROW_HEIGHT / 2;
    const lineTop = 0;
    const lineBot = ROW_HEIGHT;
    const dotR = isFirst ? GRAPH_DOT_R + 1 : GRAPH_DOT_R;
    const dotFill = isFirst ? GRAPH_HEAD_COLOR : GRAPH_DOT_COLOR;
    const dotStroke = GRAPH_DOT_COLOR;

    const lineAbove = isFirst ? '' :
      `<line x1="${GRAPH_DOT_CX}" y1="${lineTop}" x2="${GRAPH_DOT_CX}" y2="${dotCy - dotR}"
             stroke="${GRAPH_LINE_COLOR}" stroke-width="1.5"/>`;
    const lineBelow = isLast ? '' :
      `<line x1="${GRAPH_DOT_CX}" y1="${dotCy + dotR}" x2="${GRAPH_DOT_CX}" y2="${lineBot}"
             stroke="${GRAPH_LINE_COLOR}" stroke-width="1.5"/>`;

    const svgContent = `
      ${lineAbove}
      ${lineBelow}
      <circle cx="${GRAPH_DOT_CX}" cy="${dotCy}" r="${dotR}"
              fill="${dotFill}" stroke="${dotStroke}" stroke-width="1.5"/>
    `;

    // Ref badges
    const refs = (commit.refs ?? []).map(/** @param {string} r */ r => {
      let cls = 'local';
      let label = r;
      if (r.startsWith('HEAD ->')) {
        cls = 'head';
        label = r.replace('HEAD ->', '').trim();
        label = `\u2192 ${label}`;
      } else if (r === 'HEAD') {
        cls = 'head';
      } else if (r.startsWith('origin/') || r.startsWith('upstream/')) {
        cls = 'remote';
      } else if (r.startsWith('tag:')) {
        cls = 'tag';
        label = r.replace('tag:', '').trim();
      }
      return `<span class="graph-ref ${cls}" title="${esc(r)}">${esc(label)}</span>`;
    }).join('');

    const rangeClass = (idx === rangeMin && idx !== rangeMax) ? ' range-start'
                     : (idx === rangeMax && idx !== rangeMin) ? ' range-end'
                     : '';

    return `
<div class="graph-row${isSelected ? ' selected' : ''}${rangeClass}"
     data-action="graph-row-click" data-hash="${esc(commit.hash)}" data-index="${idx}">
  <div class="graph-lane">
    <svg height="${ROW_HEIGHT}" width="28">${svgContent}</svg>
  </div>
  <div class="graph-info">
    <div class="graph-msg">${esc(commit.message)}</div>
    ${refs ? `<div class="graph-refs">${refs}</div>` : ''}
  </div>
  ${openCount > 0 ? `<div class="graph-comment-dot" title="${openCount} open comment${openCount !== 1 ? 's' : ''}"></div>` : ''}
</div>`;
  }).join('');
}

// ── Sidebar: comment list ──────────────────────────────────────────────────

function renderCommentList() {
  const container = document.getElementById('comment-list');
  if (!container) return;

  const visible = state.commentView === 'all'
    ? state.comments
    : state.comments.filter(c => state.selectedHashes.has(c.commitHash));

  if (visible.length === 0) {
    container.innerHTML = `<div style="padding:10px;color:var(--fg-muted);font-size:11px">No comments${state.commentView === 'selected' ? ' for selected commits' : ''}</div>`;
    return;
  }

  container.innerHTML = visible.map(c => {
    const short = c.body.length > 55 ? c.body.slice(0, 55) + '\u2026' : c.body;
    return `
<div class="sidebar-comment" data-action="sidebar-comment-jump"
     data-hash="${esc(c.commitHash)}" data-file="${esc(c.file)}">
  <div class="sidebar-comment-loc">${esc(c.file)}:${c.line}</div>
  <div class="sidebar-comment-body">${esc(short)}</div>
  <span class="sidebar-comment-status ${c.status}">${esc(c.status)}</span>
</div>`;
  }).join('');
}

// ── Top bar ────────────────────────────────────────────────────────────────

function renderTopBar() {
  const selectedComments = state.comments.filter(c => state.selectedHashes.has(c.commitHash));
  const open = selectedComments.filter(c => c.status === 'open').length;
  const replied = selectedComments.filter(c => c.status === 'agent-replied').length;
  const addressed = selectedComments.filter(
    c => c.status === 'addressed' || c.status === 'resolved'
  ).length;

  setEl('badge-open', `${open} open`);
  setEl('badge-replied', `${replied} in review`);
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

// ── Diff loading spinner ───────────────────────────────────────────────────

function renderDiffLoading() {
  const main = document.getElementById('main');
  if (main) {
    main.innerHTML = '<div class="empty-state"><p>Computing diff\u2026</p></div>';
  }
}

// ── Main diff area ─────────────────────────────────────────────────────────

function renderDiff() {
  const main = document.getElementById('main');
  if (!main) return;

  if (state.selectedHashes.size === 0) {
    main.innerHTML = '<div class="empty-state"><h2>No commits selected</h2><p>Check commits in the left panel to review their diffs.</p></div>';
    return;
  }

  if (state.currentDiff.length === 0) {
    main.innerHTML = '<div class="empty-state"><h2>No diff available</h2><p>This selection has no changed files.</p></div>';
    return;
  }

  // Build a lookup of file→status from changedFiles
  const fileStatus = new Map(
    (state.currentChangedFiles ?? []).map(/** @param {any} f */ f => [f.path, f.status])
  );

  // Determine range label
  const n = state.selectedHashes.size;
  let rangeLabel = '';
  if (n === 1) {
    rangeLabel = `Commit ${state.currentNewestShort}`;
  } else {
    rangeLabel = `${state.currentOldestShort} \u2192 ${state.currentNewestShort} (${n} commits)`;
  }

  // All comments for any selected commit
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
 * @param {any[]} comments  all comments for selected commits
 * @param {Map<string, string>} fileStatus
 */
function renderFileBlock(fileDiff, comments, fileStatus) {
  const fileComments = comments.filter(c => c.file === fileDiff.file);
  const status = fileStatus.get(fileDiff.file) ?? 'M';
  const openCount = fileComments.filter(
    c => c.status === 'open' || c.status === 'agent-replied'
  ).length;

  // Use the newest selected commit hash for new comments (best guess)
  const newestHash = [...state.selectedHashes].reduce((best, h) => {
    const idxBest = state.commits.findIndex(c => c.hash === best);
    const idxH    = state.commits.findIndex(c => c.hash === h);
    return idxH < idxBest ? h : best; // lower index = newer
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
    const cls = line.type === 'add' ? 'add-line' : line.type === 'delete' ? 'del-line' : '';
    const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';

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

/** @param {string} hash */
function toggleCommitSelection(hash) {
  if (state.selectedHashes.has(hash)) {
    state.selectedHashes.delete(hash);
  } else {
    state.selectedHashes.add(hash);
  }
  renderGraph();
  renderTopBar();
  renderCommentList();
  requestDiff();
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
  if (ta) ta.value = '';

  const h4 = composer.querySelector('h4');
  if (h4) h4.textContent = `Comment on ${file}:${line}`;

  composer.style.display = 'block';
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
  const allReviewed = [...state.selectedHashes].every(h => state.reviewedCommits.has(h));
  for (const h of state.selectedHashes) {
    if (allReviewed) {
      state.reviewedCommits.delete(h);
    } else {
      state.reviewedCommits.add(h);
    }
  }
  renderTopBar();
  renderGraph();
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

/** @param {string} activeAction */
function syncCommentViewBtns(activeAction) {
  document.querySelectorAll('[data-action="view-selected"],[data-action="view-all-comments"]')
    .forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-action') === activeAction);
    });
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
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}
