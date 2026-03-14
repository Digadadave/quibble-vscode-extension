// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  /** @type {any[]} */
  commits: [],
  /** @type {any[]} */
  comments: [],
  /** @type {Set<string>} */
  selectedHashes: new Set(),
  /** 'selected' | 'all' */
  commentView: 'selected',
};

let lastClickedIndex = -1;
/** @type {ReturnType<typeof setTimeout>|null} */
let selectionTimer = null;

// ── Message handler ────────────────────────────────────────────────────────

window.addEventListener('message', (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  if (msg.type === 'load') {
    state.commits  = msg.commits  ?? [];
    state.comments = msg.comments ?? [];
    // Auto-select first commit on very first load
    if (state.selectedHashes.size === 0 && state.commits.length > 0) {
      state.selectedHashes.add(state.commits[0].hash);
      lastClickedIndex = 0;
      fireSelection();
    }
    renderGraph();
    renderCommentList();
  }
});

// ── Event delegation ───────────────────────────────────────────────────────

document.addEventListener('click', (/** @type {MouseEvent} */ e) => {
  const btn = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest('[data-action]'));
  if (!btn) return;
  const action = btn.getAttribute('data-action') ?? '';

  switch (action) {
    case 'graph-row-click': {
      const hash = btn.getAttribute('data-hash') ?? '';
      const idx  = parseInt(btn.getAttribute('data-index') ?? '-1', 10);
      if (e.shiftKey && lastClickedIndex >= 0 && idx >= 0) {
        const lo = Math.min(lastClickedIndex, idx);
        const hi = Math.max(lastClickedIndex, idx);
        for (let i = lo; i <= hi; i++) state.selectedHashes.add(state.commits[i].hash);
      } else {
        if (state.selectedHashes.has(hash) && state.selectedHashes.size === 1) {
          // keep at least one selected
        } else if (state.selectedHashes.has(hash)) {
          state.selectedHashes.delete(hash);
        } else {
          state.selectedHashes.add(hash);
        }
        lastClickedIndex = idx;
      }
      renderGraph();
      renderCommentList();
      fireSelection();
      break;
    }
    case 'select-all-commits':
      state.commits.forEach(c => state.selectedHashes.add(c.hash));
      lastClickedIndex = -1;
      renderGraph();
      renderCommentList();
      fireSelection();
      break;
    case 'select-no-commits':
      state.selectedHashes.clear();
      lastClickedIndex = -1;
      renderGraph();
      renderCommentList();
      fireSelection();
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
        renderCommentList();
        fireSelection();
      }
      if (file) vscode.postMessage({ type: 'focusFile', file });
      break;
    }
  }
});

// ── Tooltip ────────────────────────────────────────────────────────────────

const tooltip = document.getElementById('commit-tooltip');

document.addEventListener('mouseover', (e) => {
  const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.graph-row'));
  if (!row || !tooltip) return;
  const hash   = row.getAttribute('data-hash') ?? '';
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
  if (tooltip?.style.display === 'block') positionTooltip(e);
});

document.addEventListener('mouseout', (e) => {
  const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.graph-row'));
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

// ── Selection notification ─────────────────────────────────────────────────

function fireSelection() {
  if (selectionTimer !== null) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    selectionTimer = null;
    vscode.postMessage({ type: 'selectionChanged', hashes: [...state.selectedHashes] });
  }, 100);
}

// ── Graph rendering ────────────────────────────────────────────────────────

const GRAPH_DOT_CX    = 14;
const GRAPH_DOT_R     = 4.5;
const GRAPH_LINE_COLOR = '#4a9eff';
const GRAPH_DOT_COLOR  = '#4a9eff';
const GRAPH_HEAD_COLOR = '#ffffff';
const ROW_HEIGHT       = 24;

function renderGraph() {
  const container = document.getElementById('graph-list');
  if (!container) return;

  if (state.commits.length === 0) {
    container.innerHTML = '<div style="padding:12px;color:var(--fg-muted);font-size:12px">No commits found</div>';
    return;
  }

  const selectedIndices = state.commits
    .map((c, i) => state.selectedHashes.has(c.hash) ? i : -1)
    .filter(i => i >= 0);
  const rangeMin = selectedIndices.length ? Math.min(...selectedIndices) : -1;
  const rangeMax = selectedIndices.length ? Math.max(...selectedIndices) : -1;

  container.innerHTML = state.commits.map((commit, idx) => {
    const isSelected = state.selectedHashes.has(commit.hash);
    const isFirst    = idx === 0;
    const isLast     = idx === state.commits.length - 1;
    const openCount  = state.comments.filter(
      c => c.commitHash === commit.hash && (c.status === 'open' || c.status === 'agent-replied')
    ).length;

    const dotCy   = ROW_HEIGHT / 2;
    const dotR    = isFirst ? GRAPH_DOT_R + 1 : GRAPH_DOT_R;
    const dotFill = isFirst ? GRAPH_HEAD_COLOR : GRAPH_DOT_COLOR;

    const lineAbove = isFirst ? '' :
      `<line x1="${GRAPH_DOT_CX}" y1="0" x2="${GRAPH_DOT_CX}" y2="${dotCy - dotR}" stroke="${GRAPH_LINE_COLOR}" stroke-width="1.5"/>`;
    const lineBelow = isLast ? '' :
      `<line x1="${GRAPH_DOT_CX}" y1="${dotCy + dotR}" x2="${GRAPH_DOT_CX}" y2="${ROW_HEIGHT}" stroke="${GRAPH_LINE_COLOR}" stroke-width="1.5"/>`;

    const svgContent = `${lineAbove}${lineBelow}
      <circle cx="${GRAPH_DOT_CX}" cy="${dotCy}" r="${dotR}"
              fill="${dotFill}" stroke="${GRAPH_DOT_COLOR}" stroke-width="1.5"/>`;

    const refs = (commit.refs ?? []).map(/** @param {string} r */ r => {
      let cls = 'local', label = r;
      if (r.startsWith('HEAD ->')) { cls = 'head'; label = '\u2192 ' + r.replace('HEAD ->', '').trim(); }
      else if (r === 'HEAD')       { cls = 'head'; }
      else if (r.startsWith('origin/') || r.startsWith('upstream/')) { cls = 'remote'; }
      else if (r.startsWith('tag:')) { cls = 'tag'; label = r.replace('tag:', '').trim(); }
      return `<span class="graph-ref ${cls}" title="${esc(r)}">${esc(label)}</span>`;
    }).join('');

    const rangeClass = (idx === rangeMin && idx !== rangeMax) ? ' range-start'
                     : (idx === rangeMax && idx !== rangeMin) ? ' range-end' : '';

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

// ── Comment list ───────────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────────

/** @param {string} activeAction */
function syncCommentViewBtns(activeAction) {
  document.querySelectorAll('[data-action="view-selected"],[data-action="view-all-comments"]')
    .forEach(b => b.classList.toggle('active', b.getAttribute('data-action') === activeAction));
}

/** @param {string} s */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** @param {string} iso */
function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric' });
  } catch { return iso; }
}
