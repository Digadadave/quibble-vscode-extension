import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from './GitService';
import { CommentManager } from './CommentManager';
import { buildStatusCssVars } from './icons';

/**
 * Implements WebviewViewProvider — VS Code calls resolveWebviewView() the first
 * time the sidebar panel becomes visible. The `_view` property is undefined until then.
 * View mode ('files' | 'commits') is toggled via title-bar commands and communicated
 * to the webview via postMessage.
 */
export class ChangesView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'commitReview.changesView';
  private static instance: ChangesView | undefined;

  private _view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private cachedData: { branch: string; files: object[] } | null = null;
  private viewMode: 'files' | 'commits' = 'files';

  /** Called when the user clicks a file row — open single-file diff in VS Code native diff editor. */
  onJumpToFileNative?: (file: string) => void;
  onJumpToCommitFileNative?: (hash: string, file: string) => void;

  /** Called when the user clicks the comment badge — open the first comment on that file. */
  onJumpToComment?: (file: string) => void;

  /** Called when the user clicks the jump-to-source arrow — open file at first changed line. */
  onJumpToSource?: (file: string) => void;

  /** Called when the user clicks "open all changes" on a commit row. */
  onOpenCommitChanges?: (hash: string) => void;

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

  /** Register the view-mode toggle commands. Call once after register(). */
  registerCommands(context: vscode.ExtensionContext): void {
    const setMode = (mode: 'files' | 'commits') => {
      this.viewMode = mode;
      vscode.commands.executeCommand('setContext', 'commitReview.changesViewMode', mode);
      this._view?.webview.postMessage({ type: 'setViewMode', mode });
    };
    context.subscriptions.push(
      vscode.commands.registerCommand('commitReview.changes.toCommitsView', () => setMode('commits')),
      vscode.commands.registerCommand('commitReview.changes.toFilesView',   () => setMode('files')),
      vscode.commands.registerCommand('commitReview.changes.collapseAll',   () => {
        this._view?.webview.postMessage({ type: 'collapseAll' });
      }),
    );
    vscode.commands.executeCommand('setContext', 'commitReview.changesViewMode', this.viewMode);
  }

  /** Show loading state immediately (call before slow work begins). */
  showLoading(): void {
    this._view?.webview.postMessage({ type: 'loading' });
  }

  // ── WebviewViewProvider ───────────────────────────────────────────────────

  /** Called lazily by VS Code the first time this sidebar panel becomes visible. */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    // localResourceRoots whitelists which directories the iframe can load files from.
    // Raw file:// URIs are blocked; use webview.asWebviewUri() to convert paths.
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'media')),
        vscode.Uri.file(path.join(this.context.extensionPath, 'node_modules', '@vscode', 'codicons', 'dist')),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    // Messages sent from the webview via vscode.postMessage() arrive here.
    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'jumpToFile') {
        this.onJumpToFileNative?.(msg.file as string);
      } else if (msg.type === 'jumpToCommitFile') {
        this.onJumpToCommitFileNative?.(msg.hash as string, msg.file as string);
      } else if (msg.type === 'jumpToComment') {
        this.onJumpToComment?.(msg.file as string);
      } else if (msg.type === 'jumpToSource') {
        this.onJumpToSource?.(msg.file as string);
      } else if (msg.type === 'openCommitChanges') {
        this.onOpenCommitChanges?.(msg.hash as string);
      }
    }, null, this.disposables);

    const data = this.cachedData ?? this.buildData();
    this.cachedData = null;
    webviewView.webview.postMessage({ type: 'load', branch: data.branch, files: data.files });
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  /** Full refresh: re-fetch file list from git + comment counts. */
  refresh(): void {
    const data = this.buildData();
    this.cachedData = data;
    if (!this._view) return;
    this._view.webview.postMessage({ type: 'load', branch: data.branch, files: data.files });
  }

  /** Light refresh: re-compute comment counts only, skip git. Used on comment-only mutations. */
  refreshCommentCounts(): void {
    if (!this._view) return;
    const allComments = this.comments.load();
    const commentsByFile = new Map<string, number>();
    for (const c of allComments) {
      commentsByFile.set(c.file, (commentsByFile.get(c.file) ?? 0) + 1);
    }
    this._view.webview.postMessage({
      type: 'updateCommentCounts',
      counts: Object.fromEntries(commentsByFile),
    });
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
    // asWebviewUri() converts a local extension file path into a vscode-resource://
    // URI the sandboxed iframe is allowed to load. Raw file:// URIs are blocked.
    const mediaPath = (file: string) =>
      webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', file)));
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')),
    );
    // The nonce is a random token stamped on every <script> tag and in the CSP header.
    // It proves the script was injected by the extension, not by untrusted content.
    const nonce = generateNonce();

    const template = fs.readFileSync(
      path.join(this.context.extensionPath, 'media', 'changes.html'),
      'utf8',
    );

    return template
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace('{{sharedCssUri}}', mediaPath('shared.css').toString())
      .replace('{{changesCssUri}}', mediaPath('changes.css').toString())
      .replace('{{codiconsUri}}', codiconsUri.toString())
      .replace('{{statusCssVars}}', buildStatusCssVars())
      .replace('{{commonJsUri}}', mediaPath('common.js').toString())
      .replace('{{jsUri}}', mediaPath('changes.js').toString());
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
