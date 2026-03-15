// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  /** @type {any[]} */
  comments: [],
};

// ── Message handler ────────────────────────────────────────────────────────

window.addEventListener('message', (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  if (msg.type === 'load') {
    state.comments = msg.comments ?? [];
    renderCommentList();
  }
});

// ── Event delegation ───────────────────────────────────────────────────────

document.addEventListener('click', (/** @type {MouseEvent} */ e) => {
  const btn = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest('[data-action]'));
  if (!btn) return;

  if (btn.getAttribute('data-action') === 'comment-jump') {
    const file = btn.getAttribute('data-file') ?? '';
    const line = parseInt(btn.getAttribute('data-line') ?? '1', 10);
    if (file) vscode.postMessage({ type: 'focusComment', file, line });
  }
});

// ── Rendering ──────────────────────────────────────────────────────────────

function renderCommentList() {
  const container = document.getElementById('comment-list');
  if (!container) return;

  if (state.comments.length === 0) {
    container.innerHTML = '<div style="padding:10px;color:var(--fg-muted);font-size:11px">No comments yet</div>';
    return;
  }

  container.innerHTML = state.comments.map(c => {
    const short = c.body.length > 60 ? c.body.slice(0, 60) + '\u2026' : c.body;
    const statusLabel = statusDisplayLabel(c.status);
    return `
<div class="sidebar-comment" data-action="comment-jump"
     data-file="${esc(c.file)}" data-line="${c.line}">
  <div class="sidebar-comment-loc">${esc(c.file)}:${c.line}</div>
  <div class="sidebar-comment-body">${esc(short)}</div>
  <span class="sidebar-comment-status ${esc(c.status)}">${esc(statusLabel)}</span>
</div>`;
  }).join('');
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** @param {string} status */
function statusDisplayLabel(status) {
  switch (status) {
    case 'open':          return 'open';
    case 'question':      return 'question';
    case 'agent-replied': return 'agent replied';
    case 'addressed':     return 'addressed';
    default:              return status;
  }
}

/** @param {string} s */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
