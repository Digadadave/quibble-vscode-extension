(function () {
  const vscode = acquireVsCodeApi();

  // Soft / muted palette — readable with white text, not overly saturated
  const BADGE_COLORS = [
    '#6b9fd6', // soft blue
    '#5fb89a', // soft green
    '#c49a4a', // soft amber
    '#c97878', // soft red
    '#9b82c4', // soft violet
    '#52a8b8', // soft cyan
    '#c4874f', // soft orange
    '#b874a0', // soft pink
  ];

  let files = [];
  let branch = '';
  /** @type {'panel'|'native'} */
  let diffMode = 'panel';
  /** @type {Map<string, string>} commit hash → assigned color */
  const commitColorMap = new Map();
  let colorIndex = 0;
  /** @type {Map<string, object[]>} file path → commits array (for dropdown) */
  const fileCommitsMap = new Map();
  /** @type {HTMLElement|null} */
  let activeDropdown = null;

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

    // Reset color assignments
    commitColorMap.clear();
    colorIndex = 0;

    // Pre-assign colors in newest-commit-first order across all files
    const seen = new Set();
    for (const f of files) {
      for (const c of f.commits) {
        if (!seen.has(c.hash)) {
          seen.add(c.hash);
          getCommitColor(c.hash);
        }
      }
      // Cache commits per file for dropdown
      fileCommitsMap.set(f.path, f.commits);
    }

    const label = document.getElementById('branch-label');
    if (label) label.textContent = branch || '';

    closeDropdown();
    render();
  });

  // ── Diff mode toggle ────────────────────────────────────────────────────────

  document.getElementById('diff-mode-toggle')?.addEventListener('click', () => {
    diffMode = diffMode === 'panel' ? 'native' : 'panel';
    const btn = document.getElementById('diff-mode-toggle');
    if (btn) {
      btn.textContent = diffMode === 'panel' ? 'Native' : 'Panel';
      btn.title = diffMode === 'panel'
        ? 'Currently using DiffPanel — click to switch to native diff'
        : 'Currently using native diff — click to switch to DiffPanel';
    }
  });

  // ── Click delegation ───────────────────────────────────────────────────────

  document.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target);

    // Hash badge click → open commit diff anchored on this file
    const badge = target.closest('.ch-badge-hash');
    if (badge) {
      e.stopPropagation();
      closeDropdown();
      const hash = badge.getAttribute('data-hash');
      const file = badge.closest('[data-file]')?.getAttribute('data-file');
      if (hash && file) {
        vscode.postMessage({ type: 'jumpToCommitFile', hash, file, diffMode });
      }
      return;
    }

    // +N pill click → show dropdown
    const moreBadge = target.closest('.ch-badge-more');
    if (moreBadge) {
      e.stopPropagation();
      const file = moreBadge.closest('[data-file]')?.getAttribute('data-file');
      if (file) showDropdown(moreBadge, file);
      return;
    }

    // Dropdown item click → open commit diff anchored on file
    const ddItem = target.closest('.ch-dropdown-item');
    if (ddItem) {
      e.stopPropagation();
      const hash = ddItem.getAttribute('data-hash');
      const file = ddItem.getAttribute('data-file');
      closeDropdown();
      if (hash && file) {
        vscode.postMessage({ type: 'jumpToCommitFile', hash, file, diffMode });
      }
      return;
    }

    // Close dropdown if clicking anywhere else
    if (activeDropdown && !activeDropdown.contains(target)) {
      closeDropdown();
    }

    // File row click → open accumulated branch diff anchored on this file
    const row = target.closest('.ch-row');
    if (row && row.dataset.file) {
      vscode.postMessage({ type: 'jumpToFile', file: row.dataset.file, diffMode });
    }
  });

  // ── Dropdown ───────────────────────────────────────────────────────────────

  function showDropdown(anchor, filePath) {
    closeDropdown();
    const commits = fileCommitsMap.get(filePath) || [];
    if (!commits.length) return;

    const rect = anchor.getBoundingClientRect();
    const dd = document.createElement('div');
    dd.className = 'ch-dropdown';
    dd.style.top = (rect.bottom + 2) + 'px';
    dd.style.left = Math.max(0, rect.left - 80) + 'px';

    dd.innerHTML = commits.map(c => {
      const color = getCommitColor(c.hash);
      return `<div class="ch-dropdown-item" data-hash="${esc(c.hash)}" data-file="${esc(filePath)}">
  <span class="ch-badge" style="background:${color}">${esc(c.shortHash)}</span>
  <span class="ch-dropdown-msg">${esc(c.message)}</span>
</div>`;
    }).join('');

    document.body.appendChild(dd);
    activeDropdown = dd;
  }

  function closeDropdown() {
    if (activeDropdown) {
      activeDropdown.remove();
      activeDropdown = null;
    }
  }

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
    const badgesHtml = renderBadges(file);

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

  function renderBadges(file) {
    const commits = file.commits;
    if (!commits.length) return '';

    // Show only the latest commit badge
    const latest = commits[0];
    const color  = getCommitColor(latest.hash);
    const tip    = esc(latest.shortHash + ' \u2014 ' + latest.message);
    let html = `<span class="ch-badge ch-badge-hash" style="background:${color}" data-hash="${esc(latest.hash)}" title="${tip}">${esc(latest.shortHash)}</span>`;

    // +N overflow pill (shows total additional commits)
    const extra = commits.length - 1;
    if (extra > 0) {
      const allTip = commits.map(c => c.shortHash + ' ' + c.message).join('\n');
      html += `<span class="ch-badge ch-badge-more" title="${esc(allTip)}">+${extra}</span>`;
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
