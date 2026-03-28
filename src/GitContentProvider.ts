import * as vscode from 'vscode';
import { GitService } from './GitService';

/**
 * GitContentProvider.ts — Serves synthetic file content for custom URIs so
 * VS Code can display historical file versions inside its native diff editor.
 *
 * VS Code `TextDocumentContentProvider` concept:
 *   Normally VS Code only opens real files from disk. A `TextDocumentContentProvider`
 *   lets extensions register a custom URI scheme (here: `commit-review-git`) and
 *   return arbitrary text when VS Code asks to open a document with that scheme.
 *   This is what powers `vscode.diff` — it opens two virtual documents side-by-side.
 *
 *   Register with: `vscode.workspace.registerTextDocumentContentProvider(scheme, provider)`
 *   VS Code calls `provideTextDocumentContent(uri)` whenever it needs the content.
 *
 * TextDocumentContentProvider for the `commit-review-git` URI scheme.
 *
 * URI format:
 *   commit-review-git:/<relative-file-path>?repo=<absRepoPath>&ref=<hash>&side=<old|new>
 *
 * Special ref value `__empty__` returns an empty file (used for root commits
 * that have no parent).
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'commit-review-git';

  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  /** Current active git service — kept in sync by the extension on repo switch. */
  private git: GitService | undefined;

  setGit(git: GitService): void {
    this.git = git;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const ref  = params.get('ref')  ?? '';
    const repo = params.get('repo') ?? '';

    if (ref === '__empty__') return '';

    const file = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    const git = this.git ?? new GitService(repo);
    try {
      const content = git.getFileContentAtCommit(ref, file);
      console.log('[CommitReview] GitContentProvider', { ref: ref.slice(0, 8), file: file.split('/').pop(), contentLen: content.length });
      return content;
    } catch (err) {
      console.log('[CommitReview] GitContentProvider ERROR', { ref: ref.slice(0, 8), file: file.split('/').pop(), err: String(err) });
      return '';
    }
  }

  /**
   * Build a URI for `file` at `ref` (a full commit hash or `__empty__`).
   * `side` indicates which half of the diff this represents; the comment
   * controller only allows new comments on the `new` side.
   */
  static makeUri(
    repoPath: string,
    filePath: string,
    ref: string,
    side: 'old' | 'new',
  ): vscode.Uri {
    const params = new URLSearchParams({ repo: repoPath, ref, side });
    return vscode.Uri.from({
      scheme: GitContentProvider.scheme,
      path:  '/' + filePath,
      query: params.toString(),
    });
  }
}
