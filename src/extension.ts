import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './GitService';
import { CommentManager } from './CommentManager';
import { ReviewTreeProvider } from './ReviewTreeProvider';
import { ReviewPanel } from './ReviewPanel';
import { DiffPanel } from './DiffPanel';

// ── Mutable active-repo state ────────────────────────────────────────────────

let activeGit: GitService | undefined;
let activeComments: CommentManager | undefined;
let activeTree: ReviewTreeProvider | undefined;
let activeReviewPanel: ReviewPanel | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let commentChangeDisposable: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const repos = discoverAllRepos();

  // ── Sidebar tree ────────────────────────────────────────────────────────
  const proxyProvider: vscode.TreeDataProvider<vscode.TreeItem> = {
    get onDidChangeTreeData() { return activeTree?.onDidChangeTreeData; },
    getTreeItem: (el) => activeTree ? activeTree.getTreeItem(el as any) : el,
    getChildren: (el) => activeTree ? activeTree.getChildren(el as any) : [noRepoItem()],
  };
  context.subscriptions.push(
    vscode.window.createTreeView('commitReview.tree', { treeDataProvider: proxyProvider, showCollapseAll: true })
  );

  // ── Graph sidebar WebviewView ────────────────────────────────────────────
  activeReviewPanel = ReviewPanel.register(context, new GitService(''), new CommentManager(''));

  // When the user changes selection in the graph: show the diff in the editor.
  activeReviewPanel.onSelectionChanged = (hashes) => {
    if (!activeGit || !activeComments) return;
    const diff = DiffPanel.createOrShow(context, activeGit, activeComments);
    diff.onCommentMutation = refreshAll;
    diff.showSelection(hashes);
  };

  // When the user clicks a comment entry: forward focusFile to the diff panel.
  activeReviewPanel.onFocusFile = (file) => {
    DiffPanel.getInstance()?.focusFile(file);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ReviewPanel.viewType,
      activeReviewPanel,
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
    activeTree?.refresh();
    activeReviewPanel?.sendLoad();          // refresh comment dots on graph
    DiffPanel.getInstance()?.refreshComments(); // refresh inline threads
    updateStatusBar();
  }

  // ── Switch to a repo ────────────────────────────────────────────────────
  function switchToRepo(repoPath: string): void {
    commentChangeDisposable?.dispose();
    activeComments?.dispose();

    activeGit      = new GitService(repoPath);
    activeComments = new CommentManager(repoPath);
    activeComments.startWatching();
    activeTree     = new ReviewTreeProvider(activeGit, activeComments);

    // Push updated services into both panels
    activeReviewPanel?.updateServices(activeGit, activeComments);
    DiffPanel.getInstance()?.updateServices(activeGit, activeComments);

    // Re-wire diff panel's mutation callback after service update
    const diff = DiffPanel.getInstance();
    if (diff) diff.onCommentMutation = refreshAll;

    // Auto-refresh when reviews.json changes externally (agent updates)
    commentChangeDisposable = activeComments.onDidChange(refreshAll);

    activeTree.refresh();
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
        // Reveal the graph sidebar
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

  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.refreshTree', () => activeTree?.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.copyAgentPrompt', () => {
      if (!activeGit || !activeComments) {
        vscode.commands.executeCommand('commitReview.selectRepo');
        return;
      }
      const diff = DiffPanel.createOrShow(context, activeGit, activeComments);
      diff.onCommentMutation = refreshAll;
    })
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
  const repoName = path.basename(activeGit['repoPath']);
  const open = activeComments?.getOpenComments() ?? [];
  statusBar.text = open.length > 0
    ? `$(comment) ${repoName}: ${open.length} comment${open.length !== 1 ? 's' : ''}`
    : `$(git-pull-request) ${repoName}`;
  statusBar.show();
}

function noRepoItem(): vscode.TreeItem {
  const item = new vscode.TreeItem('Select a repository…');
  item.iconPath = new vscode.ThemeIcon('repo');
  item.tooltip  = 'Click the status bar or run "Commit Review: Select Repo"';
  item.command  = { command: 'commitReview.selectRepo', title: 'Select Repo' };
  return item;
}
