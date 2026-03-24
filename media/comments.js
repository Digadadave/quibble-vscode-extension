// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

// ── State ───────────────────────────────────────────────────────────────────

const state = {
  /** @type {any[]} */
  comments: [],
  /** @type {'all'|'open'|'needs-input'|'closed'} */
  filter: 'all',
  /**
   * IDs of cards whose expand/collapse has been manually toggled from the
   * default.  Default: open statuses = expanded, closed statuses = collapsed.
   * @type {Set<string>}
   */
  expandedOverrides: new Set(),
};

const CLOSED_STATUSES = new Set(['resolved', 'dismissed', 'outdated']);

/** @type {Record<string, {label:string, color:string, letter:string}>} */
const STATUS_META = {
  'open':        { label: 'Open',        color: '#da3633', letter: 'O'  },
  'in-progress': { label: 'In Progress', color: '#388bfd', letter: 'P'  },
  'needs-input': { label: 'Needs Input', color: '#e3b341', letter: '?'  },
  'addressed':   { label: 'Addressed',   color: '#2ea043', letter: '✓'  },
  'resolved':    { label: 'Resolved',    color: '#2ea043', letter: '✓'  },
  'dismissed':   { label: 'Dismissed',   color: '#888',    letter: '–'  },
  'outdated':    { label: 'Outdated',    color: '#888',    letter: '!'  },
};

// ── Context menu ─────────────────────────────────────────────────────────────

/** @type {HTMLElement|null} */
let contextMenu = null;
/** @type {string} */
let contextMenuId = '';

function showContextMenu(x, y, commentId) {
  dismissContextMenu();
  contextMenuId = commentId;
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = `<div class="ctx-item ctx-danger" data-action="ctx-delete">Delete comment</div>`;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
  contextMenu = menu;
}

function dismissContextMenu() {
  contextMenu?.remove();
  contextMenu = null;
  contextMenuId = '';
}

// ── Event delegation ─────────────────────────────────────────────────────────

document.addEventListener('contextmenu', (/** @type {MouseEvent} */ e) => {
  const card = /** @type {HTMLElement|null} */ (
    /** @type {HTMLElement} */ (e.target).closest('.comment-card')
  );
  if (!card) { dismissContextMenu(); return; }
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, card.getAttribute('data-id') ?? '');
});

document.addEventListener('click', (/** @type {MouseEvent} */ e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (contextMenu && !contextMenu.contains(target)) dismissContextMenu();

  const btn = target.closest('[data-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-action') ?? '';
  const id     = btn.getAttribute('data-id')     ?? '';

  switch (action) {
    case 'set-filter':
      state.filter = /** @type {any} */ (btn.getAttribute('data-filter') ?? 'all');
      render();
      break;

    case 'toggle-card':
      if (state.expandedOverrides.has(id)) state.expandedOverrides.delete(id);
      else                                  state.expandedOverrides.add(id);
      render();
      break;

    case 'open-diff':
      vscode.postMessage({
        type:       'focusComment',
        file:       btn.getAttribute('data-file'),
        line:       parseInt(btn.getAttribute('data-line') ?? '1', 10),
        commitHash: btn.getAttribute('data-commit'),
        id,
      });
      break;

    case 'update-status':
      vscode.postMessage({ type: 'updateStatus', id, status: btn.getAttribute('data-status') });
      break;

    case 'ctx-delete':
      if (contextMenuId) vscode.postMessage({ type: 'deleteComment', id: contextMenuId });
      dismissContextMenu();
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') dismissContextMenu();
});

// ── Message handler ───────────────────────────────────────────────────────────

window.addEventListener('message', (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  if (msg.type === 'load') {
    state.comments = msg.comments ?? [];
    // Reset overrides so fresh status changes reflect immediately
    state.expandedOverrides.clear();
    render();
  }
});

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  renderSummary();
  renderFilterBar();
  renderCommentList();
}

function renderSummary() {
  const el = document.getElementById('summary-bar');
  if (!el) return;
  const all   = state.comments;
  const open  = all.filter(c => !CLOSED_STATUSES.has(c.status));
  const input = all.filter(c => c.status === 'needs-input');
  const closed = all.filter(c => CLOSED_STATUSES.has(c.status));

  const parts = [];
  if (open.length)   parts.push(`<span class="sum-open">${open.length} open</span>`);
  if (input.length)  parts.push(`<span class="sum-input">${input.length} need input</span>`);
  if (closed.length) parts.push(`<span class="sum-closed">${closed.length} closed</span>`);

  el.innerHTML = parts.length ? parts.join('<span class="sum-sep">·</span>') : '<span class="sum-empty">No comments yet</span>';
}

function renderFilterBar() {
  const el = document.getElementById('filter-bar');
  if (!el) return;

  const all    = state.comments.length;
  const open   = state.comments.filter(c => !CLOSED_STATUSES.has(c.status) && c.status !== 'needs-input').length;
  const input  = state.comments.filter(c => c.status === 'needs-input').length;
  const closed = state.comments.filter(c => CLOSED_STATUSES.has(c.status)).length;

  /** @param {string} f @param {string} label @param {number} count */
  const chip = (f, label, count) => `
<button class="filter-chip ${state.filter === f ? 'active' : ''}" data-action="set-filter" data-filter="${f}">
  ${label}${count > 0 ? ` <span class="chip-count">${count}</span>` : ''}
</button>`;

  el.innerHTML =
    chip('all',         'All',        all)   +
    chip('open',        'Open',       open)  +
    chip('needs-input', 'Needs Input', input) +
    chip('closed',      'Closed',     closed);
}

function renderCommentList() {
  const container = document.getElementById('comment-list');
  if (!container) return;

  const filtered = getFilteredComments();
  if (filtered.length === 0) {
    container.innerHTML = '<div class="cv-empty">No comments match this filter.</div>';
    return;
  }

  container.innerHTML = filtered.map(c => renderCard(c)).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFilteredComments() {
  switch (state.filter) {
    case 'open':        return state.comments.filter(c => !CLOSED_STATUSES.has(c.status) && c.status !== 'needs-input');
    case 'needs-input': return state.comments.filter(c => c.status === 'needs-input');
    case 'closed':      return state.comments.filter(c => CLOSED_STATUSES.has(c.status));
    default:            return state.comments;
  }
}

/** @param {any} comment */
function isCardExpanded(comment) {
  const defaultExpanded = !CLOSED_STATUSES.has(comment.status);
  return state.expandedOverrides.has(comment.id) ? !defaultExpanded : defaultExpanded;
}

// ── Card rendering ────────────────────────────────────────────────────────────

/** @param {any} comment */
function renderCard(comment) {
  const expanded = isCardExpanded(comment);
  const isClosed = CLOSED_STATUSES.has(comment.status);
  const meta     = STATUS_META[comment.status] ?? { label: comment.status, color: '#888', letter: '?' };
  const fname    = comment.file.split('/').pop() ?? comment.file;
  const dir      = comment.file.includes('/') ? comment.file.slice(0, comment.file.lastIndexOf('/')) : '';

  return `
<div class="comment-card ${isClosed ? 'card-closed' : 'card-open'}" data-id="${esc(comment.id)}">

  <div class="card-header" data-action="toggle-card" data-id="${esc(comment.id)}">
    <span class="card-chevron">${expanded ? '▾' : '▸'}</span>
    ${statusBadgeSvg(comment.status)}
    <span class="card-title">
      <span class="card-fname">${esc(fname)}</span>${dir ? `<span class="card-dir"> ${esc(dir)}</span>` : ''}
      <span class="card-line">:${comment.line}</span>
    </span>
    <span class="card-date">${formatDate(comment.createdAt)}</span>
  </div>

  <div class="card-body" ${expanded ? '' : 'style="display:none"'}>
    <div class="card-main-body">${esc(comment.body)}</div>
    ${comment.codeSnippet ? `<pre class="card-snippet">${escCode(comment.codeSnippet)}</pre>` : ''}

    ${(comment.thread ?? []).map(/** @param {any} e */ e => renderThreadEntry(e)).join('')}

    ${comment.resolvedNote ? renderResolvedNote(comment) : ''}

    <div class="card-actions">
      <button class="card-btn primary-btn" data-action="open-diff"
              data-id="${esc(comment.id)}"
              data-file="${esc(comment.file)}"
              data-line="${comment.line}"
              data-commit="${esc(comment.commitHash ?? '')}">Open in Diff</button>
      ${renderStatusActions(comment)}
    </div>
  </div>

</div>`;
}

/** @param {any} entry */
function renderThreadEntry(entry) {
  const isAgent = entry.author !== 'reviewer';
  return `
<div class="card-reply ${isAgent ? 'reply-agent' : 'reply-reviewer'}">
  <div class="reply-meta">
    ${isAgent ? agentIconSvg() : ''}
    <span class="reply-author ${isAgent ? 'agent-author' : ''}">${esc(entry.author)}</span>
    <span class="reply-date">${formatDate(entry.createdAt)}</span>
  </div>
  <div class="reply-body">${esc(entry.body)}</div>
</div>`;
}

/** @param {any} comment */
function renderResolvedNote(comment) {
  const noteLabel = comment.status === 'needs-input'  ? '🔔 Agent Note'
                  : comment.status === 'outdated'      ? '⚠️ Outdated'
                  : comment.status === 'addressed'     ? '✅ Agent Update'
                  : 'Agent Note';
  return `
<div class="card-reply reply-agent reply-note">
  <div class="reply-meta">
    ${agentIconSvg()}
    <span class="reply-author agent-author">${esc(noteLabel)}</span>
    ${comment.addressedAt ? `<span class="reply-date">${formatDate(comment.addressedAt)}</span>` : ''}
  </div>
  <div class="reply-body">${esc(comment.resolvedNote)}</div>
</div>`;
}

/** @param {any} comment */
function renderStatusActions(comment) {
  const id = comment.id;
  const s  = comment.status;

  /** @param {string} status @param {string} label @param {string} [cls] */
  const btn = (status, label, cls = '') =>
    `<button class="card-btn ${cls}" data-action="update-status" data-id="${esc(id)}" data-status="${status}">${label}</button>`;

  if (CLOSED_STATUSES.has(s)) {
    return btn('open', 'Reopen');
  }
  const actions = [];
  if (s !== 'resolved')  actions.push(btn('resolved',  'Resolve',  'success-btn'));
  if (s !== 'dismissed') actions.push(btn('dismissed', 'Dismiss'));
  return actions.join('');
}

// ── SVG helpers ───────────────────────────────────────────────────────────────

/** @param {string} status */
function statusBadgeSvg(status) {
  const meta = STATUS_META[status] ?? { color: '#888', letter: '?' };
  const sz = meta.letter.length > 1 ? '7' : '8';
  return `<svg class="status-badge" viewBox="0 0 16 16" width="14" height="14">
  <circle cx="8" cy="8" r="7" fill="${meta.color}" opacity="0.18"/>
  <circle cx="8" cy="8" r="7" fill="none" stroke="${meta.color}" stroke-width="1.5"/>
  <text x="8" y="11.5" text-anchor="middle" font-size="${sz}" font-weight="700"
        font-family="system-ui,sans-serif" fill="${meta.color}">${meta.letter}</text>
</svg>`;
}

function agentIconSvg() {
  return `<svg class="agent-icon" viewBox="0 0 14 14" width="12" height="12">
  <circle cx="7" cy="7" r="6" fill="#a371f7" opacity="0.15"/>
  <circle cx="7" cy="7" r="6" fill="none" stroke="#a371f7" stroke-width="1"/>
  <line x1="7" y1="2.5" x2="7" y2="5"    stroke="#a371f7" stroke-width="1.3" stroke-linecap="round"/>
  <line x1="7" y1="9"   x2="7" y2="11.5" stroke="#a371f7" stroke-width="1.3" stroke-linecap="round"/>
  <line x1="2.5" y1="7" x2="5"   y2="7"  stroke="#a371f7" stroke-width="1.3" stroke-linecap="round"/>
  <line x1="9"   y1="7" x2="11.5" y2="7" stroke="#a371f7" stroke-width="1.3" stroke-linecap="round"/>
  <line x1="3.7" y1="3.7" x2="5.4" y2="5.4" stroke="#a371f7" stroke-width="1.1" stroke-linecap="round"/>
  <line x1="8.6" y1="8.6" x2="10.3" y2="10.3" stroke="#a371f7" stroke-width="1.1" stroke-linecap="round"/>
  <line x1="10.3" y1="3.7" x2="8.6" y2="5.4" stroke="#a371f7" stroke-width="1.1" stroke-linecap="round"/>
  <line x1="5.4"  y1="8.6" x2="3.7" y2="10.3" stroke="#a371f7" stroke-width="1.1" stroke-linecap="round"/>
</svg>`;
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** @param {string} s */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** @param {string} s */
function escCode(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {string} iso */
function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);
    if (mins  < 60)  return `${mins}m ago`;
    if (hours < 24)  return `${hours}h ago`;
    if (days  < 30)  return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return iso; }
}
