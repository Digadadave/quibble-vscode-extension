import * as vscode from 'vscode';
import { GitService } from './GitService';

// ── URI parsing (exported for testing) ───────────────────────────────────────

export interface GitUriParams {
  ref: string;
  repo: string;
  side: string;
  reviewHash: string | null;
  file: string;
}

export function parseGitUri(path: string, query: string): GitUriParams {
  const params = new URLSearchParams(query);
  return {
    ref:        params.get('ref')        ?? '',
    repo:       params.get('repo')       ?? '',
    side:       params.get('side')       ?? '',
    reviewHash: params.get('reviewHash'),
    file:       path.startsWith('/') ? path.slice(1) : path,
  };
}

/**
 * TextDocumentContentProvider for the `quibble-git` URI scheme.
 *
 * VS Code normally only opens real files from disk. Implementing this interface
 * lets the extension register a custom URI scheme and return any string when VS Code
 * asks to open a document at that scheme. This is how `vscode.diff` works — it opens
 * two virtual documents (old side / new side) and renders them side-by-side.
 * Register with: `vscode.workspace.registerTextDocumentContentProvider(scheme, provider)`
 *
 * URI format:
 *   quibble-git:/<relative-file-path>?repo=<absRepoPath>&ref=<hash>&side=<old|new>
 *
 * Special ref value `__empty__` returns an empty file (used for root commits
 * that have no parent, and for added/deleted files where one side is empty).
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'quibble-git';

  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  /** Current active git service — kept in sync by the extension on repo switch. */
  private git: GitService | undefined;

  setGit(git: GitService): void {
    this.git = git;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const { ref, repo, file } = parseGitUri(uri.path, uri.query);

    if (ref === '__empty__') return '';

    const git = this.git ?? new GitService(repo);
    try {
      const content = git.getFileContentAtCommit(ref, file);
      console.log('[Quibble] GitContentProvider', { ref: ref.slice(0, 8), file: file.split('/').pop(), contentLen: content.length });
      return content;
    } catch (err) {
      console.log('[Quibble] GitContentProvider ERROR', { ref: ref.slice(0, 8), file: file.split('/').pop(), err: String(err) });
      return '';
    }
  }

  /**
   * Build a URI for `file` at `ref` (a full commit hash or `__empty__`).
   * `side` indicates which half of the diff this represents.
   * `reviewHash` is the commit being reviewed — passed on the old side so that
   * left-side comments are stored under the reviewed commit, not the parent.
   */
  static makeUri(
    repoPath: string,
    filePath: string,
    ref: string,
    side: 'old' | 'new',
    reviewHash?: string,
  ): vscode.Uri {
    const params = new URLSearchParams({ repo: repoPath, ref, side });
    if (reviewHash) params.set('reviewHash', reviewHash);
    return vscode.Uri.from({
      scheme: GitContentProvider.scheme,
      path:  '/' + filePath,
      query: params.toString(),
    });
  }
}
