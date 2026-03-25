// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  /** @type {Array<{hash: string, shortHash: string, message: string, date: string, author: string, refs: string[]}>} */
  commits: [],
  /** @type {Set<string>} */
  selectedHashes: new Set(),
  /** Last index clicked without shift (anchor for range selection). */
  lastClickedIndex: -1,
  /** Which commits have their file list expanded. */
  expandedHashes: new Set(),
  /** Cached file data per commit hash. @type {Map<string, Array<{path: string, status: string, insertions: number, deletions: number}>>} */
  filesByHash: new Map(),
};

// ── Message handler ────────────────────────────────────────────────────────

window.addEventListener('message', (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  if (msg.type === 'load') {
    state.commits = msg.commits ?? [];
    state.selectedHashes = new Set();
    state.lastClickedIndex = -1;
    state.expandedHashes = new Set();
    state.filesByHash = new Map();
    const label = document.getElementById('branch-label');
    if (label && msg.branch) label.textContent = msg.branch.toUpperCase();
    renderCommits();
  } else if (msg.type === 'commitFiles') {
    state.filesByHash.set(msg.hash, msg.files ?? []);
    renderCommits();
  }
});

// ── Event delegation ───────────────────────────────────────────────────────

document.addEventListener('click', (/** @type {MouseEvent} */ e) => {
  const btn = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest('[data-action]'));
  if (!btn) return;
  const action = btn.getAttribute('data-action') ?? '';

  switch (action) {
    case 'commit-click': {
      const idx = parseInt(btn.getAttribute('data-index') ?? '-1', 10);
      if (idx < 0) break;
      const hash = state.commits[idx]?.hash;
      if (!hash) break;

      if (e.shiftKey && state.lastClickedIndex >= 0) {
        // Range selection: select a range but don't change expansions
        const lo = Math.min(state.lastClickedIndex, idx);
        const hi = Math.max(state.lastClickedIndex, idx);
        state.selectedHashes = new Set(
          state.commits.slice(lo, hi + 1).map(c => c.hash)
        );
      } else {
        // Single click: toggle expansion for this commit
        state.selectedHashes = new Set([hash]);
        state.lastClickedIndex = idx;

        if (state.expandedHashes.has(hash)) {
          state.expandedHashes.delete(hash);
        } else {
          state.expandedHashes.add(hash);
          // Request files from extension if not already cached
          if (!state.filesByHash.has(hash)) {
            vscode.postMessage({ type: 'expandCommit', hash });
          }
        }
      }

      renderCommits();
      vscode.postMessage({ type: 'selectionChanged', hashes: [...state.selectedHashes] });
      break;
    }

    case 'file-click': {
      const file = btn.getAttribute('data-file') ?? '';
      const hash = btn.getAttribute('data-hash') ?? '';
      if (file && hash) {
        vscode.postMessage({ type: 'focusFile', hash, file });
      }
      break;
    }

    case 'select-repo': {
      vscode.postMessage({ type: 'selectRepo' });
      break;
    }
  }
});

// ── Rendering ──────────────────────────────────────────────────────────────

function renderCommits() {
  const container = document.getElementById('commits-list');
  if (!container) return;

  if (state.commits.length === 0) {
    container.innerHTML = '<div style="padding:12px;color:var(--fg-muted);font-size:12px">No commits found</div>';
    return;
  }

  const last = state.commits.length - 1;

  container.innerHTML = state.commits.map((commit, idx) => {
    const isSelected = state.selectedHashes.has(commit.hash);
    const selectedClass = isSelected ? ' selected' : '';

    // HEAD = first commit in the list (newest), or check refs
    const isHead = Array.isArray(commit.refs)
      ? commit.refs.some(r => r.includes('HEAD'))
      : String(commit.refs ?? '').includes('HEAD');

    const dotClass = isHead ? ' head' : '';
    const lineClass = idx === last ? ' last' : '';

    // Refs display (branch/tag labels)
    const refs = Array.isArray(commit.refs) ? commit.refs : [];
    const refsHtml = refs.length
      ? `<div class="commit-refs-row">${refs.map(r => `<span class="commit-ref-tag">${esc(r)}</span>`).join('')}</div>`
      : '';

    // Show file list if expanded and data is available
    const isExpanded = state.expandedHashes.has(commit.hash);
    const files = state.filesByHash.get(commit.hash);
    const filesHtml = (isExpanded && files) ? renderFileList(files, commit.hash) : '';

    return `
<div class="commit-item${selectedClass}" data-action="commit-click" data-index="${idx}" title="${esc(commit.hash)}">
  <div class="commit-graph-col${lineClass}">
    <div class="commit-dot${dotClass}"></div>
  </div>
  <div class="commit-body">
    <div class="commit-row-top">
      <span class="commit-msg">${esc(commit.message)}</span>
      <span class="commit-date">${formatDate(commit.date)}</span>
    </div>
    ${refsHtml}
    ${filesHtml}
  </div>
</div>`;
  }).join('');
}

/**
 * @param {Array<{path: string, status: string, insertions: number, deletions: number}>} files
 * @param {string} commitHash
 */
function renderFileList(files, commitHash) {
  if (!files.length) return '';

  const rows = files.map(f => {
    const parts = f.path.split('/');
    const filename = parts.pop() ?? f.path;
    const folder   = parts.join('/');

    const ins = f.insertions > 0 ? `<span class="stat-ins">+${f.insertions}</span>` : '';
    const del = f.deletions  > 0 ? `<span class="stat-del">-${f.deletions}</span>`  : '';
    const stats = (ins || del) ? `<span class="file-stats">${del}${ins && del ? '&nbsp;' : ''}${ins}</span>` : '';

    const statusClass = f.status === 'A' ? 'status-added'
                      : f.status === 'D' ? 'status-deleted'
                      : 'status-modified';

    return `
<div class="commit-file-row" data-action="file-click" data-file="${esc(f.path)}" data-hash="${esc(commitHash)}">
  <span class="commit-file-status ${statusClass}">${esc(f.status)}</span>
  <span class="commit-file-name">${esc(filename)}</span>
  ${folder ? `<span class="commit-file-folder">${esc(folder)}</span>` : ''}
  <span class="file-row-spacer"></span>
  ${stats}
  <span class="file-jump-btn" title="Scroll to file in diff">&#x2197;</span>
</div>`;
  }).join('');

  return `<div class="commit-file-list">${rows}</div>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
