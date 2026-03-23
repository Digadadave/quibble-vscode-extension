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
    const file       = btn.getAttribute('data-file')   ?? '';
    const line       = parseInt(btn.getAttribute('data-line') ?? '1', 10);
    const commitHash = btn.getAttribute('data-commit')  ?? '';
    const id         = btn.getAttribute('data-id')      ?? '';
    if (file) vscode.postMessage({ type: 'focusComment', file, line, commitHash, id });
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
    const badge = statusBadge(c.status);
    return `
<div class="sidebar-comment" data-action="comment-jump"
     data-file="${esc(c.file)}" data-line="${c.line}"
     data-commit="${esc(c.commitHash ?? '')}" data-id="${esc(c.id ?? '')}">
  <div class="sidebar-comment-header">
    <span class="sidebar-comment-loc">${esc(c.file)}:${c.line}</span>
    ${badge}
  </div>
  <div class="sidebar-comment-body">${esc(short)}</div>
</div>`;
  }).join('');
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns an inline SVG circle badge with a letter for the given status.
 * @param {string} status
 */
function statusBadge(status) {
  const map = {
    'open':          { letter: 'O', color: '#388bfd' },
    'pending':       { letter: 'P', color: '#d29922' },
    'outdated':      { letter: '!', color: '#6e7681' },
    'in-progress':   { letter: 'I', color: '#58a6ff' },
    'resolved':      { letter: '✓', color: '#3fb950' },
    'wont-fix':      { letter: '–', color: '#6e7681' },
    'question':      { letter: 'Q', color: '#a371f7' },
    'agent-replied': { letter: 'A', color: '#a371f7' },
    'addressed':     { letter: '✓', color: '#3fb950' },
  };
  const { letter, color } = map[status] ?? { letter: '?', color: '#6e7681' };
  // Inline SVG: circle + centered letter. title gives full status on hover.
  return `<svg class="status-badge" viewBox="0 0 16 16" width="16" height="16" title="${esc(status)}" aria-label="${esc(status)}">
  <circle cx="8" cy="8" r="7" fill="${color}" opacity="0.18"/>
  <circle cx="8" cy="8" r="7" fill="none" stroke="${color}" stroke-width="1.5"/>
  <text x="8" y="8" text-anchor="middle" dominant-baseline="central"
        font-size="${letter.length > 1 ? '7' : '8'}" font-weight="700"
        font-family="system-ui,sans-serif" fill="${color}">${letter}</text>
</svg>`;
}

/** @param {string} s */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
