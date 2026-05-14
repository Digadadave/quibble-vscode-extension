// @ts-check
/// <reference lib="dom" />
(function () {
  // acquireVsCodeApi() is injected by VS Code into this sandboxed iframe. It returns
  // a proxy with one useful method: vscode.postMessage(payload). This is the ONLY way
  // to send data from the webview back to the extension host (ChangesView.ts).
  // This script has no Node.js access — no file system, no require(), no VS Code API.
  const vscode = acquireVsCodeApi();

  // ── Theme background detection ─────────────────────────────────────────────
  // VS Code resolves --vscode-sideBar-background to a concrete rgb() on the
  // body element. Read it once at startup so icon backgrounds are always the
  // exact opaque color of the sidebar, regardless of theme.
  (function applyRowBg() {
    const bg = getComputedStyle(document.body).backgroundColor;
    document.documentElement.style.setProperty('--ch-row-bg', bg);
    // Hover: read the CSS var and composite it over the opaque base via canvas
    const hoverRaw = getComputedStyle(document.documentElement)
      .getPropertyValue('--vscode-list-hoverBackground').trim();
    // Parse rgba?(r,g,b,a?) from the hover color
    const m = hoverRaw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (m && bg) {
      const bgM = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (bgM) {
        const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
        const r = Math.round(parseInt(m[1]) * a + parseInt(bgM[1]) * (1 - a));
        const g = Math.round(parseInt(m[2]) * a + parseInt(bgM[2]) * (1 - a));
        const b = Math.round(parseInt(m[3]) * a + parseInt(bgM[3]) * (1 - a));
        document.documentElement.style.setProperty('--ch-row-hover-bg', `rgb(${r},${g},${b})`);
      }
    }
  })();

  // ── Search box ─────────────────────────────────────────────────────────────

  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById("ch-search"));
  const searchClear = /** @type {HTMLButtonElement} */ (document.getElementById("ch-search-clear"));

  searchInput.addEventListener("input", () => {
    filterText = searchInput.value.trim().toLowerCase();
    searchClear.hidden = filterText === "";
    visibleCount = PAGE_SIZE;
    render();
  });

  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    filterText = "";
    searchClear.hidden = true;
    visibleCount = PAGE_SIZE;
    render();
  });

  // 20-color muted palette for commit hash badges (consistent order, index 0 first)
  const BADGE_COLORS = [
    "#5b8dd9", // 01 blue
    "#56a86d", // 02 green
    "#c9845a", // 03 orange
    "#9b6bbf", // 04 purple
    "#5aabbb", // 05 teal
    "#c96b6b", // 06 coral
    "#7aaa5a", // 07 lime
    "#c4a43c", // 08 gold
    "#6b8ecc", // 09 periwinkle
    "#a06090", // 10 mauve
    "#4aab9b", // 11 seafoam
    "#cc7a45", // 12 terracotta
    "#7090c0", // 13 steel blue
    "#90a040", // 14 olive
    "#b06060", // 15 rose
    "#5090a0", // 16 slate teal
    "#a07050", // 17 warm brown
    "#8080b0", // 18 lavender
    "#60a870", // 19 sage
    "#b08050", // 20 tan
  ];

  // File-type icon labels + colors (mimics VS Code icon themes)
  const FILE_ICONS = {
    ts: { label: "TS", color: "#3178c6" },
    tsx: { label: "TSX", color: "#3178c6" },
    js: { label: "JS", color: "#f1e05a" },
    jsx: { label: "JSX", color: "#f1e05a" },
    json: { label: "{ }", color: "#a8a800" },
    css: { label: "CSS", color: "#563d7c" },
    scss: { label: "SCSS", color: "#c6538c" },
    html: { label: "HTML", color: "#e34c26" },
    md: { label: "MD", color: "#083fa1" },
    py: { label: "PY", color: "#3572a5" },
    rs: { label: "RS", color: "#dea584" },
    go: { label: "GO", color: "#00add8" },
    java: { label: "JV", color: "#b07219" },
    yaml: { label: "YML", color: "#cb171e" },
    yml: { label: "YML", color: "#cb171e" },
    toml: { label: "TML", color: "#9c4221" },
    xml: { label: "XML", color: "#e34c26" },
    svg: { label: "SVG", color: "#ff9900" },
    sh: { label: "SH", color: "#89e051" },
    lock: { label: "LCK", color: "#555" },
    sqlite: { label: "SQL", color: "#003b57" },
  };
  const DEFAULT_ICON = { label: "F", color: "#888" };

  const ICON_COMMENT     = `<i class="codicon codicon-comment"></i>`;
  const ICON_OPEN_CHANGES = `<i class="codicon codicon-diff-multiple"></i>`;
  const ICON_OPEN_FILE   = `<i class="codicon codicon-go-to-file"></i>`;

  // A/M/D/R status letter colors
  const STATUS_COLORS = {
    A: "var(--vscode-gitDecoration-addedResourceForeground,   #2ea043)",
    M: "var(--vscode-gitDecoration-modifiedResourceForeground, #d29922)",
    D: "var(--vscode-gitDecoration-deletedResourceForeground,  #f85149)",
    R: "var(--vscode-gitDecoration-renamedResourceForeground,  #3fb950)",
  };

  let files = [];
  let branch = "";
  /** @type {'files'|'commits'} */
  let viewMode = "files";
  let filterText = "";
  /** @type {Map<string,string>}  hash → color */
  const commitColorMap = new Map();
  let colorIndex = 0;
  /** @type {Set<string>}  file paths whose commit list is expanded */
  const expandedFiles = new Set();
  /** @type {Set<string>}  commit hashes whose file list is expanded */
  const expandedCommits = new Set();

  const PAGE_SIZE = 20;
  let visibleCount = PAGE_SIZE;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function getCommitColor(hash) {
    if (!commitColorMap.has(hash)) {
      commitColorMap.set(hash, BADGE_COLORS[colorIndex % BADGE_COLORS.length]);
      colorIndex++;
    }
    return commitColorMap.get(hash);
  }

  /** Returns '#000' or '#fff' for readable text on a hex background color. */
  function badgeTextColor(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // Perceived luminance formula
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.55 ? "#000" : "#fff";
  }

  function getFileIcon(filePath) {
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    return FILE_ICONS[ext] || DEFAULT_ICON;
  }

  function getFolder(filePath) {
    const parts = filePath.split("/");
    if (parts.length <= 1) return "";
    const folderParts = parts.slice(0, -1);
    // Show at most 2 levels of parent depth
    return folderParts.length > 2
      ? "\u2026/" + folderParts.slice(-2).join("/")
      : folderParts.join("/");
  }

  /** Show plain number up to 9; show "+9" (with plus) only when capped. */
  function countLabel(extra) {
    return extra > 9 ? "+9" : String(extra);
  }

  // ── Message handler ────────────────────────────────────────────────────────
  // Messages sent from ChangesView.ts via webview.postMessage() arrive here.
  // Protocol: { type: 'load', branch, files } | 'loading' | 'updateCommentCounts' |
  //            'setViewMode' | 'collapseAll'

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "loading") {
      const list = document.getElementById("changes-list");
      if (list) list.innerHTML = '<div class="ch-loading"><span class="ch-spinner"></span></div>';
      return;
    }
    if (msg.type === "setViewMode") {
      setViewMode(msg.mode);
      return;
    }
    if (msg.type === "collapseAll") {
      expandedFiles.clear();
      expandedCommits.clear();
      render();
      return;
    }
    if (msg.type === "setSearchVisible") {
      const box = /** @type {HTMLElement} */ (document.querySelector(".ch-search-box"));
      if (msg.visible) {
        box?.removeAttribute("hidden");
        searchInput?.focus();
      } else {
        box?.setAttribute("hidden", "");
        if (searchInput) searchInput.value = "";
        filterText = "";
        visibleCount = PAGE_SIZE;
        render();
      }
      return;
    }
    if (msg.type !== "load") return;

    branch = msg.branch || "";
    files = msg.files || [];

    // Reset and pre-assign colors in newest-first order across all files
    // so each hash always gets the same slot in the 20-color palette.
    commitColorMap.clear();
    colorIndex = 0;
    const seen = new Set();
    for (const f of files) {
      for (const c of f.commits) {
        if (!seen.has(c.hash)) {
          seen.add(c.hash);
          getCommitColor(c.hash);
        }
      }
    }

    const label = document.getElementById("branch-label");
    if (label) label.textContent = branch || "";

    visibleCount = PAGE_SIZE;
    render();
  });

  // ── View mode (set by native title-bar command via postMessage) ────────────

  function setViewMode(mode) {
    viewMode = mode;
    render();
  }

  // ── Toggle helper ──────────────────────────────────────────────────────────

  function toggleExpand(file) {
    if (expandedFiles.has(file)) {
      expandedFiles.delete(file);
    } else {
      expandedFiles.add(file);
    }
    render();
  }

  // ── Click delegation ───────────────────────────────────────────────────────
  // Single top-level listener handles all clicks via e.target.closest(selector).
  // This is more reliable than per-element listeners on dynamically re-rendered HTML.
  // Each branch sends a postMessage to the extension host and returns early.

  document.addEventListener("click", (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    // ── Commits view: open-file button on a file item ──
    const jumpFile = target.closest(".ch-jump-file");
    if (jumpFile) {
      e.stopPropagation();
      const file = jumpFile.getAttribute("data-file");
      if (file) vscode.postMessage({ type: "jumpToSource", file });
      return;
    }

    // ── Commits view: click a file item → open that commit's diff ──
    const fileItem = target.closest(".ch-file-item");
    if (fileItem) {
      e.stopPropagation();
      const hash = fileItem.getAttribute("data-hash");
      const file = fileItem.getAttribute("data-file");
      if (hash && file)
        vscode.postMessage({ type: "jumpToCommitFile", hash, file });
      return;
    }

    // ── Commits view: open-changes button on commit row ──
    const openChangesBtn = target.closest(".ch-open-changes");
    if (openChangesBtn) {
      e.stopPropagation();
      const hash = openChangesBtn.getAttribute("data-hash");
      if (hash) vscode.postMessage({ type: "openCommitChanges", hash });
      return;
    }

    // ── Commits view: click a commit row → toggle expand ──
    const commitRow = target.closest(".ch-commit-row");
    if (commitRow) {
      e.stopPropagation();
      const hash = commitRow.getAttribute("data-hash");
      if (hash) {
        if (expandedCommits.has(hash)) {
          expandedCommits.delete(hash);
        } else {
          expandedCommits.add(hash);
        }
        render();
      }
      return;
    }

    // ── Files view: jump-to-source button → open file at first changed line ──
    const jumpBtn = target.closest(".ch-jump-source");
    if (jumpBtn) {
      e.stopPropagation();
      const file = jumpBtn.getAttribute("data-file");
      if (file) vscode.postMessage({ type: "jumpToSource", file });
      return;
    }

    // ── Files view: comment badge → focus first comment on this file ──
    const commentBadge = target.closest(".ch-comment-badge");
    if (commentBadge) {
      e.stopPropagation();
      const file = commentBadge
        .closest("[data-file]")
        ?.getAttribute("data-file");
      if (file) vscode.postMessage({ type: "jumpToComment", file });
      return;
    }

    // ── Files view: commit item → open commit diff ──
    const commitItem = target.closest(".ch-commit-item");
    if (commitItem) {
      e.stopPropagation();
      const hash = commitItem.getAttribute("data-hash");
      const file = commitItem.closest("[data-file]")?.getAttribute("data-file");
      if (hash && file)
        vscode.postMessage({ type: "jumpToCommitFile", hash, file });
      return;
    }

    // ── Files view: hash/count badge in file row → toggle expand ──
    const rowBadge = target.closest(".ch-badge-hash, .ch-badge-more");
    if (rowBadge) {
      e.stopPropagation();
      const file = rowBadge.closest("[data-file]")?.getAttribute("data-file");
      if (file) toggleExpand(file);
      return;
    }

    // ── Files view: file row click → collapse + open cumulative diff ──
    const row = target.closest(".ch-row");
    if (row && row.dataset.file) {
      const file = row.dataset.file;
      expandedFiles.delete(file);
      render();
      vscode.postMessage({ type: "jumpToFile", file });
    }
  });

  // ── Render ─────────────────────────────────────────────────────────────────

  function pathMatchesFilter(path) {
    return path.toLowerCase().includes(filterText);
  }

  function getFilteredFiles() {
    if (!filterText) return files;
    return files.filter(f => pathMatchesFilter(f.path));
  }

  function render() {
    const list = document.getElementById("changes-list");
    if (!list) return;

    if (!files.length) {
      list.innerHTML = '<div class="ch-empty">No changes on this branch</div>';
      return;
    }

    if (viewMode === "commits") {
      renderCommitView(list);
      return;
    }

    const filteredFiles = getFilteredFiles();
    if (filterText && !filteredFiles.length) {
      list.innerHTML = '<div class="ch-empty">No matching files</div>';
      return;
    }

    const visible = filteredFiles.slice(0, visibleCount);
    const remaining = filteredFiles.length - visibleCount;
    const moreHtml =
      remaining > 0
        ? `<div class="ch-load-more" id="ch-load-more">Load ${Math.min(remaining, PAGE_SIZE)} more of ${remaining} remaining</div>`
        : "";

    list.innerHTML = visible.map(renderFileBlock).join("") + moreHtml;
  }

  // ── Commits view ───────────────────────────────────────────────────────────

  /** Invert the files-by-commit structure into commits-by-file. */
  function buildCommitData() {
    /** @type {Map<string, {hash:string, shortHash:string, message:string, files:object[]}>} */
    const commitMap = new Map();
    for (const file of files) {
      for (const c of file.commits) {
        if (!commitMap.has(c.hash)) {
          commitMap.set(c.hash, {
            hash: c.hash,
            shortHash: c.shortHash,
            message: c.message,
            files: [],
          });
        }
        commitMap.get(c.hash).files.push({
          path: file.path,
          status: file.status,
          insertions: c.insertions,
          deletions: c.deletions,
          commentCount: file.commentCount || 0,
        });
      }
    }
    return [...commitMap.values()];
  }

  function renderCommitView(list) {
    let commits = buildCommitData();
    if (filterText) {
      commits = commits
        .map(c => ({ ...c, files: c.files.filter(f => pathMatchesFilter(f.path)) }))
        .filter(c => c.files.length > 0);
    }
    if (filterText && !commits.length) {
      list.innerHTML = '<div class="ch-empty">No matching files</div>';
      return;
    }
    list.innerHTML = commits.map(c => renderCommitBlock(c, !!filterText)).join("");
  }

  function renderCommitBlock(commit, forceExpand = false) {
    const color = getCommitColor(commit.hash);
    const tColor = badgeTextColor(color);
    const isExpanded = forceExpand || expandedCommits.has(commit.hash);

    const totalIns = commit.files.reduce((s, f) => s + f.insertions, 0);
    const totalDel = commit.files.reduce((s, f) => s + f.deletions, 0);
    const ins = totalIns > 0 ? `<span class="ch-ins">+${totalIns}</span>` : "";
    const del = totalDel > 0 ? `<span class="ch-del">-${totalDel}</span>` : "";
    const statsHtml =
      ins || del ? `<span class="ch-stats">${del}${ins}</span>` : "";

    const rowHtml =
      `<div class="ch-commit-row${isExpanded ? " ch-expanded" : ""}" data-hash="${esc(commit.hash)}">` +
      `<span class="ch-badge ch-badge-hash" style="background:${color};color:${tColor}">${esc(commit.shortHash)}</span>` +
      `<span class="ch-commit-msg" title="${esc(commit.message)}">${esc(commit.message)}</span>` +
      `<span class="ch-open-changes" data-hash="${esc(commit.hash)}" title="Open Changes">${ICON_OPEN_CHANGES}</span>` +
      statsHtml +
      `</div>`;

    let fileListHtml = "";
    if (isExpanded) {
      fileListHtml =
        '<div class="ch-file-list">' +
        commit.files.map((f) => renderFileItem(f, commit.hash)).join("") +
        "</div>";
    }

    return `<div class="ch-commit-block" data-hash="${esc(commit.hash)}">${rowHtml}${fileListHtml}</div>`;
  }

  function renderFileItem(file, commitHash) {
    const name = file.path.split("/").pop() || file.path;
    const folder = getFolder(file.path);
    const icon = getFileIcon(file.path);
    const statusColor = STATUS_COLORS[file.status] || STATUS_COLORS.M;

    const ins =
      file.insertions > 0
        ? `<span class="ch-ins">+${file.insertions}</span>`
        : "";
    const del =
      file.deletions > 0
        ? `<span class="ch-del">-${file.deletions}</span>`
        : "";
    const statsHtml =
      ins || del ? `<span class="ch-commit-stats">${del}${ins}</span>` : "";

    const iconHtml = `<span class="ch-file-icon" style="color:${icon.color}">${esc(icon.label)}</span>`;
    const nameHtml = `<span class="ch-filename">${esc(name)}</span>`;
    const folderHtml = folder
      ? `<span class="ch-folder">${esc(folder)}</span>`
      : "";
    const statusHtml = `<span class="ch-status" style="color:${statusColor}">${esc(file.status)}</span>`;
    const jumpHtml = `<span class="ch-jump-file" data-file="${esc(file.path)}" title="Open File">${ICON_OPEN_FILE}</span>`;

    return (
      `<div class="ch-file-item" data-hash="${esc(commitHash)}" data-file="${esc(file.path)}">` +
      iconHtml +
      `<span class="ch-file-label">${nameHtml}${folderHtml}</span>` +
      jumpHtml +
      statsHtml +
      statusHtml +
      `</div>`
    );
  }

  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest("#ch-load-more")) {
        visibleCount += PAGE_SIZE;
        render();
      }
    },
    true,
  ); // capture so it fires before the general delegation below

  function renderFileBlock(file) {
    const name = file.path.split("/").pop() || file.path;
    const folder = getFolder(file.path);
    const icon = getFileIcon(file.path);
    const isExpanded = expandedFiles.has(file.path);

    // ── File type icon
    const iconHtml = `<span class="ch-file-icon" style="color:${icon.color}">${esc(icon.label)}</span>`;

    // ── Filename
    const nameHtml = `<span class="ch-filename">${esc(name)}</span>`;

    // ── Folder label
    const folderHtml = folder
      ? `<span class="ch-folder">${esc(folder)}</span>`
      : "";

    // ── Comment badge — RIGHT of folder
    const commentHtml =
      file.commentCount > 0
        ? `<span class="ch-comment-badge" title="${file.commentCount} comment${file.commentCount !== 1 ? "s" : ""}">` +
          ICON_COMMENT +
          `\u00a0${file.commentCount}</span>`
        : "";

    // ── Right-side badges: [+/- stats] [hash] [count] [status]
    const ins =
      file.insertions > 0
        ? `<span class="ch-ins">+${file.insertions}</span>`
        : "";
    const del =
      file.deletions > 0
        ? `<span class="ch-del">-${file.deletions}</span>`
        : "";
    const statsHtml =
      ins || del ? `<span class="ch-stats">${del}${ins}</span>` : "";

    const rowBadgesHtml = renderRowBadges(file);

    const statusColor = STATUS_COLORS[file.status] || STATUS_COLORS.M;
    const statusHtml = `<span class="ch-status" style="color:${statusColor}">${esc(file.status)}</span>`;

    // ── Expanded commit list (hash | message | +/-)
    let expandedHtml = "";
    if (isExpanded && file.commits.length > 0) {
      expandedHtml =
        '<div class="ch-commit-list">' +
        file.commits
          .map((c) => {
            const color = getCommitColor(c.hash);
            const tColor = badgeTextColor(color);
            const cIns =
              c.insertions > 0
                ? `<span class="ch-ins">+${c.insertions}</span>`
                : "";
            const cDel =
              c.deletions > 0
                ? `<span class="ch-del">-${c.deletions}</span>`
                : "";
            const cStats =
              cIns || cDel
                ? `<span class="ch-commit-stats">${cDel}${cIns}</span>`
                : '<span class="ch-commit-stats"></span>';
            return (
              `<div class="ch-commit-item" data-hash="${esc(c.hash)}" data-file="${esc(file.path)}">` +
              `<span class="ch-badge ch-badge-hash" style="background:${color};color:${tColor}" data-hash="${esc(c.hash)}">${esc(c.shortHash)}</span>` +
              `<span class="ch-commit-msg" title="${esc(c.message)}">${esc(c.message)}</span>` +
              cStats +
              `</div>`
            );
          })
          .join("") +
        "</div>";
    }

    const jumpHtml = `<span class="ch-jump-source" data-action="jump-source" data-file="${esc(file.path)}" title="Open File">${ICON_OPEN_FILE}</span>`;

    return (
      `<div class="ch-file-block${isExpanded ? " ch-expanded" : ""}" data-file="${esc(file.path)}">` +
      `<div class="ch-row" data-file="${esc(file.path)}" title="${esc(file.path)}">` +
      rowBadgesHtml +
      iconHtml +
      `<span class="ch-file-label">${nameHtml}${folderHtml}${commentHtml}</span>` +
      jumpHtml +
      statsHtml +
      statusHtml +
      `</div>` +
      expandedHtml +
      `</div>`
    );
  }

  /** File-row right side: [hash badge] [total count badge] */
  function renderRowBadges(file) {
    const commits = file.commits;
    if (!commits.length) return "";

    const latest = commits[0];
    const color = getCommitColor(latest.hash);
    const textColor = badgeTextColor(color);
    const tip = esc(`${latest.shortHash} \u2014 ${latest.message}`);
    let html = `<span class="ch-badge ch-badge-hash" style="background:${color};color:${textColor}" data-hash="${esc(latest.hash)}" title="${tip}">${esc(latest.shortHash)}</span>`;

    const total = commits.length;
    if (total > 1) {
      const label = total > 9 ? "+9" : String(total);
      const tip2 = `${total} commit${total !== 1 ? "s" : ""}`;
      html += `<span class="ch-badge ch-badge-more ch-badge-count" title="${tip2}">${label}</span>`;
    } else {
      html += `<span class="ch-badge ch-badge-count" style="visibility:hidden" aria-hidden="true">1</span>`;
    }

    return html;
  }
})();
