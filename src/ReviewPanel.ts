import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, GitCommit, FileWithStats } from './GitService';

export class ReviewPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'commitReview.reviewView';
  private static instance: ReviewPanel | undefined;

  private _view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  /** Called when the user changes commit selection (click or shift-click range). */
  onSelectionChanged?: (hashes: string[]) => void;

  /** Called when the user expands a commit to request its file list. */
  onExpandCommit?: (hash: string) => void;

  /** Called when the user clicks a file row to jump to it in the diff. */
  onJumpToFile?: (hash: string, file: string) => void;

  /** Called when the user clicks the repo select button. */
  onSelectRepo?: () => void;

  private constructor(
    private context: vscode.ExtensionContext,
    private git: GitService
  ) {}

  // ── Factory ───────────────────────────────────────────────────────────────

  static register(
    context: vscode.ExtensionContext,
    git: GitService
  ): ReviewPanel {
    if (!ReviewPanel.instance) {
      ReviewPanel.instance = new ReviewPanel(context, git);
    } else {
      ReviewPanel.instance.git = git;
    }
    return ReviewPanel.instance;
  }

  /** Update services when the active repo changes. */
  updateServices(git: GitService): void {
    this.git = git;
    this.sendCommits();
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
        case 'expandCommit':
          this.onExpandCommit?.(msg.hash as string);
          break;
        case 'focusFile':
          this.onJumpToFile?.(msg.hash as string, msg.file as string);
          break;
        case 'selectRepo':
          this.onSelectRepo?.();
          break;
      }
    }, null, this.disposables);

    this.sendCommits();
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  sendCommits(): void {
    if (!this._view) return;
    const branch = this.git.getCurrentBranch();
    const commits = this.git.getCommitsForBranch(branch, 100);
    this._view.webview.postMessage({ type: 'load', branch, commits });
  }

  /** Push the file-stats list for one commit to the sidebar (to expand under that commit). */
  sendCommitFiles(hash: string, files: FileWithStats[]): void {
    this._view?.webview.postMessage({ type: 'commitFiles', hash, files });
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
    body { overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
    #sidebar { width: 100% !important; max-width: 100% !important; min-width: 0 !important; height: 100%; }
  </style>
  <title>Commits</title>
</head>
<body>

<div id="sidebar">
  <div class="sidebar-section-header">
    <span class="section-title" id="branch-label">COMMITS</span>
    <div class="sidebar-actions">
      <button class="sidebar-btn" data-action="select-repo" title="Select Repository">&#x22EF;</button>
    </div>
  </div>
  <div id="commits-list"></div>
</div>

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
