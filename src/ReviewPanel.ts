import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, GitCommit, ParsedDiff, ChangedFile } from './GitService';
import { CommentManager, ReviewComment } from './CommentManager';

interface CommitPayload extends GitCommit {
  parsedDiff: ParsedDiff[];
  changedFiles: ChangedFile[];
}

export class ReviewPanel implements vscode.Disposable {
  static readonly viewType = 'commitReview.panel';
  private static instance: ReviewPanel | undefined;

  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private selectedHash: string = '';

  private constructor(
    private context: vscode.ExtensionContext,
    private git: GitService,
    private comments: CommentManager
  ) {
    this.panel = vscode.window.createWebviewPanel(
      ReviewPanel.viewType,
      'Commit Review',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
        retainContextWhenHidden: true,
      }
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg), null, this.disposables);

    this.panel.webview.html = this.buildHtml();
  }

  // ── Public factory ───────────────────────────────────────────────────────

  static createOrShow(
    context: vscode.ExtensionContext,
    git: GitService,
    comments: CommentManager,
    focusHash?: string,
    focusFile?: string
  ): ReviewPanel {
    if (ReviewPanel.instance) {
      ReviewPanel.instance.panel.reveal(vscode.ViewColumn.One);
      if (focusHash) ReviewPanel.instance.selectedHash = focusHash;
      ReviewPanel.instance.sendLoadMessage(focusFile);
      return ReviewPanel.instance;
    }

    const p = new ReviewPanel(context, git, comments);
    ReviewPanel.instance = p;
    if (focusHash) p.selectedHash = focusHash;
    p.sendLoadMessage(focusFile);
    return p;
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
    }
  }

  // ── Data loading ─────────────────────────────────────────────────────────

  sendLoadMessage(focusFile?: string): void {
    const commits = this.git.getLog(30);
    if (commits.length > 0 && !this.selectedHash) {
      this.selectedHash = commits[0].hash;
    }

    const payloads: CommitPayload[] = commits.map(c => {
      const rawDiff = this.git.getRawDiff(c.hash);
      return {
        ...c,
        parsedDiff: this.git.parseDiff(rawDiff),
        changedFiles: this.git.getChangedFiles(c.hash),
      };
    });

    this.panel.webview.postMessage({
      type: 'load',
      commits: payloads,
      comments: this.comments.load(),
      selectedHash: this.selectedHash,
    });

    if (focusFile) {
      setTimeout(() => {
        this.panel.webview.postMessage({ type: 'focusFile', file: focusFile });
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
  <title>Commit Review</title>
</head>
<body>

<!-- Top bar -->
<div id="top-bar">
  <div class="commit-select-wrap">
    <button class="nav-btn" title="Previous commit" onclick="navigateCommit('prev')">‹</button>
    <select id="commit-select" title="Select commit"></select>
    <button class="nav-btn" title="Next commit" onclick="navigateCommit('next')">›</button>
  </div>
  <div class="summary-badges">
    <span class="badge open" id="badge-open">0 open</span>
    <span class="badge replied" id="badge-replied">0 in review</span>
    <span class="badge addressed" id="badge-addressed">0 addressed</span>
  </div>
  <button id="mark-reviewed-btn" onclick="toggleMarkReviewed()">Mark as reviewed</button>
</div>

<!-- Diff content -->
<div id="main">
  <div class="empty-state">
    <h2>Commit Review</h2>
    <p>Loading commits…</p>
  </div>
</div>

<!-- Floating comment composer -->
<div id="comment-composer">
  <h4>Add comment</h4>
  <textarea placeholder="Leave a comment…"></textarea>
  <div class="composer-actions">
    <button class="btn" onclick="closeComposer()">Cancel</button>
    <button class="btn primary" onclick="submitComment()">Submit</button>
  </div>
</div>

<!-- Footer -->
<div id="footer">
  <span class="footer-path" id="footer-path">.code-review/reviews.json</span>
  <button class="btn" onclick="exportReviews()">Open reviews.json</button>
  <button class="btn primary" onclick="copyAgentPrompt()">Copy Agent Prompt</button>
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
