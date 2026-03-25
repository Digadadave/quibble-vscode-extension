(function () {
  const vscode = acquireVsCodeApi();

  // 20-color muted palette for commit hash badges (consistent order, index 0 first)
  const BADGE_COLORS = [
    '#5b8dd9', // 01 blue
    '#56a86d', // 02 green
    '#c9845a', // 03 orange
    '#9b6bbf', // 04 purple
    '#5aabbb', // 05 teal
    '#c96b6b', // 06 coral
    '#7aaa5a', // 07 lime
    '#c4a43c', // 08 gold
    '#6b8ecc', // 09 periwinkle
    '#a06090', // 10 mauve
    '#4aab9b', // 11 seafoam
    '#cc7a45', // 12 terracotta
    '#7090c0', // 13 steel blue
    '#90a040', // 14 olive
    '#b06060', // 15 rose
    '#5090a0', // 16 slate teal
    '#a07050', // 17 warm brown
    '#8080b0', // 18 lavender
    '#60a870', // 19 sage
    '#b08050', // 20 tan
  ];

  // File-type icon labels + colors (mimics VS Code icon themes)
  const FILE_ICONS = {
    ts:     { label: 'TS',   color: '#3178c6' },
    tsx:    { label: 'TSX',  color: '#3178c6' },
    js:     { label: 'JS',   color: '#f1e05a' },
    jsx:    { label: 'JSX',  color: '#f1e05a' },
    json:   { label: '{ }',  color: '#a8a800' },
    css:    { label: 'CSS',  color: '#563d7c' },
    scss:   { label: 'SCSS', color: '#c6538c' },
    html:   { label: 'HTML', color: '#e34c26' },
    md:     { label: 'MD',   color: '#083fa1' },
    py:     { label: 'PY',   color: '#3572a5' },
    rs:     { label: 'RS',   color: '#dea584' },
    go:     { label: 'GO',   color: '#00add8' },
    java:   { label: 'JV',   color: '#b07219' },
    yaml:   { label: 'YML',  color: '#cb171e' },
    yml:    { label: 'YML',  color: '#cb171e' },
    toml:   { label: 'TML',  color: '#9c4221' },
    xml:    { label: 'XML',  color: '#e34c26' },
    svg:    { label: 'SVG',  color: '#ff9900' },
    sh:     { label: 'SH',   color: '#89e051' },
    lock:   { label: 'LCK',  color: '#555'    },
    sqlite: { label: 'SQL',  color: '#003b57' },
  };
  const DEFAULT_ICON = { label: 'F', color: '#888' };

  // A/M/D/R status letter colors
  const STATUS_COLORS = {
    A: 'var(--vscode-gitDecoration-addedResourceForeground,   #2ea043)',
    M: 'var(--vscode-gitDecoration-modifiedResourceForeground, #d29922)',
    D: 'var(--vscode-gitDecoration-deletedResourceForeground,  #f85149)',
    R: 'var(--vscode-gitDecoration-renamedResourceForeground,  #3fb950)',
  };

  let files     = [];
  let branch    = '';
  /** @type {'panel'|'native'} */
  let diffMode  = 'panel';
  /** @type {Map<string,string>}  hash → color */
  const commitColorMap = new Map();
  let colorIndex = 0;
  /** @type {Set<string>}  file paths whose commit list is expanded */
  const expandedFiles = new Set();

  // ── Helpers ────────────────────────────────────────────────────────────────

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

  function getFolder(filePath) {
    const parts = filePath.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  }

  /** Cap extra-commit count display at 9; always renders with the same width. */
  function countLabel(extra) {
    return '+' + Math.min(extra, 9);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Message handler ────────────────────────────────────────────────────────

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type !== 'load') return;

    branch = msg.branch || '';
    files  = msg.files  || [];

    // Reset and pre-assign colors in newest-first order across all files
    // so each hash always gets the same slot in the 20-color palette.
    commitColorMap.clear();
    colorIndex = 0;
    const seen = new Set();
    for (const f of files) {
      for (const c of f.commits) {
        if (!seen.has(c.hash)) { seen.add(c.hash); getCommitColor(c.hash); }
      }
    }

    const label = document.getElementById('branch-label');
    if (label) label.textContent = branch || '';

    render();
  });

  // ── Diff mode toggle ───────────────────────────────────────────────────────

  const toggle = document.getElementById('diff-mode-toggle');
  if (toggle) {
    toggle.addEventListener('change', () => {
      diffMode = toggle.checked ? 'native' : 'panel';
    });
  }

  // ── Toggle helper ──────────────────────────────────────────────────────────

  function toggleExpand(file) {
    if (expandedFiles.has(file)) { expandedFiles.delete(file); }
    else                         { expandedFiles.add(file);    }
    render();
  }

  // ── Click delegation ───────────────────────────────────────────────────────

  document.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target);

    // Comment badge → focus first comment on this file
    const commentBadge = target.closest('.ch-comment-badge');
    if (commentBadge) {
      e.stopPropagation();
      const file = commentBadge.closest('[data-file]')?.getAttribute('data-file');
      if (file) vscode.postMessage({ type: 'jumpToComment', file, diffMode });
      return;
    }

    // Hash badge INSIDE a commit-list item → open commit diff (list stays open)
    const commitItem = target.closest('.ch-commit-item');
    if (commitItem) {
      e.stopPropagation();
      const hash = commitItem.getAttribute('data-hash');
      const file = commitItem.closest('[data-file]')?.getAttribute('data-file');
      if (hash && file) vscode.postMessage({ type: 'jumpToCommitFile', hash, file, diffMode });
      return;
    }

    // Hash badge OR count badge IN the file row → toggle expand (no navigation)
    const rowBadge = target.closest('.ch-badge-hash, .ch-badge-more');
    if (rowBadge) {
      e.stopPropagation();
      const file = rowBadge.closest('[data-file]')?.getAttribute('data-file');
      if (file) toggleExpand(file);
      return;
    }

    // File row click → collapse list then open cumulative branch diff
    const row = target.closest('.ch-row');
    if (row && row.dataset.file) {
      const file = row.dataset.file;
      expandedFiles.delete(file);
      render();
      vscode.postMessage({ type: 'jumpToFile', file, diffMode });
    }
  });

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const list = document.getElementById('changes-list');
    if (!list) return;
    list.innerHTML = files.length
      ? files.map(renderFileBlock).join('')
      : '<div class="ch-empty">No changes on this branch</div>';
  }

  function renderFileBlock(file) {
    const name       = file.path.split('/').pop() || file.path;
    const folder     = getFolder(file.path);
    const icon       = getFileIcon(file.path);
    const isExpanded = expandedFiles.has(file.path);

    // ── File type icon
    const iconHtml = `<span class="ch-file-icon" style="color:${icon.color}">${esc(icon.label)}</span>`;

    // ── Filename
    const nameHtml = `<span class="ch-filename">${esc(name)}</span>`;

    // ── Folder label
    const folderHtml = folder ? `<span class="ch-folder">${esc(folder)}</span>` : '';

    // ── Comment badge — RIGHT of folder
    const commentHtml = file.commentCount > 0
      ? `<span class="ch-comment-badge" title="${file.commentCount} comment${file.commentCount !== 1 ? 's' : ''}">`
        + `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v8A1.5 1.5 0 0113.5 12H9l-3.5 3.5V12H2.5A1.5 1.5 0 011 10.5v-8z"/></svg>`
        + `\u00a0${file.commentCount}</span>`
      : '';

    // ── Right-side badges: [+/- stats] [hash] [count] [status]
    const ins = file.insertions > 0 ? `<span class="ch-ins">+${file.insertions}</span>` : '';
    const del = file.deletions  > 0 ? `<span class="ch-del">-${file.deletions}</span>`  : '';
    const statsHtml = (ins || del) ? `<span class="ch-stats">${ins}${ins && del ? '\u00a0' : ''}${del}</span>` : '';

    const rowBadgesHtml = renderRowBadges(file);

    const statusColor = STATUS_COLORS[file.status] || STATUS_COLORS.M;
    const statusHtml  = `<span class="ch-status" style="color:${statusColor}">${esc(file.status)}</span>`;

    // ── Expanded commit list (hash | message | +/-)
    let expandedHtml = '';
    if (isExpanded && file.commits.length > 0) {
      expandedHtml = '<div class="ch-commit-list">'
        + file.commits.map(c => {
          const color    = getCommitColor(c.hash);
          const cIns     = c.insertions > 0 ? `<span class="ch-ins">+${c.insertions}</span>` : '';
          const cDel     = c.deletions  > 0 ? `<span class="ch-del">-${c.deletions}</span>`  : '';
          const cStats   = (cIns || cDel) ? `<span class="ch-commit-stats">${cIns}${cIns && cDel ? '\u00a0' : ''}${cDel}</span>` : '<span class="ch-commit-stats"></span>';
          return `<div class="ch-commit-item" data-hash="${esc(c.hash)}" data-file="${esc(file.path)}">`
            + `<span class="ch-badge ch-badge-hash" style="background:${color}" data-hash="${esc(c.hash)}">${esc(c.shortHash)}</span>`
            + `<span class="ch-commit-msg">${esc(c.message)}</span>`
            + cStats
            + `</div>`;
        }).join('')
        + '</div>';
    }

    return `<div class="ch-file-block${isExpanded ? ' ch-expanded' : ''}" data-file="${esc(file.path)}">`
      + `<div class="ch-row" data-file="${esc(file.path)}" title="${esc(file.path)}">`
      + iconHtml + nameHtml + folderHtml + commentHtml
      + `<span class="ch-spacer"></span>`
      + statsHtml + rowBadgesHtml + statusHtml
      + `</div>`
      + expandedHtml
      + `</div>`;
  }

  /** File-row right side: [hash badge] [count badge — fixed width, max +9] */
  function renderRowBadges(file) {
    const commits = file.commits;
    if (!commits.length) return '';

    const latest = commits[0];
    const color  = getCommitColor(latest.hash);
    const tip    = esc(`${latest.shortHash} \u2014 ${latest.message}`);
    let html = `<span class="ch-badge ch-badge-hash" style="background:${color}" data-hash="${esc(latest.hash)}" title="${tip}">${esc(latest.shortHash)}</span>`;

    const extra = commits.length - 1;
    if (extra > 0) {
      const label = countLabel(extra);
      const tip2  = extra > 9 ? `${extra} more commits` : `${extra} more commit${extra > 1 ? 's' : ''}`;
      html += `<span class="ch-badge ch-badge-more ch-badge-count" title="${tip2}">${label}</span>`;
    }

    return html;
  }

}());
