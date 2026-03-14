import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './GitService';
import { CommentManager } from './CommentManager';
import { ReviewTreeProvider } from './ReviewTreeProvider';
import { ReviewPanel } from './ReviewPanel';

// ── Mutable active-repo state ────────────────────────────────────────────────

let activeGit: GitService | undefined;
let activeComments: CommentManager | undefined;
let activeTree: ReviewTreeProvider | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let commentChangeDisposable: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Discover all repos in the workspace
  const repos = discoverAllRepos();

  // ── Sidebar tree — registered once, data driven by activeTree ──────────
  const proxyProvider: vscode.TreeDataProvider<vscode.TreeItem> = {
    get onDidChangeTreeData() {
      return activeTree?.onDidChangeTreeData;
    },
    getTreeItem: (el) => activeTree ? activeTree.getTreeItem(el as any) : el,
    getChildren: (el) => activeTree ? activeTree.getChildren(el as any) : [noRepoItem()],
  };

  const treeView = vscode.window.createTreeView('commitReview.tree', {
    treeDataProvider: proxyProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // ── Status bar ─────────────────────────────────────────────────────────
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = 'commitReview.selectRepo';
  statusBar.tooltip = 'Select repo for Commit Review';
  context.subscriptions.push(statusBar);

  // ── Switch to a repo (creates services + refreshes everything) ─────────

  function switchToRepo(repoPath: string): void {
    // Dispose previous CommentManager watcher
    commentChangeDisposable?.dispose();
    activeComments?.dispose();

    activeGit = new GitService(repoPath);
    activeComments = new CommentManager(repoPath);
    activeComments.startWatching();

    activeTree = new ReviewTreeProvider(activeGit, activeComments);

    // Wire auto-refresh on reviews.json changes
    commentChangeDisposable = activeComments.onDidChange(() => {
      activeTree?.refresh();
      updateStatusBar();
    });

    // Force tree view to refresh with new provider data
    activeTree.refresh();
    updateStatusBar();

    const repoName = path.basename(repoPath);
    vscode.window.showInformationMessage(`Commit Review: switched to ${repoName}`);
  }

  // ── Commands ───────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.selectRepo', async () => {
      const allRepos = discoverAllRepos();
      if (allRepos.length === 0) {
        vscode.window.showWarningMessage('No git repositories found in workspace.');
        return;
      }
      if (allRepos.length === 1) {
        switchToRepo(allRepos[0]);
        return;
      }
      const items = allRepos.map(r => ({
        label: path.basename(r),
        description: r,
        repoPath: r,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a repository to review',
      });
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
        ReviewPanel.createOrShow(context, activeGit, activeComments, focusHash, focusFile);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.refreshTree', () => {
      activeTree?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.copyAgentPrompt', () => {
      if (!activeGit || !activeComments) {
        vscode.commands.executeCommand('commitReview.selectRepo');
        return;
      }
      const panel = ReviewPanel.createOrShow(context, activeGit, activeComments);
      setTimeout(() => panel.sendLoadMessage(), 100);
      vscode.window.showInformationMessage(
        'Open the Commit Review panel and click "Copy Agent Prompt" to copy the formatted prompt.'
      );
    })
  );

  // ── Auto-select if only one repo, otherwise prompt ─────────────────────

  if (repos.length === 1) {
    switchToRepo(repos[0]);
  } else if (repos.length > 1) {
    updateStatusBar();
    // Prompt to pick a repo on first activation
    vscode.commands.executeCommand('commitReview.selectRepo');
  } else {
    updateStatusBar();
  }
}

export function deactivate(): void {
  commentChangeDisposable?.dispose();
  activeComments?.dispose();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function discoverAllRepos(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return [];

  const all: string[] = [];
  for (const folder of folders) {
    const discovered = GitService.discoverRepos(folder.uri.fsPath);
    for (const r of discovered) {
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
  if (open.length > 0) {
    statusBar.text = `$(comment) ${repoName}: ${open.length} comment${open.length !== 1 ? 's' : ''}`;
  } else {
    statusBar.text = `$(git-pull-request) ${repoName}`;
  }
  statusBar.show();
}

function noRepoItem(): vscode.TreeItem {
  const item = new vscode.TreeItem('Select a repository…');
  item.iconPath = new vscode.ThemeIcon('repo');
  item.tooltip = 'Click the status bar or run "Commit Review: Select Repo"';
  item.command = { command: 'commitReview.selectRepo', title: 'Select Repo' };
  return item;
}
