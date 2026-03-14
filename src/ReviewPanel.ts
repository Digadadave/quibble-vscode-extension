import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, ChangedFile } from './GitService';
import { CommentManager } from './CommentManager';

/** Lightweight commit metadata sent on initial load. */
interface CommitMeta {
  hash: string;
  shortHash: string;
  message: string;
  date: string;
  author: string;
  refs: string[];
  changedFiles: ChangedFile[];
}

export class ReviewPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'commitReview.reviewView';
  private static instance: ReviewPanel | undefined;

  private _view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  /** Called when the user changes the commit selection. */
  onSelectionChanged?: (hashes: string[]) => void;

  /** Called when the user clicks a comment (jump to file in diff panel). */
  onFocusFile?: (file: string) => void;

  private constructor(
    private context: vscode.ExtensionContext,
    private git: GitService,
    private comments: CommentManager
  ) {}

  // ── Factory ───────────────────────────────────────────────────────────────

  static register(
    context: vscode.ExtensionContext,
    git: GitService,
    comments: CommentManager
  ): ReviewPanel {
    if (!ReviewPanel.instance) {
      ReviewPanel.instance = new ReviewPanel(context, git, comments);
    } else {
      ReviewPanel.instance.git      = git;
      ReviewPanel.instance.comments = comments;
    }
    return ReviewPanel.instance;
  }

  /** Update services when the active repo changes. */
  updateServices(git: GitService, comments: CommentManager): void {
    this.git      = git;
    this.comments = comments;
    this.sendLoad();
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

    webviewView.webview.onDidReceiveMessage(msg => {
      switch (msg.type) {
        case 'selectionChanged':
          this.onSelectionChanged?.(msg.hashes as string[]);
          break;
        case 'focusFile':
          this.onFocusFile?.(msg.file as string);
          break;
      }
    }, null, this.disposables);

    this.sendLoad();
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  sendLoad(): void {
    if (!this._view) return;

    const commits = this.git.getLog(30);
    const metas: CommitMeta[] = commits.map(c => ({
      ...c,
      changedFiles: this.git.getChangedFiles(c.hash),
    }));

    this._view.webview.postMessage({
      type: 'load',
      commits: metas,
      comments: this.comments.load(),
    });
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'review.css'))
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'sidebar.js'))
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
  <style>
    /* Override sidebar width constraints — fill the WebviewView */
    body { overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
    #sidebar { width: 100% !important; max-width: 100% !important; min-width: 0 !important; height: 100%; }
  </style>
  <title>Commit Review</title>
</head>
<body>

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

  <!-- COMMENTS section -->
  <div class="sidebar-section-header sidebar-section-border">
    <span class="section-title">COMMENTS</span>
    <div class="sidebar-actions">
      <button class="sidebar-btn active" data-action="view-selected" title="Comments for selected commits">Selected</button>
      <button class="sidebar-btn" data-action="view-all-comments" title="All comments">All</button>
    </div>
  </div>
  <div id="comment-list"></div>
</div>

<!-- Commit message tooltip -->
<div id="commit-tooltip"></div>

<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
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
