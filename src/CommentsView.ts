import * as vscode from 'vscode';
import { CommentManager, ReviewComment, CommentStatus } from './CommentManager';
import { ICONS, STATUS_COLORS } from './icons';

// ── Status metadata ──────────────────────────────────────────────────────────

const CLOSED_STATUSES = new Set<CommentStatus>(['approved', 'dismissed', 'outdated']);

interface StatusMeta {
  label: string;
  icon: string;          // codicon id
  color: vscode.ThemeColor;
}

const STATUS_META: Record<string, StatusMeta> = {
  'open':          { label: 'Open',          icon: ICONS.COMMENT_UNRESOLVED, color: new vscode.ThemeColor(STATUS_COLORS.open.token) },
  'question':      { label: 'Question',      icon: ICONS.QUESTION,           color: new vscode.ThemeColor(STATUS_COLORS.question.token) },
  'needs-input':   { label: 'Needs Input',   icon: ICONS.COMMENT_DISCUSSION_SPARKLE, color: new vscode.ThemeColor(STATUS_COLORS.question.token) },
  'agent-replied': { label: 'Agent Replied', icon: ICONS.COMMENT_DISCUSSION, color: new vscode.ThemeColor(STATUS_COLORS.replied.token) },
  'in-progress':   { label: 'In Progress',   icon: ICONS.COMMENT_DISCUSSION, color: new vscode.ThemeColor(STATUS_COLORS.replied.token) },
  'addressed':     { label: 'Addressed',     icon: ICONS.CHECK,              color: new vscode.ThemeColor(STATUS_COLORS.addressed.token) },
  'approved':      { label: 'Approved',      icon: ICONS.CHECK_ALL,          color: new vscode.ThemeColor(STATUS_COLORS.approved.token) },
  'dismissed':     { label: 'Dismissed',     icon: ICONS.SYNC_IGNORED,       color: new vscode.ThemeColor(STATUS_COLORS.dismissed.token) },
  'outdated':      { label: 'Outdated',      icon: ICONS.SYNC_IGNORED,       color: new vscode.ThemeColor(STATUS_COLORS.dismissed.token) },
};


// ── Tree items ────────────────────────────────────────────────────────────────

export class CommentTreeItem extends vscode.TreeItem {
  constructor(public readonly comment: ReviewComment) {
    const fname = comment.file.split('/').pop() ?? comment.file;
    const dir = comment.file.includes('/')
      ? comment.file.slice(0, comment.file.lastIndexOf('/'))
      : '';

    const hasChildren =
      (comment.thread && comment.thread.length > 0) ||
      !!comment.resolvedNote;

    super(
      `${fname}:${comment.line}`,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );

    // Description: truncated body
    const body = comment.body ?? '';
    this.description = body.length > 80 ? body.slice(0, 77) + '…' : body;

    // Icon: status-colored codicon
    const meta = STATUS_META[comment.status] ?? STATUS_META['open'];
    this.iconPath = new vscode.ThemeIcon(meta.icon, meta.color);

    // Tooltip: rich markdown with full details
    this.tooltip = this.buildTooltip(comment, dir);

    // TreeItem.command runs when the user clicks the row.
    // The command must be registered separately (see createTreeView()).
    this.command = {
      command: 'commitReview.comments.openDiff',
      title: 'Open in Diff',
      arguments: [comment],
    };

    // TreeItem.contextValue is matched against `when` clauses in package.json menus
    // (view/item/context), controlling which right-click menu items appear on each row.
    const isClosed = CLOSED_STATUSES.has(comment.status);
    this.contextValue = isClosed ? 'comment-approved'
      : comment.status === 'addressed' ? 'comment-addressed'
      : 'comment-open';

    this.id = comment.id;
  }

  private buildTooltip(c: ReviewComment, dir: string): vscode.MarkdownString {
    const meta = STATUS_META[c.status] ?? STATUS_META['open'];
    const md = new vscode.MarkdownString('', true);
    md.supportThemeIcons = true;
    md.isTrusted = true;

    md.appendMarkdown(`**$(${meta.icon}) ${meta.label}** — \`${c.file}:${c.line}\`\n\n`);
    if (dir) md.appendMarkdown(`*${dir}*\n\n`);
    md.appendMarkdown(`${c.body}\n\n`);

    if (c.codeSnippet) {
      md.appendMarkdown('```\n' + c.codeSnippet + '\n```\n\n');
    }

    if (c.thread && c.thread.length > 0) {
      md.appendMarkdown('---\n\n');
      for (const t of c.thread) {
        const icon = t.author !== 'reviewer' ? `$(${ICONS.HUBOT})` : `$(${ICONS.PERSON})`;
        md.appendMarkdown(`${icon} **${t.author}**: ${t.body}\n\n`);
      }
    }

    if (c.resolvedNote) {
      md.appendMarkdown('---\n\n');
      md.appendMarkdown(`$(${ICONS.HUBOT}) *${c.resolvedNote}*\n`);
    }

    if (c.createdAt) {
      md.appendMarkdown(`\n\n*${formatDate(c.createdAt)}*`);
    }

    return md;
  }
}

export class ThreadTreeItem extends vscode.TreeItem {
  constructor(
    public readonly author: string,
    public readonly body: string,
    public readonly createdAt: string,
    public readonly isAgent: boolean,
    public readonly parentComment: ReviewComment,
  ) {
    super(author, vscode.TreeItemCollapsibleState.None);

    this.description = body.length > 80 ? body.slice(0, 77) + '…' : body;
    this.iconPath = new vscode.ThemeIcon(
      isAgent ? ICONS.HUBOT : ICONS.PERSON,
      isAgent
        ? new vscode.ThemeColor('terminal.ansiMagenta')
        : new vscode.ThemeColor('foreground'),
    );

    const md = new vscode.MarkdownString('', true);
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${author}**\n\n${body}`);
    if (createdAt) md.appendMarkdown(`\n\n*${formatDate(createdAt)}*`);
    this.tooltip = md;

    // Click → navigate to parent comment in diff
    this.command = {
      command: 'commitReview.comments.openDiff',
      title: 'Open in Diff',
      arguments: [parentComment],
    };
    this.contextValue = 'threadEntry';
  }
}

export class ResolvedNoteTreeItem extends vscode.TreeItem {
  constructor(
    public readonly comment: ReviewComment,
  ) {
    const noteLabel =
      comment.status === 'needs-input'  ? 'Agent Note'
      : comment.status === 'outdated'   ? 'Outdated'
      : comment.status === 'addressed'  ? 'Agent Update'
      : 'Agent Note';

    super(noteLabel, vscode.TreeItemCollapsibleState.None);

    this.description = (comment.resolvedNote ?? '').length > 80
      ? comment.resolvedNote!.slice(0, 77) + '…'
      : comment.resolvedNote ?? '';

    this.iconPath = new vscode.ThemeIcon(ICONS.HUBOT, new vscode.ThemeColor('terminal.ansiMagenta'));

    const md = new vscode.MarkdownString('', true);
    md.supportThemeIcons = true;
    md.appendMarkdown(`$(${ICONS.HUBOT}) **${noteLabel}**\n\n${comment.resolvedNote}`);
    if (comment.addressedAt) md.appendMarkdown(`\n\n*${formatDate(comment.addressedAt)}*`);
    this.tooltip = md;

    // Click → navigate to parent comment in diff
    this.command = {
      command: 'commitReview.comments.openDiff',
      title: 'Open in Diff',
      arguments: [comment],
    };
    this.contextValue = 'resolvedNote';
  }
}

// ── TreeDataProvider ──────────────────────────────────────────────────────────
// Implementing TreeDataProvider<T> makes this class a data source for a VS Code
// TreeView. VS Code calls getChildren(element) to build the tree bottom-up:
//   getChildren(undefined) → root items
//   getChildren(item)      → children of that item
// getTreeItem(element) converts a data element into a display-ready TreeItem.

export class CommentsView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  static readonly viewType = 'commitReview.commentsView';
  private static instance: CommentsView | undefined;

  // Firing this event tells VS Code to call getChildren() again and re-render the tree.
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private treeView: vscode.TreeView<vscode.TreeItem> | undefined;
  private disposables: vscode.Disposable[] = [];
  private showClosed = false;
  /** Snapshot of comments for the current refresh cycle. Null outside refresh(). */
  private _cachedComments: ReviewComment[] | null = null;

  /** Called when the user clicks a comment — open the diff at that commit and scroll to the comment. */
  onFocusComment?: (file: string, line: number, commitHash: string, commentId: string) => void;

  /** Called when the user deletes a comment. */
  onDeleteComment?: (id: string) => void;

  /** Called when the user changes a comment's status. */
  onUpdateStatus?: (id: string, status: string) => void;

  private constructor(
    private context: vscode.ExtensionContext,
    private comments: CommentManager,
  ) {}

  // ── Factory ───────────────────────────────────────────────────────────────

  static register(
    context: vscode.ExtensionContext,
    comments: CommentManager,
  ): CommentsView {
    if (!CommentsView.instance) {
      CommentsView.instance = new CommentsView(context, comments);
    } else {
      CommentsView.instance.comments = comments;
    }
    return CommentsView.instance;
  }

  /** Call after register() to create the TreeView and register commands. */
  createTreeView(): vscode.TreeView<vscode.TreeItem> {
    this.treeView = vscode.window.createTreeView(CommentsView.viewType, {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables.push(this.treeView);

    // Register commands
    this.disposables.push(
      vscode.commands.registerCommand('commitReview.comments.openDiff', (comment: ReviewComment) => {
        this.onFocusComment?.(comment.file, comment.line, comment.commitHash, comment.id);
      }),
      vscode.commands.registerCommand('commitReview.comments.resolve', (item: CommentTreeItem) => {
        this.onUpdateStatus?.(item.comment.id, 'approved');
      }),
      vscode.commands.registerCommand('commitReview.comments.dismiss', (item: CommentTreeItem) => {
        this.onUpdateStatus?.(item.comment.id, 'dismissed');
      }),
      vscode.commands.registerCommand('commitReview.comments.reopen', (item: CommentTreeItem) => {
        this.onUpdateStatus?.(item.comment.id, 'open');
      }),
      vscode.commands.registerCommand('commitReview.comments.delete', (item: CommentTreeItem) => {
        this.onDeleteComment?.(item.comment.id);
      }),
      vscode.commands.registerCommand('commitReview.comments.showAll', () => {
        this.showClosed = true;
        vscode.commands.executeCommand('setContext', 'commitReview.showClosed', true);
        this.refresh();
      }),
      vscode.commands.registerCommand('commitReview.comments.hideClosed', () => {
        this.showClosed = false;
        vscode.commands.executeCommand('setContext', 'commitReview.showClosed', false);
        this.refresh();
      }),
    );

    vscode.commands.executeCommand('setContext', 'commitReview.showClosed', false);
    this.updateViewDescription();
    return this.treeView;
  }

  /** Update services when the active repo changes. */
  updateServices(comments: CommentManager): void {
    this.comments = comments;
    this.refresh();
  }

  // ── TreeDataProvider ───────────────────────────────────────────────────────

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      // Root: filtered comment list
      return this.getFilteredComments().map(c => new CommentTreeItem(c));
    }

    if (element instanceof CommentTreeItem) {
      const c = element.comment;
      const children: vscode.TreeItem[] = [];

      // Thread entries
      if (c.thread) {
        for (const t of c.thread) {
          children.push(new ThreadTreeItem(
            t.author,
            t.body,
            t.createdAt,
            t.author !== 'reviewer',
            c,
          ));
        }
      }

      // Resolved note
      if (c.resolvedNote) {
        children.push(new ResolvedNoteTreeItem(c));
      }

      return children;
    }

    return [];
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  /** Show loading state immediately (call before slow work begins). */
  showLoading(): void {
    if (this.treeView) { this.treeView.message = 'Loading…'; }
  }

  refresh(): void {
    if (this.treeView) { this.treeView.message = undefined; }
    // Snapshot once for the entire refresh cycle (getChildren + description + badge)
    this._cachedComments = this.comments.load();
    this._onDidChangeTreeData.fire();
    this.updateViewDescription();
    this.updateViewBadge();
    this._cachedComments = null;
  }

  private getFilteredComments(): ReviewComment[] {
    const all = this._cachedComments ?? this.comments.load();
    return this.showClosed ? all : all.filter(c => !CLOSED_STATUSES.has(c.status));
  }

  private updateViewDescription(): void {
    if (!this.treeView) return;
    const all = this._cachedComments ?? this.comments.load();
    const openCount   = all.filter(c => !CLOSED_STATUSES.has(c.status)).length;
    const closedCount = all.filter(c =>  CLOSED_STATUSES.has(c.status)).length;
    this.treeView.description = `${openCount} open, ${closedCount} closed`;
  }

  private updateViewBadge(): void {
    if (!this.treeView) return;
    const all = this._cachedComments ?? this.comments.load();
    const openCount = all.filter(c => !CLOSED_STATUSES.has(c.status)).length;
    // treeView.badge is the notification count shown on the sidebar panel icon.
    this.treeView.badge = openCount > 0
      ? { value: openCount, tooltip: `${openCount} open comment${openCount !== 1 ? 's' : ''}` }
      : undefined;
  }

  dispose(): void {
    CommentsView.instance = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);
    if (mins  < 60)  return `${mins}m ago`;
    if (hours < 24)  return `${hours}h ago`;
    if (days  < 30)  return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return iso; }
}
