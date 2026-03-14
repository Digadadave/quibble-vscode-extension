import * as vscode from 'vscode';
import { GitService, GitCommit, ChangedFile } from './GitService';
import { CommentManager, ReviewComment } from './CommentManager';

// ─── Tree item types ────────────────────────────────────────────────────────

type NodeKind = 'branch' | 'commit' | 'file' | 'commentsRoot' | 'comment';

export class ReviewTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: NodeKind,
    public readonly meta?: {
      commit?: GitCommit;
      file?: ChangedFile;
      comment?: ReviewComment;
    }
  ) {
    super(label, collapsibleState);
  }
}

// ─── Provider ───────────────────────────────────────────────────────────────

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ReviewTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private git: GitService,
    private comments: CommentManager
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }

  getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ReviewTreeItem): ReviewTreeItem[] {
    if (!element) return this.getRoots();
    if (element.kind === 'branch') return this.getCommitNodes();
    if (element.kind === 'commit') return this.getFileNodes(element.meta!.commit!);
    if (element.kind === 'commentsRoot') return this.getCommentNodes();
    return [];
  }

  // ── Root: branch + open comments section ──────────────────────────────────

  private getRoots(): ReviewTreeItem[] {
    const branch = this.git.getCurrentBranch();
    const branchNode = new ReviewTreeItem(
      `$(git-branch) ${branch}`,
      vscode.TreeItemCollapsibleState.Expanded,
      'branch'
    );
    branchNode.tooltip = 'Current branch — click commits to review';

    const openCount = this.comments.getOpenComments().length;
    const commentsNode = new ReviewTreeItem(
      `$(comment-discussion) Open Comments (${openCount})`,
      openCount > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
      'commentsRoot'
    );
    commentsNode.tooltip = 'All unresolved review comments';

    return [branchNode, commentsNode];
  }

  // ── Commits under branch ──────────────────────────────────────────────────

  private getCommitNodes(): ReviewTreeItem[] {
    const commits = this.git.getLog(30);
    return commits.map(commit => {
      const commentCount = this.comments.getCommentsForCommit(commit.hash).length;
      const badge = commentCount > 0 ? ` $(comment) ${commentCount}` : '';
      const node = new ReviewTreeItem(
        `$(git-commit) ${commit.shortHash} — ${commit.message}${badge}`,
        vscode.TreeItemCollapsibleState.Collapsed,
        'commit',
        { commit }
      );
      node.tooltip = `${commit.hash}\n${commit.author}\n${commit.date}`;
      node.command = {
        command: 'commitReview.openPanel',
        title: 'Open Review',
        arguments: [commit.hash],
      };
      return node;
    });
  }

  // ── Files under commit ────────────────────────────────────────────────────

  private getFileNodes(commit: GitCommit): ReviewTreeItem[] {
    const files = this.git.getChangedFiles(commit.hash);
    const commentsByFile = new Map<string, number>();
    for (const c of this.comments.getCommentsForCommit(commit.hash)) {
      commentsByFile.set(c.file, (commentsByFile.get(c.file) ?? 0) + 1);
    }

    return files.map(file => {
      const count = commentsByFile.get(file.path) ?? 0;
      const badge = count > 0 ? ` $(comment) ${count}` : '';
      const statusIcon = statusToIcon(file.status);
      const node = new ReviewTreeItem(
        `${statusIcon} ${file.path}${badge}`,
        vscode.TreeItemCollapsibleState.None,
        'file',
        { commit, file }
      );
      node.tooltip = `${file.status === 'A' ? 'Added' : file.status === 'D' ? 'Deleted' : 'Modified'}: ${file.path}`;
      node.command = {
        command: 'commitReview.openPanel',
        title: 'Open Review',
        arguments: [commit.hash, file.path],
      };
      return node;
    });
  }

  // ── Open comments ─────────────────────────────────────────────────────────

  private getCommentNodes(): ReviewTreeItem[] {
    const open = this.comments.getOpenComments();
    return open.map(comment => {
      const short = comment.body.length > 50
        ? comment.body.slice(0, 50) + '…'
        : comment.body;
      const node = new ReviewTreeItem(
        `$(circle-slash) ${comment.file}:${comment.line} — ${short}`,
        vscode.TreeItemCollapsibleState.None,
        'comment',
        { comment }
      );
      node.tooltip = `${comment.file} line ${comment.line}\nStatus: ${comment.status}\n\n${comment.body}`;
      node.description = comment.status;
      node.command = {
        command: 'commitReview.openPanel',
        title: 'Open Review',
        arguments: [comment.commitHash, comment.file],
      };
      return node;
    });
  }
}

function statusToIcon(status: string): string {
  switch (status) {
    case 'A': return '$(diff-added)';
    case 'D': return '$(diff-removed)';
    case 'R': return '$(diff-renamed)';
    default:  return '$(diff-modified)';
  }
}
