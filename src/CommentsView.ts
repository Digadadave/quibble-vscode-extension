import * as vscode from 'vscode';
import { CommentManager, ReviewComment, CommentStatus, STATUS, CLOSED_STATUSES } from './CommentManager';
import { ICONS, STATUS_COLORS } from './icons';

// ── Status metadata ──────────────────────────────────────────────────────────

const ADDRESSED_STATUSES   = new Set<CommentStatus>([STATUS.ADDRESSED, STATUS.ADDRESSED_NO_CHANGE]);
const NO_CODE_NAV_STATUSES = new Set<CommentStatus>([STATUS.ADDRESSED_NO_CHANGE, STATUS.NEEDS_INPUT]);

interface StatusMeta {
  label: string;
  icon: string;          // codicon id
  color: vscode.ThemeColor;
}

const STATUS_META: Record<CommentStatus, StatusMeta> = {
  [STATUS.OPEN]:                { label: 'Open',                  icon: ICONS.COMMENT_UNRESOLVED,       color: new vscode.ThemeColor(STATUS_COLORS.open.token) },
  [STATUS.NEEDS_INPUT]:         { label: 'Needs Input',           icon: ICONS.FEEDBACK,                 color: new vscode.ThemeColor(STATUS_COLORS.question.token) },
  [STATUS.IN_PROGRESS]:         { label: 'In Progress',           icon: ICONS.EDIT_SPARKLE,             color: new vscode.ThemeColor(STATUS_COLORS.replied.token) },
  [STATUS.ADDRESSED]:           { label: 'Addressed',             icon: ICONS.CHECK,                    color: new vscode.ThemeColor(STATUS_COLORS.addressed.token) },
  [STATUS.ADDRESSED_NO_CHANGE]: { label: 'Addressed (No Change)', icon: ICONS.COMMENT_DISCUSSION_QUOTE, color: new vscode.ThemeColor(STATUS_COLORS.replied.token) },
  [STATUS.APPROVED]:            { label: 'Approved',              icon: ICONS.CHECK_ALL,                color: new vscode.ThemeColor(STATUS_COLORS.approved.token) },
  [STATUS.DISMISSED]:           { label: 'Dismissed',             icon: ICONS.SYNC_IGNORED,             color: new vscode.ThemeColor(STATUS_COLORS.dismissed.token) },
  [STATUS.OUTDATED]:            { label: 'Outdated',              icon: ICONS.SYNC_IGNORED,             color: new vscode.ThemeColor(STATUS_COLORS.dismissed.token) },
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
    const meta = STATUS_META[comment.status] ?? STATUS_META[STATUS.OPEN];
    this.iconPath = new vscode.ThemeIcon(meta.icon, meta.color);

    // Tooltip: rich markdown with full details
    this.tooltip = this.buildTooltip(comment, dir);

    // TreeItem.command runs when the user clicks the row.
    // Skip for statuses where no code change was made — there's nothing to diff.
    if (!NO_CODE_NAV_STATUSES.has(comment.status)) {
      this.command = {
        command: 'quibble.comments.openDiff',
        title: 'Open in Diff',
        arguments: [comment],
      };
    }

    // TreeItem.contextValue is matched against `when` clauses in package.json menus
    // (view/item/context), controlling which right-click menu items appear on each row.
    this.contextValue = CLOSED_STATUSES.has(comment.status)    ? 'comment-approved'
      : ADDRESSED_STATUSES.has(comment.status)                 ? 'comment-addressed'
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
      command: 'quibble.comments.openDiff',
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
      comment.status === STATUS.NEEDS_INPUT  ? 'Agent Note'
      : comment.status === STATUS.OUTDATED   ? 'Outdated'
      : comment.status === STATUS.ADDRESSED  ? 'Agent Update'
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

    // Click → navigate to the comment in the diff
    this.command = {
      command: 'quibble.comments.openDiff',
      title: 'Open in Diff',
      arguments: [comment],
    };

    // contextValue drives the "View Fix" inline button (see package.json menus)
    this.contextValue = comment.status === STATUS.ADDRESSED && comment.addressedByCommit
      ? 'resolvedNote-fix'
      : 'resolvedNote';
  }
}

// ── TreeDataProvider ──────────────────────────────────────────────────────────
// Implementing TreeDataProvider<T> makes this class a data source for a VS Code
// TreeView. VS Code calls getChildren(element) to build the tree bottom-up:
//   getChildren(undefined) → root items
//   getChildren(item)      → children of that item
// getTreeItem(element) converts a data element into a display-ready TreeItem.

export class CommentsView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  static readonly viewType = 'quibble.commentsView';
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
      vscode.commands.registerCommand('quibble.comments.openDiff', (comment: ReviewComment) => {
        this.onFocusComment?.(comment.file, comment.line, comment.commitHash, comment.id);
      }),
      vscode.commands.registerCommand('quibble.comments.resolve', (item: CommentTreeItem) => {
        this.onUpdateStatus?.(item.comment.id, STATUS.APPROVED);
      }),
      vscode.commands.registerCommand('quibble.comments.dismiss', (item: CommentTreeItem) => {
        this.onUpdateStatus?.(item.comment.id, STATUS.DISMISSED);
      }),
      vscode.commands.registerCommand('quibble.comments.reopen', (item: CommentTreeItem) => {
        this.onUpdateStatus?.(item.comment.id, STATUS.OPEN);
      }),
      vscode.commands.registerCommand('quibble.comments.delete', (item: CommentTreeItem) => {
        this.onDeleteComment?.(item.comment.id);
      }),
      vscode.commands.registerCommand('quibble.comments.showAll', () => {
        this.showClosed = true;
        vscode.commands.executeCommand('setContext', 'quibble.showClosed', true);
        this.refresh();
      }),
      vscode.commands.registerCommand('quibble.comments.hideClosed', () => {
        this.showClosed = false;
        vscode.commands.executeCommand('setContext', 'quibble.showClosed', false);
        this.refresh();
      }),
      vscode.commands.registerCommand('quibble.comments.viewFix', (item: ResolvedNoteTreeItem) => {
        if (item.comment.addressedByCommit) {
          vscode.commands.executeCommand('quibble.viewFix', item.comment.addressedByCommit);
        }
      }),
    );

    vscode.commands.executeCommand('setContext', 'quibble.showClosed', false);
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
    // Snapshot once for the entire refresh cycle (getChildren + description + badge)
    this._cachedComments = this.comments.load();
    this._onDidChangeTreeData.fire();
    this.updateViewDescription();
    this.updateViewBadge();
    this.updateEmptyMessage();
    this._cachedComments = null;
  }

  private updateEmptyMessage(): void {
    if (!this.treeView) return;
    const all = this._cachedComments ?? this.comments.load();
    const filtered = this.getFilteredComments();
    if (filtered.length > 0) {
      this.treeView.message = undefined;
    } else if (all.length === 0) {
      this.treeView.message = 'No comments yet. Open a diff and add your first comment.';
    } else {
      this.treeView.message = 'All comments are closed.';
    }
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
