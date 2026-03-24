import * as vscode from 'vscode';
import * as path from 'path';
import { CommentManager, ReviewComment } from './CommentManager';

export class CommentsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'commitReview.commentsView';
  private static instance: CommentsView | undefined;

  private _view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  /** Cached comments to send as soon as the view resolves (if refresh was called before it opened). */
  private cachedComments: unknown[] | null = null;

  /** Called when the user clicks a comment — open the diff at that commit and scroll to the comment. */
  onFocusComment?: (file: string, line: number, commitHash: string, commentId: string) => void;

  /** Called when the user right-click-deletes a comment from the sidebar. */
  onDeleteComment?: (id: string) => void;

  /** Called when the user changes a comment's status from the hub. */
  onUpdateStatus?: (id: string, status: string) => void;

  private constructor(
    private context: vscode.ExtensionContext,
    private comments: CommentManager
  ) {}

  // ── Factory ───────────────────────────────────────────────────────────────

  static register(
    context: vscode.ExtensionContext,
    comments: CommentManager
  ): CommentsView {
    if (!CommentsView.instance) {
      CommentsView.instance = new CommentsView(context, comments);
    } else {
      CommentsView.instance.comments = comments;
    }
    return CommentsView.instance;
  }

  /** Update services when the active repo changes. */
  updateServices(comments: CommentManager): void {
    this.comments = comments;
    this.refresh();
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
      if (msg.type === 'focusComment') {
        this.onFocusComment?.(
          msg.file as string,
          msg.line as number,
          msg.commitHash as string,
          msg.id as string,
        );
      } else if (msg.type === 'deleteComment') {
        this.onDeleteComment?.(msg.id as string);
      } else if (msg.type === 'updateStatus') {
        this.onUpdateStatus?.(msg.id as string, msg.status as string);
      }
    }, null, this.disposables);

    // Send any comments that were loaded before this view was first shown
    const comments = this.cachedComments ?? this.comments.load();
    this.cachedComments = null;
    webviewView.webview.postMessage({ type: 'load', comments });
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  /** Push all comments to the webview. */
  refresh(): void {
    const comments = this.comments.load();
    this.cachedComments = comments;          // always cache so resolveWebviewView can pick it up
    if (!this._view) return;
    this._view.webview.postMessage({ type: 'load', comments });
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'review.css'))
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'comments.js'))
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
    body { overflow: hidden; display: flex; flex-direction: column; height: 100vh; margin: 0; }
    #comment-list { flex: 1; overflow-y: auto; min-height: 0; }
  </style>
  <title>Comments</title>
</head>
<body>

<div class="sidebar-section-header">
  <span class="section-title">COMMENTS</span>
</div>
<div id="summary-bar" class="cv-summary-bar"></div>
<div id="filter-bar"  class="cv-filter-bar"></div>
<div id="comment-list"></div>

<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    CommentsView.instance = undefined;
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
