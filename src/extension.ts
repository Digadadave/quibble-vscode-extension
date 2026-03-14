import * as vscode from 'vscode';
import { GitService } from './GitService';
import { CommentManager } from './CommentManager';
import { ReviewTreeProvider } from './ReviewTreeProvider';
import { ReviewPanel } from './ReviewPanel';

export function activate(context: vscode.ExtensionContext): void {
  const repoPath = getRepoPath();
  if (!repoPath) {
    // No git repo — register a stub tree so the activity bar icon still shows
    vscode.window.registerTreeDataProvider('commitReview.tree', {
      getTreeItem: (e) => e,
      getChildren: () => [noRepoItem()],
    });
    return;
  }

  const git = new GitService(repoPath);
  const comments = new CommentManager(repoPath);
  comments.startWatching();

  const tree = new ReviewTreeProvider(git, comments);
  context.subscriptions.push(comments);

  // ── Sidebar tree ────────────────────────────────────────────────────────
  const treeView = vscode.window.createTreeView('commitReview.tree', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Auto-refresh sidebar when reviews.json changes (agent wrote to it)
  comments.onDidChange(() => tree.refresh(), null, context.subscriptions);

  // ── Commands ────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'commitReview.openPanel',
      (focusHash?: string, focusFile?: string) => {
        ReviewPanel.createOrShow(context, git, comments, focusHash, focusFile);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.refreshTree', () => {
      tree.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.copyAgentPrompt', () => {
      // Open panel first so the panel can handle the prompt generation
      const panel = ReviewPanel.createOrShow(context, git, comments);
      // Small delay to let panel initialise before posting message
      setTimeout(() => panel.sendLoadMessage(), 100);
      // The copy command is also available directly from the panel footer
      vscode.window.showInformationMessage(
        'Open the Commit Review panel and click "Copy Agent Prompt" to copy the formatted prompt.'
      );
    })
  );

  // ── Status bar item ─────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = 'commitReview.openPanel';
  statusBar.tooltip = 'Open Commit Review panel';
  context.subscriptions.push(statusBar);

  function updateStatusBar(): void {
    const open = comments.getOpenComments();
    if (open.length > 0) {
      statusBar.text = `$(comment) ${open.length} review comment${open.length !== 1 ? 's' : ''}`;
      statusBar.show();
    } else {
      statusBar.text = `$(git-pull-request) Commit Review`;
      statusBar.show();
    }
  }

  updateStatusBar();
  comments.onDidChange(updateStatusBar, null, context.subscriptions);
}

export function deactivate(): void {
  // CommentManager is in subscriptions and will be disposed automatically
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getRepoPath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return GitService.getRepoRoot(folders[0].uri.fsPath);
}

function noRepoItem(): vscode.TreeItem {
  const item = new vscode.TreeItem('No git repository found');
  item.iconPath = new vscode.ThemeIcon('warning');
  item.tooltip = 'Open a folder that contains a git repository';
  return item;
}
