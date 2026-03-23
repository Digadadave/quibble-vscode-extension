import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './GitService';
import { CommentManager } from './CommentManager';
import { ReviewPanel } from './ReviewPanel';
import { CommentsView } from './CommentsView';
import { DiffPanel } from './DiffPanel';

// ── Mutable active-repo state ────────────────────────────────────────────────

let activeGit: GitService | undefined;
let activeComments: CommentManager | undefined;
let activeReviewPanel: ReviewPanel | undefined;
let activeCommentsView: CommentsView | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let commentChangeDisposable: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const repos = discoverAllRepos();

  // ── Commits sidebar WebviewView ───────────────────────────────────────────
  activeReviewPanel = ReviewPanel.register(context, new GitService(''));

  // When the user selects commit(s): show diff in editor + expand files for single commits.
  activeReviewPanel.onSelectionChanged = (hashes) => {
    if (!activeGit || !activeComments) return;
    const diff = DiffPanel.createOrShow(context, activeGit, activeComments);
    diff.onCommentMutation = refreshAll;
    diff.showSelection(hashes);
    // For a single-commit selection, push file+stat list back to the sidebar
    if (hashes.length === 1) {
      const files = activeGit.getChangedFilesWithStats(hashes[0]);
      activeReviewPanel?.sendCommitFiles(hashes[0], files);
    }
  };

  // When the user expands a commit: send its file list to the sidebar.
  activeReviewPanel.onExpandCommit = (hash) => {
    if (!activeGit) return;
    const files = activeGit.getChangedFilesWithStats(hash);
    activeReviewPanel?.sendCommitFiles(hash, files);
  };

  // When the user clicks a file row in the sidebar: scroll the diff to that file.
  activeReviewPanel.onJumpToFile = (_hash, file) => {
    DiffPanel.getInstance()?.focusFile(file);
  };

  // When the user clicks the repo select button in the sidebar.
  activeReviewPanel.onSelectRepo = () => {
    vscode.commands.executeCommand('commitReview.selectRepo');
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ReviewPanel.viewType,
      activeReviewPanel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Comments sidebar WebviewView ──────────────────────────────────────────
  activeCommentsView = CommentsView.register(context, new CommentManager(''));

  // When the user clicks a comment: open the file at that line in the editor.
  activeCommentsView.onFocusComment = (file, line) => {
    if (!activeGit) return;
    const filePath = path.join(activeGit.getRepoPath(), file);
    const uri = vscode.Uri.file(filePath);
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(pos, pos),
      preserveFocus: false,
    });
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CommentsView.viewType,
      activeCommentsView,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Status bar ──────────────────────────────────────────────────────────
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = 'commitReview.selectRepo';
  statusBar.tooltip = 'Select repo for Commit Review';
  context.subscriptions.push(statusBar);

  // ── Shared refresh (called after any comment mutation) ──────────────────
  function refreshAll(): void {
    try { activeReviewPanel?.sendCommits(); }         catch { /* ignore git errors */ }
    try { activeCommentsView?.refresh(); }            catch { /* ignore */ }
    try { DiffPanel.getInstance()?.refreshComments(); } catch { /* ignore */ }
    updateStatusBar();
  }

  // ── Switch to a repo ────────────────────────────────────────────────────
  function switchToRepo(repoPath: string): void {
    commentChangeDisposable?.dispose();
    activeComments?.dispose();

    activeGit      = new GitService(repoPath);
    activeComments = new CommentManager(repoPath);
    activeComments.startWatching();

    // Push updated services into panels
    activeReviewPanel?.updateServices(activeGit);
    activeCommentsView?.updateServices(activeComments);
    DiffPanel.getInstance()?.updateServices(activeGit, activeComments);

    // Re-wire diff panel's mutation callback after service update
    const diff = DiffPanel.getInstance();
    if (diff) {
      diff.onCommentMutation = refreshAll;
    }

    // Auto-refresh when reviews.json changes externally (agent updates)
    commentChangeDisposable = activeComments.onDidChange(refreshAll);

    updateStatusBar();

    const repoName = path.basename(repoPath);
    vscode.window.showInformationMessage(`Commit Review: switched to ${repoName}`);
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.selectRepo', async () => {
      const allRepos = discoverAllRepos();
      if (allRepos.length === 0) {
        vscode.window.showWarningMessage('No git repositories found in workspace.');
        return;
      }
      if (allRepos.length === 1) { switchToRepo(allRepos[0]); return; }
      const items = allRepos.map(r => ({ label: path.basename(r), description: r, repoPath: r }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a repository to review' });
      if (picked) switchToRepo(picked.repoPath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'commitReview.openPanel',
      (focusHash?: string, focusFile?: string) => {
        if (!activeGit || !activeComments) {
          vscode.commands.executeCommand('commitReview.selectRepo');
          return;
        }
        // Reveal the commits sidebar
        vscode.commands.executeCommand(`${ReviewPanel.viewType}.focus`);
        // If a specific commit requested, open the diff panel for it
        if (focusHash) {
          const diff = DiffPanel.createOrShow(context, activeGit, activeComments);
          diff.onCommentMutation = refreshAll;
          diff.showSelection([focusHash]);
          if (focusFile) setTimeout(() => diff.focusFile(focusFile!), 200);
        }
      }
    )
  );

  // ── Auto-select repo ─────────────────────────────────────────────────────
  if (repos.length === 1) {
    switchToRepo(repos[0]);
  } else if (repos.length > 1) {
    updateStatusBar();
    vscode.commands.executeCommand('commitReview.selectRepo');
  } else {
    updateStatusBar();
  }
}

export function deactivate(): void {
  commentChangeDisposable?.dispose();
  activeComments?.dispose();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function discoverAllRepos(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return [];
  const all: string[] = [];
  for (const folder of folders) {
    for (const r of GitService.discoverRepos(folder.uri.fsPath)) {
      if (!all.includes(r)) all.push(r);
    }
  }
  return all;
}

function updateStatusBar(): void {
  if (!statusBar) return;
  if (!activeGit) {
    statusBar.text = '$(git-pull-request) Select Repo';
    statusBar.show();
    return;
  }
  const repoName = path.basename(activeGit.getRepoPath());
  const open = activeComments?.getOpenComments() ?? [];
  statusBar.text = open.length > 0
    ? `$(comment) ${repoName}: ${open.length} comment${open.length !== 1 ? 's' : ''}`
    : `$(git-pull-request) ${repoName}`;
  statusBar.show();
}
