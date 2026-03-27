import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './GitService';
import { CommentManager, ReviewComment } from './CommentManager';
import { ICONS, buildStatusCssVars } from './icons';

export class DiffPanel implements vscode.Disposable {
  static readonly viewType = 'commitReview.diff';
  private static instance: DiffPanel | undefined;

  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  /** Hashes currently displayed; kept so comment refreshes can resend them. */
  private currentHashes: string[] = [];
  private gitUserName = 'reviewer';
  private repoName = '';
  private repoCount = 1;

  /** Called by extension after any comment mutation, to refresh both panels. */
  onCommentMutation?: () => void;
  /** Called when the user clicks the repo-selector button in the top bar. */
  onSelectRepo?: () => void;

  private constructor(
    private context: vscode.ExtensionContext,
    private git: GitService,
    private comments: CommentManager
  ) {
    this.panel = vscode.window.createWebviewPanel(
      DiffPanel.viewType,
      'Commit Review',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
        retainContextWhenHidden: true,
      }
    );

    this.gitUserName = this.git.getUserName();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg), null, this.disposables);
    this.panel.webview.html = this.buildHtml();
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  static createOrShow(
    context: vscode.ExtensionContext,
    git: GitService,
    comments: CommentManager
  ): DiffPanel {
    if (DiffPanel.instance) {
      DiffPanel.instance.git = git;
      DiffPanel.instance.comments = comments;
      DiffPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return DiffPanel.instance;
    }
    const p = new DiffPanel(context, git, comments);
    DiffPanel.instance = p;
    return p;
  }

  static getInstance(): DiffPanel | undefined {
    return DiffPanel.instance;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  getCurrentHashes(): string[] {
    return this.currentHashes;
  }

  /** Called when the sidebar selection changes. Computes and sends the diff. */
  showSelection(hashes: string[]): void {
    this.currentHashes = hashes;
    this.panel.reveal(vscode.ViewColumn.One, false);
    this.sendDiffForHashes(hashes);
  }

  /** Show the cumulative branch diff (merge-base → HEAD) for all files. */
  showBranchDiff(baseHash: string, headHash: string, branchHashes: string[]): void {
    this.currentHashes = branchHashes;
    this.panel.reveal(vscode.ViewColumn.One, false);

    const rawDiff      = this.git.getDirectDiff(baseHash, headHash);
    const parsedDiff   = this.git.parseDiff(rawDiff);
    const changedFiles = this.git.getDirectChangedFiles(baseHash, headHash);

    this.panel.webview.postMessage({
      type: 'diffResult',
      parsedDiff,
      changedFiles,
      selectedHashes: branchHashes,
      comments: this.comments.load(),
      oldestShort: baseHash.slice(0, 7),
      newestShort: headHash.slice(0, 7),
      gitUserName: this.gitUserName,
      repoName:    this.repoName,
      repoCount:   this.repoCount,
    });
  }

  /** Update the repo label / count shown in the top bar. */
  /** Show loading state immediately (call before slow work begins). */
  showLoading(): void {
    this.panel.webview.postMessage({ type: 'loading' });
  }

  setRepoInfo(repoName: string, repoCount: number): void {
    this.repoName  = repoName;
    this.repoCount = repoCount;
    this.panel.webview.postMessage({ type: 'repoInfo', repoName, repoCount });
  }

  /** Refresh comments without recomputing the diff (called after mutations). */
  refreshComments(): void {
    this.panel.webview.postMessage({
      type: 'load',
      comments: this.comments.load(),
      selectedHashes: this.currentHashes,
      gitUserName: this.gitUserName,
      repoName:    this.repoName,
      repoCount:   this.repoCount,
    });
  }

  /** Forward a focusFile message from the sidebar. */
  focusFile(file: string): void {
    this.panel.webview.postMessage({ type: 'focusFile', file });
  }

  private pendingFocusId: string | null = null;

  /**
   * Open the diff for the given commit and, once rendered, scroll to the
   * thread row for `commentId`.
   */
  focusComment(commentId: string, commitHash: string): void {
    this.pendingFocusId = commentId;
    // If the diff already covers this commit, just scroll immediately.
    if (commitHash && this.currentHashes.includes(commitHash)) {
      this.panel.reveal(vscode.ViewColumn.One, false);
      this.panel.webview.postMessage({ type: 'focusComment', id: commentId });
      this.pendingFocusId = null;
    } else if (commitHash) {
      // Switch to the right commit — pendingFocusId will ride along in diffResult.
      this.showSelection([commitHash]);
    } else {
      // No commit info — just try to scroll in whatever is already shown.
      this.panel.reveal(vscode.ViewColumn.One, false);
      this.panel.webview.postMessage({ type: 'focusComment', id: commentId });
      this.pendingFocusId = null;
    }
  }

  /** Update services when the active repo changes. */
  updateServices(git: GitService, comments: CommentManager): void {
    this.git = git;
    this.comments = comments;
    this.gitUserName = this.git.getUserName();
    this.currentHashes = [];
    this.panel.webview.postMessage({ type: 'diffResult', parsedDiff: [], changedFiles: [], selectedHashes: [] });
  }

  // ── Message handler ───────────────────────────────────────────────────────

  private handleMessage(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'addComment':
        this.comments.addComment({
          commitHash:  msg.commitHash as string,
          file:        msg.file       as string,
          line:        msg.line       as number,
          lineEnd:     (msg.lineEnd   as number | undefined) || undefined,
          body:        msg.body       as string,
          // Prefer the user's highlighted text; fall back to git file content
          codeSnippet: (msg.snippet as string)
            || this.extractSnippet(msg.commitHash as string, msg.file as string, msg.line as number),
        });
        this.onCommentMutation?.();
        break;

      case 'updateStatus': {
        const status = msg.status as ReviewComment['status'];
        this.comments.updateStatus(msg.id as string, status);
        this.onCommentMutation?.();
        break;
      }

      case 'deleteComment':
        this.comments.deleteComment(msg.id as string);
        this.onCommentMutation?.();
        break;

      case 'addReply':
        this.comments.addThreadReply(msg.id as string, 'reviewer', msg.body as string);
        this.onCommentMutation?.();
        break;

      case 'copyAgentPrompt':
        this.copyAgentPrompt();
        break;

      case 'selectRepo':
        this.onSelectRepo?.();
        break;

      case 'exportReviews': {
        const filePath = this.comments.getReviewsFilePath();
        vscode.workspace.openTextDocument(filePath).then(doc =>
          vscode.window.showTextDocument(doc)
        );
        break;
      }

      case 'fetchContext': {
        const commitHash = msg.commitHash as string;
        const file       = msg.file       as string;
        const newStart   = msg.newStart   as number;
        const newEnd     = msg.newEnd     as number;
        const oldStart   = msg.oldStart   as number;
        const direction  = msg.direction  as string;
        const key        = msg.key        as string;
        try {
          const content  = this.git.getFileContentAtCommit(commitHash, file);
          const allLines = content.split('\n');
          const lines: Array<{ oldLineNum: number; newLineNum: number; content: string }> = [];
          for (let i = 0; i <= newEnd - newStart; i++) {
            lines.push({
              newLineNum: newStart + i,
              oldLineNum: oldStart + i,
              content:    allLines[newStart + i - 1] ?? '',
            });
          }
          this.panel.webview.postMessage({ type: 'contextLines', key, direction, lines });
        } catch { /* file read failed — send empty */ }
        break;
      }
    }
  }

  // ── Diff computation ──────────────────────────────────────────────────────

  private sendDiffForHashes(hashes: string[]): void {
    if (hashes.length === 0) {
      this.panel.webview.postMessage({
        type: 'diffResult',
        parsedDiff: [],
        changedFiles: [],
        selectedHashes: [],
        comments: this.comments.load(),
        gitUserName: this.gitUserName,
      repoName:    this.repoName,
      repoCount:   this.repoCount,
      });
      return;
    }

    const log      = this.git.getLog(200);
    const logIndex = new Map(log.map((c, i) => [c.hash, i]));
    const sorted   = [...hashes].sort((a, b) => (logIndex.get(a) ?? 9999) - (logIndex.get(b) ?? 9999));
    const newestHash = sorted[0];
    const oldestHash = sorted[sorted.length - 1];

    const rawDiff    = this.git.getRangeDiff(oldestHash, newestHash);
    const parsedDiff = this.git.parseDiff(rawDiff);
    const changedFiles = this.git.getChangedFilesInRange(oldestHash, newestHash);

    const focusCommentId = this.pendingFocusId;
    this.pendingFocusId = null;
    this.panel.webview.postMessage({
      type: 'diffResult',
      parsedDiff,
      changedFiles,
      selectedHashes: hashes,
      comments: this.comments.load(),
      oldestShort: log.find(c => c.hash === oldestHash)?.shortHash ?? oldestHash.slice(0, 7),
      newestShort: log.find(c => c.hash === newestHash)?.shortHash ?? newestHash.slice(0, 7),
      focusCommentId,
      gitUserName: this.gitUserName,
      repoName:    this.repoName,
      repoCount:   this.repoCount,
    });
  }

  // ── Agent prompt ──────────────────────────────────────────────────────────

  private copyAgentPrompt(): void {
    const open = this.comments.getOpenComments();
    if (open.length === 0) {
      vscode.window.showInformationMessage('No open comments to address.');
      return;
    }

    const byCommit = new Map<string, ReviewComment[]>();
    for (const c of open) {
      if (!byCommit.has(c.commitHash)) byCommit.set(c.commitHash, []);
      byCommit.get(c.commitHash)!.push(c);
    }

    const commits   = this.git.getLog(100);
    const hashToMsg = new Map(commits.map(c => [c.hash, c.message]));

    let prompt = '## Code Review Comments to Address\n\n';
    prompt += 'Please address the following review comments. After fixing each issue, ';
    prompt += 'update `.code-review/reviews.json` — set `"status": "addressed"` and ';
    prompt += '`"addressedByCommit"` to the new commit hash.\n\n---\n\n';

    for (const [hash, cs] of byCommit) {
      const msg = hashToMsg.get(hash) ?? hash;
      prompt += `### Commit \`${hash.slice(0, 8)}\` — ${msg}\n\n`;
      for (const c of cs) {
        prompt += `**${c.file}** line ${c.line} (id: \`${c.id}\`, status: \`${c.status}\`)\n`;
        if (c.codeSnippet) prompt += `\`\`\`\n${c.codeSnippet}\n\`\`\`\n`;
        prompt += `> ${c.body}\n`;
        for (const t of c.thread) prompt += `> — **${t.author}**: ${t.body}\n`;
        prompt += '\n';
      }
    }

    vscode.env.clipboard.writeText(prompt).then(() => {
      vscode.window.showInformationMessage(`Agent prompt copied (${open.length} comment${open.length !== 1 ? 's' : ''}).`);
    });
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const webview = this.panel.webview;
    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'review.css'))
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'review.js'))
    );
    const nonce = generateNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';">
  <link href="${cssUri}" rel="stylesheet">
  ${buildStatusCssVars()}
  <title>Commit Review</title>
</head>
<body>

<div id="top-bar">
  <div class="summary-badges">
    <span class="badge open"      id="badge-open">0 open</span>
    <span class="badge question"  id="badge-question">0 questions</span>
    <span class="badge addressed" id="badge-addressed">0 addressed</span>
    <span id="selected-count" class="selected-label">0 commits selected</span>
  </div>
  <button id="repo-select-btn" class="btn repo-select-btn" data-action="select-repo" style="display:none" title="Switch repository"><i class="codicon codicon-${ICONS.REPO}"></i></button>
  <button id="mark-reviewed-btn" data-action="toggle-reviewed">Mark as reviewed</button>
</div>

<div id="main">
  <div class="empty-state">
    <h2>Commit Review</h2>
    <p>Select a commit in the sidebar to begin reviewing.</p>
  </div>
</div>

<div id="footer">
  <span class="footer-path" id="footer-path">.code-review/reviews.json</span>
  <button class="btn" data-action="export-reviews">Open reviews.json</button>
  <button class="btn primary" data-action="copy-agent-prompt">Copy Agent Prompt</button>
</div>

<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private extractSnippet(commitHash: string, file: string, line: number): string {
    try {
      const content = this.git.getFileContentAtCommit(commitHash, file);
      const lines   = content.split('\n');
      const start   = Math.max(0, line - 2);
      const end     = Math.min(lines.length, line + 1);
      return lines.slice(start, end).join('\n');
    } catch {
      return '';
    }
  }

  dispose(): void {
    DiffPanel.instance = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function generateNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
