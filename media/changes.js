(function () {
  const vscode = acquireVsCodeApi();

  // Palette of 8 distinct colors that work in both light and dark VS Code themes
  const BADGE_COLORS = [
    '#3b82f6', // blue
    '#10b981', // emerald
    '#f59e0b', // amber
    '#ef4444', // red
    '#8b5cf6', // violet
    '#06b6d4', // cyan
    '#f97316', // orange
    '#ec4899', // pink
  ];

  const MAX_VISIBLE_BADGES = 3;

  let files = [];
  let branch = '';
  // Maps commit hash → assigned color (stable across renders)
  const commitColorMap = new Map();
  let colorIndex = 0;

  function getCommitColor(hash) {
    if (!commitColorMap.has(hash)) {
      commitColorMap.set(hash, BADGE_COLORS[colorIndex % BADGE_COLORS.length]);
      colorIndex++;
    }
    return commitColorMap.get(hash);
  }

  // ── Message handler ────────────────────────────────────────────────────────

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type !== 'load') return;

    branch = msg.branch || '';
    files = msg.files || [];

    // Reset color assignments so colors are stable within a session
    commitColorMap.clear();
    colorIndex = 0;

    // Pre-assign colors in newest-commit-first order across all files so the
    // same commit always gets the same color regardless of which file renders it first.
    const seen = new Set();
    for (const f of files) {
      for (const c of f.commits) {
        if (!seen.has(c.hash)) {
          seen.add(c.hash);
          getCommitColor(c.hash);
        }
      }
    }

    const label = document.getElementById('branch-label');
    if (label) label.textContent = branch || '';

    render();
  });

  // ── Click delegation ───────────────────────────────────────────────────────

  document.addEventListener('click', e => {
    const row = e.target.closest('[data-file]');
    if (row) {
      vscode.postMessage({ type: 'jumpToFile', file: row.dataset.file });
    }
  });

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const list = document.getElementById('changes-list');
    if (!list) return;

    if (!files.length) {
      list.innerHTML = '<div class="ch-empty">No changes on this branch</div>';
      return;
    }

    list.innerHTML = files.map(renderRow).join('');
  }

  function renderRow(file) {
    const name = file.path.split('/').pop() || file.path;
    const badgesHtml = renderBadges(file.commits);

    const commentHtml = file.commentCount > 0
      ? `<span class="ch-comment-count" title="${file.commentCount} comment${file.commentCount !== 1 ? 's' : ''}">\u{1F4AC}\u00a0${file.commentCount}</span>`
      : '';

    const insHtml = file.insertions > 0 ? `<span class="ch-ins">+${file.insertions}</span>` : '';
    const delHtml = file.deletions  > 0 ? `<span class="ch-del">-${file.deletions}</span>`  : '';
    const statsHtml = (insHtml || delHtml)
      ? `<span class="ch-stats">${insHtml}${insHtml && delHtml ? '\u00a0' : ''}${delHtml}</span>`
      : '';

    return `<div class="ch-row" data-file="${esc(file.path)}" title="${esc(file.path)}">
  <span class="ch-filename">${esc(name)}</span>
  <span class="ch-badges">${badgesHtml}</span>
  <span class="ch-right">${commentHtml}${statsHtml}</span>
</div>`;
  }

  function renderBadges(commits) {
    const visible  = commits.slice(0, MAX_VISIBLE_BADGES);
    const overflow = commits.length - MAX_VISIBLE_BADGES;

    let html = visible.map(c => {
      const color   = getCommitColor(c.hash);
      const tooltip = esc(c.shortHash + ' — ' + c.message);
      return `<span class="ch-badge" style="background:${color}" title="${tooltip}">${esc(c.shortHash)}</span>`;
    }).join('');

    if (overflow > 0) {
      const tip = commits.slice(MAX_VISIBLE_BADGES).map(c => c.shortHash + ' ' + c.message).join('\n');
      html += `<span class="ch-badge ch-badge-more" title="${esc(tip)}">+${overflow}</span>`;
    }

    return html;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}());
