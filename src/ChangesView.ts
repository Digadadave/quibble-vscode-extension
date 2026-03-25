import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './GitService';
import { CommentManager } from './CommentManager';

export class ChangesView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'commitReview.changesView';
  private static instance: ChangesView | undefined;

  private _view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private cachedData: { branch: string; files: object[] } | null = null;

  /** Called when the user clicks a file row — open the cumulative diff for that file. */
  onJumpToFile?: (file: string) => void;

  /** Called when the user clicks a commit hash badge — open the commit diff anchored on that file. */
  onJumpToCommitFile?: (hash: string, file: string) => void;

  /** Native diff variants (single-file VS Code diff editor). */
  onJumpToFileNative?: (file: string) => void;
  onJumpToCommitFileNative?: (hash: string, file: string) => void;

  /** Called when the user clicks the comment badge — open the first comment on that file. */
  onJumpToComment?: (file: string) => void;

  private constructor(
    private context: vscode.ExtensionContext,
    private git: GitService,
    private comments: CommentManager,
  ) {}

  // ── Factory ───────────────────────────────────────────────────────────────

  static register(
    context: vscode.ExtensionContext,
    git: GitService,
    comments: CommentManager,
  ): ChangesView {
    if (!ChangesView.instance) {
      ChangesView.instance = new ChangesView(context, git, comments);
    } else {
      ChangesView.instance.git = git;
      ChangesView.instance.comments = comments;
    }
    return ChangesView.instance;
  }

  /** Update services when the active repo changes. */
  updateServices(git: GitService, comments: CommentManager): void {
    this.git = git;
    this.comments = comments;
    this.refresh();
  }

  // ── WebviewViewProvider ───────────────────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(msg => {
      const native = msg.diffMode === 'native';
      if (msg.type === 'jumpToFile') {
        native ? this.onJumpToFileNative?.(msg.file) : this.onJumpToFile?.(msg.file);
      } else if (msg.type === 'jumpToCommitFile') {
        native
          ? this.onJumpToCommitFileNative?.(msg.hash, msg.file)
          : this.onJumpToCommitFile?.(msg.hash, msg.file);
      } else if (msg.type === 'jumpToComment') {
        this.onJumpToComment?.(msg.file as string);
      }
    }, null, this.disposables);

    const data = this.cachedData ?? this.buildData();
    this.cachedData = null;
    webviewView.webview.postMessage({ type: 'load', branch: data.branch, files: data.files });
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  refresh(): void {
    const data = this.buildData();
    this.cachedData = data;
    if (!this._view) return;
    this._view.webview.postMessage({ type: 'load', branch: data.branch, files: data.files });
  }

  private buildData(): { branch: string; files: object[] } {
    try {
      const branch = this.git.getCurrentBranch();
      const rawFiles = this.git.getChangesOnBranch(branch);
      const allComments = this.comments.load();

      const commentsByFile = new Map<string, number>();
      for (const c of allComments) {
        commentsByFile.set(c.file, (commentsByFile.get(c.file) ?? 0) + 1);
      }

      const files = rawFiles.map(f => ({
        ...f,
        commentCount: commentsByFile.get(f.path) ?? 0,
      }));

      return { branch, files };
    } catch {
      return { branch: '', files: [] };
    }
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'review.css')),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'changes.js')),
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
    body { overflow: hidden; display: flex; flex-direction: column; height: 100vh; margin: 0;
           background: var(--vscode-sideBar-background, #252526);
           color: var(--vscode-sideBar-foreground, var(--vscode-foreground, #ccc)); }
    #changes-list { flex: 1; overflow-y: auto; min-height: 0; }
  </style>
  <title>Changes</title>
</head>
<body>

<div class="sidebar-section-header">
  <span class="section-title">CHANGES</span>
  <span id="branch-label" class="ch-branch-label"></span>
  <label class="ch-toggle" title="Toggle between DiffPanel and native VS Code diff">
    <span class="ch-toggle-label">Panel</span>
    <input type="checkbox" id="diff-mode-toggle">
    <span class="ch-toggle-track"></span>
    <span class="ch-toggle-label">Native</span>
  </label>
</div>
<div id="changes-list"></div>

<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    ChangesView.instance = undefined;
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
