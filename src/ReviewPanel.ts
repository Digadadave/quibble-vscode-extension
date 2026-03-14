import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, GitCommit, ChangedFile } from './GitService';
import { CommentManager, ReviewComment } from './CommentManager';

/** Lightweight commit metadata sent on initial load (no diff content). */
interface CommitMeta extends GitCommit {
  changedFiles: ChangedFile[];
}

export class ReviewPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'commitReview.reviewView';
  private static instance: ReviewPanel | undefined;

  private _view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private selectedHash: string = '';

  private constructor(
    private context: vscode.ExtensionContext,
    private git: GitService,
    private comments: CommentManager
  ) {}

  // ── Public factory ───────────────────────────────────────────────────────

  static register(
    context: vscode.ExtensionContext,
    git: GitService,
    comments: CommentManager
  ): ReviewPanel {
    if (!ReviewPanel.instance) {
      ReviewPanel.instance = new ReviewPanel(context, git, comments);
    } else {
      // Update active services when the repo switches
      ReviewPanel.instance.git = git;
      ReviewPanel.instance.comments = comments;
    }
    return ReviewPanel.instance;
  }

  /** Update the active git/comment services (called on repo switch). */
  updateServices(git: GitService, comments: CommentManager): void {
    this.git = git;
    this.comments = comments;
    this.sendLoadMessage();
  }

  /** Bring the review view into focus and optionally highlight a commit/file. */
  focus(focusHash?: string, focusFile?: string): void {
    if (focusHash) this.selectedHash = focusHash;
    if (this._view) {
      this._view.show(true);
      this.sendLoadMessage(focusFile);
    } else {
      // View not yet resolved — executing focus will trigger resolveWebviewView
      vscode.commands.executeCommand(`${ReviewPanel.viewType}.focus`);
    }
  }

  // ── WebviewViewProvider ───────────────────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      msg => this.handleMessage(msg),
      null,
      this.disposables
    );

    // Send initial data once the view is live
    this.sendLoadMessage();
  }

  // ── Message handlers ─────────────────────────────────────────────────────

  private handleMessage(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'addComment':
        this.comments.addComment({
          commitHash: msg.commitHash as string,
          file: msg.file as string,
          line: msg.line as number,
          body: msg.body as string,
          codeSnippet: this.extractSnippet(msg.commitHash as string, msg.file as string, msg.line as number),
        });
        this.sendLoadMessage();
        break;

      case 'updateStatus':
        this.comments.updateStatus(msg.id as string, msg.status as ReviewComment['status']);
        this.sendLoadMessage();
        break;

      case 'addReply':
        this.comments.addThreadReply(msg.id as string, 'reviewer', msg.body as string);
        this.sendLoadMessage();
        break;

      case 'copyAgentPrompt':
        this.copyAgentPrompt();
        break;

      case 'exportReviews': {
        const filePath = this.comments.getReviewsFilePath();
        vscode.workspace.openTextDocument(filePath).then(doc =>
          vscode.window.showTextDocument(doc)
        );
        break;
      }

      /**
       * Webview sends this whenever the selected commit set changes.
       * We find the oldest and newest selected commits in git-log order,
       * then return a single cumulative diff (git diff oldest^..newest).
       */
      case 'requestDiff': {
        const hashes = msg.hashes as string[];
        if (!hashes || hashes.length === 0) break;

        // git log is newest-first; find positions to determine oldest/newest
        const log = this.git.getLog(200);
        const logIndex = new Map(log.map((c, i) => [c.hash, i]));

        // Sort selected hashes by log index — lowest index = newest
        const sorted = [...hashes].sort((a, b) => {
          const ia = logIndex.get(a) ?? 9999;
          const ib = logIndex.get(b) ?? 9999;
          return ia - ib; // ascending: newest first
        });

        const newestHash = sorted[0];
        const oldestHash = sorted[sorted.length - 1];

        const rawDiff = this.git.getRangeDiff(oldestHash, newestHash);
        const parsedDiff = this.git.parseDiff(rawDiff);
        const changedFiles = this.git.getChangedFilesInRange(oldestHash, newestHash);

        this._view?.webview.postMessage({
          type: 'diffResult',
          parsedDiff,
          changedFiles,
          oldestHash,
          newestHash,
          oldestShort: log.find(c => c.hash === oldestHash)?.shortHash ?? oldestHash.slice(0, 7),
          newestShort: log.find(c => c.hash === newestHash)?.shortHash ?? newestHash.slice(0, 7),
        });
        break;
      }
    }
  }

  // ── Data loading ─────────────────────────────────────────────────────────

  sendLoadMessage(focusFile?: string): void {
    if (!this._view) return;

    const commits = this.git.getLog(30);
    if (commits.length > 0 && !this.selectedHash) {
      this.selectedHash = commits[0].hash;
    }

    // Send lightweight metadata only — diffs are fetched on-demand via requestDiff
    const metas: CommitMeta[] = commits.map(c => ({
      ...c,
      changedFiles: this.git.getChangedFiles(c.hash),
    }));

    this._view.webview.postMessage({
      type: 'load',
      commits: metas,
      comments: this.comments.load(),
      selectedHash: this.selectedHash,
    });

    if (focusFile) {
      setTimeout(() => {
        this._view?.webview.postMessage({ type: 'focusFile', file: focusFile });
      }, 300);
    }
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

    const commits = this.git.getLog(100);
    const hashToMsg = new Map(commits.map(c => [c.hash, c.message]));

    let prompt = '## Code Review Comments to Address\n\n';
    prompt += 'Please address the following review comments. After fixing each issue, ';
    prompt += 'update `.code-review/reviews.json` — set `"status": "addressed"` and ';
    prompt += '`"addressedByCommit"` to the new commit hash.\n\n';
    prompt += '---\n\n';

    for (const [hash, cs] of byCommit) {
      const msg = hashToMsg.get(hash) ?? hash;
      prompt += `### Commit \`${hash.slice(0, 8)}\` — ${msg}\n\n`;
      for (const c of cs) {
        prompt += `**${c.file}** line ${c.line} (id: \`${c.id}\`)\n`;
        if (c.codeSnippet) prompt += `\`\`\`\n${c.codeSnippet}\n\`\`\`\n`;
        prompt += `> ${c.body}\n`;
        if (c.thread.length > 0) {
          for (const t of c.thread) {
            prompt += `> — **${t.author}**: ${t.body}\n`;
          }
        }
        prompt += '\n';
      }
    }

    vscode.env.clipboard.writeText(prompt).then(() => {
      vscode.window.showInformationMessage(`Agent prompt copied (${open.length} comment${open.length !== 1 ? 's' : ''}).`);
    });
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
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
  <title>Commit Review</title>
</head>
<body>

<div id="layout">

  <!-- Left sidebar: git graph + changes (comments) -->
  <div id="sidebar">

    <!-- GRAPH section -->
    <div class="sidebar-section-header">
      <span class="section-title">GRAPH</span>
      <div class="sidebar-actions">
        <button class="sidebar-btn" data-action="select-all-commits" title="Select all commits">All</button>
        <button class="sidebar-btn" data-action="select-no-commits" title="Clear selection">None</button>
      </div>
    </div>
    <div id="graph-list"></div>

    <!-- CHANGES (comments) section -->
    <div class="sidebar-section-header sidebar-section-border">
      <span class="section-title">CHANGES</span>
      <div class="sidebar-actions">
        <button class="sidebar-btn active" data-action="view-selected" title="Comments for selected commits">Selected</button>
        <button class="sidebar-btn" data-action="view-all-comments" title="All comments">All</button>
      </div>
    </div>
    <div id="comment-list"></div>

  </div>

  <!-- Right: main review area -->
  <div id="right-panel">
    <!-- Top bar -->
    <div id="top-bar">
      <div class="summary-badges">
        <span class="badge open" id="badge-open">0 open</span>
        <span class="badge replied" id="badge-replied">0 in review</span>
        <span class="badge addressed" id="badge-addressed">0 addressed</span>
        <span id="selected-count" class="selected-label">0 commits selected</span>
      </div>
      <button id="mark-reviewed-btn" data-action="toggle-reviewed">Mark as reviewed</button>
    </div>

    <!-- Diff content -->
    <div id="main">
      <div class="empty-state">
        <h2>Commit Review</h2>
        <p>Select commits from the left panel to begin reviewing.</p>
      </div>
    </div>

    <!-- Footer -->
    <div id="footer">
      <span class="footer-path" id="footer-path">.code-review/reviews.json</span>
      <button class="btn" data-action="export-reviews">Open reviews.json</button>
      <button class="btn primary" data-action="copy-agent-prompt">Copy Agent Prompt</button>
    </div>
  </div>

</div>

<!-- Commit message tooltip -->
<div id="commit-tooltip"></div>

<!-- Floating comment composer -->
<div id="comment-composer">
  <h4>Add comment</h4>
  <textarea placeholder="Leave a comment..."></textarea>
  <div class="composer-actions">
    <button class="btn" data-action="close-composer">Cancel</button>
    <button class="btn primary" data-action="submit-comment">Submit</button>
  </div>
</div>

<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private extractSnippet(commitHash: string, file: string, line: number): string {
    try {
      const content = this.git.getFileContentAtCommit(commitHash, file);
      const lines = content.split('\n');
      const start = Math.max(0, line - 2);
      const end = Math.min(lines.length, line + 1);
      return lines.slice(start, end).join('\n');
    } catch {
      return '';
    }
  }

  dispose(): void {
    ReviewPanel.instance = undefined;
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
