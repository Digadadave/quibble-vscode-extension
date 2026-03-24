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

  // File-type icon colors (mimics VS Code icon themes)
  const FILE_ICONS = {
    ts:    { label: 'TS',   color: '#3178c6' },
    tsx:   { label: 'TSX',  color: '#3178c6' },
    js:    { label: 'JS',   color: '#f1e05a' },
    jsx:   { label: 'JSX',  color: '#f1e05a' },
    json:  { label: '{ }',  color: '#a8a800' },
    css:   { label: 'CSS',  color: '#563d7c' },
    scss:  { label: 'SCSS', color: '#c6538c' },
    html:  { label: 'HTML', color: '#e34c26' },
    md:    { label: 'MD',   color: '#083fa1' },
    py:    { label: 'PY',   color: '#3572a5' },
    rs:    { label: 'RS',   color: '#dea584' },
    go:    { label: 'GO',   color: '#00add8' },
    java:  { label: 'JV',   color: '#b07219' },
    yaml:  { label: 'YML',  color: '#cb171e' },
    yml:   { label: 'YML',  color: '#cb171e' },
    toml:  { label: 'TML',  color: '#9c4221' },
    xml:   { label: 'XML',  color: '#e34c26' },
    svg:   { label: 'SVG',  color: '#ff9900' },
    sh:    { label: 'SH',   color: '#89e051' },
    lock:  { label: 'LCK',  color: '#555' },
    sqlite:{ label: 'SQL',  color: '#003b57' },
  };
  const DEFAULT_ICON = { label: 'F', color: '#888' };

  // Status letter colors (A/M/D/R)
  const STATUS_COLORS = {
    A: 'var(--vscode-gitDecoration-addedResourceForeground, #2ea043)',
    M: 'var(--vscode-gitDecoration-modifiedResourceForeground, #d29922)',
    D: 'var(--vscode-gitDecoration-deletedResourceForeground, #f85149)',
    R: 'var(--vscode-gitDecoration-renamedResourceForeground, #3fb950)',
  };

  let files = [];
  let branch = '';
  /** @type {'panel'|'native'} */
  let diffMode = 'panel';
  /** @type {Map<string, string>} commit hash -> assigned color */
  const commitColorMap = new Map();
  let colorIndex = 0;
  /** @type {Set<string>} file paths with expanded commit lists */
  const expandedFiles = new Set();

  function getCommitColor(hash) {
    if (!commitColorMap.has(hash)) {
      commitColorMap.set(hash, BADGE_COLORS[colorIndex % BADGE_COLORS.length]);
      colorIndex++;
    }
    return commitColorMap.get(hash);
  }

  function getFileIcon(filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return FILE_ICONS[ext] || DEFAULT_ICON;
  }

  function getFolderName(filePath) {
    const parts = filePath.split('/');
    if (parts.length <= 1) return '';
    return parts.slice(0, -1).join('/');
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
    }

    const label = document.getElementById('branch-label');
    if (label) label.textContent = branch || '';

    render();
  });

  // ── Diff mode toggle ──────────────────────────────────────────────────────

  const toggle = document.getElementById('diff-mode-toggle');
  if (toggle) {
    toggle.addEventListener('change', () => {
      diffMode = toggle.checked ? 'native' : 'panel';
    });
  }

  // ── Click delegation ───────────────────────────────────────────────────────

  document.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target);

    // Hash badge click (in row OR in expanded list) -> open commit diff anchored on this file
    const badge = target.closest('.ch-badge-hash');
    if (badge) {
      e.stopPropagation();
      const hash = badge.getAttribute('data-hash');
      const file = badge.closest('[data-file]')?.getAttribute('data-file');
      if (hash && file) {
        vscode.postMessage({ type: 'jumpToCommitFile', hash, file, diffMode });
      }
      return;
    }

    // +N pill click -> toggle expanded commit list
    const moreBadge = target.closest('.ch-badge-more');
    if (moreBadge) {
      e.stopPropagation();
      const file = moreBadge.closest('[data-file]')?.getAttribute('data-file');
      if (file) {
        if (expandedFiles.has(file)) {
          expandedFiles.delete(file);
        } else {
          expandedFiles.add(file);
        }
        render();
      }
      return;
    }

    // Expanded commit list item click -> open commit diff
    const commitItem = target.closest('.ch-commit-item');
    if (commitItem) {
      e.stopPropagation();
      const hash = commitItem.getAttribute('data-hash');
      const file = commitItem.closest('[data-file]')?.getAttribute('data-file');
      if (hash && file) {
        vscode.postMessage({ type: 'jumpToCommitFile', hash, file, diffMode });
      }
      return;
    }

    // File row click (on the row itself, not badges) -> open accumulated branch diff
    const row = target.closest('.ch-row');
    if (row && row.dataset.file) {
      vscode.postMessage({ type: 'jumpToFile', file: row.dataset.file, diffMode });
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

    list.innerHTML = files.map(renderFileBlock).join('');
  }

  function renderFileBlock(file) {
    const name = file.path.split('/').pop() || file.path;
    const folder = getFolderName(file.path);
    const icon = getFileIcon(file.path);
    const isExpanded = expandedFiles.has(file.path);

    // File type icon
    const iconHtml = `<span class="ch-file-icon" style="color:${icon.color}">${esc(icon.label)}</span>`;

    // Filename
    const nameHtml = `<span class="ch-filename">${esc(name)}</span>`;

    // Comment badge right after filename
    const commentHtml = file.commentCount > 0
      ? `<span class="ch-comment-badge" title="${file.commentCount} comment${file.commentCount !== 1 ? 's' : ''}"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v8A1.5 1.5 0 0113.5 12H9l-3.5 3.5V12H2.5A1.5 1.5 0 011 10.5v-8z"/></svg>${file.commentCount}</span>`
      : '';

    // Folder label
    const folderHtml = folder
      ? `<span class="ch-folder">${esc(folder)}</span>`
      : '';

    // Latest commit badge
    const badgesHtml = renderBadges(file);

    // +/- stats
    const insHtml = file.insertions > 0 ? `<span class="ch-ins">+${file.insertions}</span>` : '';
    const delHtml = file.deletions  > 0 ? `<span class="ch-del">-${file.deletions}</span>` : '';
    const statsHtml = (insHtml || delHtml)
      ? `<span class="ch-stats">${insHtml}${insHtml && delHtml ? '\u00a0' : ''}${delHtml}</span>`
      : '';

    // A/M/D status on far right
    const statusColor = STATUS_COLORS[file.status] || STATUS_COLORS.M;
    const statusHtml = `<span class="ch-status" style="color:${statusColor}">${esc(file.status)}</span>`;

    // Expanded commit list
    let expandedHtml = '';
    if (isExpanded && file.commits.length > 0) {
      expandedHtml = `<div class="ch-commit-list" data-file="${esc(file.path)}">` +
        file.commits.map((c, i) => {
          const color = getCommitColor(c.hash);
          const isLast = i === file.commits.length - 1;
          const connector = isLast ? '\u2514' : '\u251c';
          return `<div class="ch-commit-item" data-hash="${esc(c.hash)}" data-file="${esc(file.path)}">
  <span class="ch-commit-connector">${connector}</span>
  <span class="ch-badge ch-badge-hash" style="background:${color}" data-hash="${esc(c.hash)}">${esc(c.shortHash)}</span>
  <span class="ch-commit-msg">${esc(c.message)}</span>
</div>`;
        }).join('') + '</div>';
    }

    return `<div class="ch-file-block${isExpanded ? ' ch-expanded' : ''}" data-file="${esc(file.path)}">
  <div class="ch-row" data-file="${esc(file.path)}" title="${esc(file.path)}">
    ${iconHtml}
    ${nameHtml}
    ${commentHtml}
    ${folderHtml}
    <span class="ch-spacer"></span>
    ${badgesHtml}
    ${statsHtml}
    ${statusHtml}
  </div>
  ${expandedHtml}
</div>`;
  }

  function renderBadges(file) {
    const commits = file.commits;
    if (!commits.length) return '';

    const latest = commits[0];
    const color  = getCommitColor(latest.hash);
    const tip    = esc(latest.shortHash + ' \u2014 ' + latest.message);
    let html = `<span class="ch-badge ch-badge-hash" style="background:${color}" data-hash="${esc(latest.hash)}" title="${tip}">${esc(latest.shortHash)}</span>`;

    const extra = commits.length - 1;
    if (extra > 0) {
      html += `<span class="ch-badge ch-badge-more" title="Show all ${commits.length} commits">+${extra}</span>`;
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
