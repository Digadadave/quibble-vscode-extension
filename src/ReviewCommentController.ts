/**
 * ReviewCommentController.ts — Bridges our comment data with VS Code's native
 * comment UI (the gutter icons and threaded comment panels in diff editors).
 *
 * VS Code comment API concepts:
 *
 * • `vscode.CommentController` — the top-level owner. Create one per extension.
 *   It manages all `CommentThread` instances and appears in the Comments panel.
 *
 * • `CommentThread` — a single collapsible thread pinned to a specific range in
 *   a document URI. Each thread holds an array of `vscode.Comment` entries (the
 *   individual messages). Threads are rendered as inline annotations in the editor
 *   and listed in the COMMENTS sidebar panel.
 *
 * • `commentingRangeProvider` — controls which documents/lines show the "+" gutter
 *   icon that lets the user start a new comment. We restrict this to the new (right)
 *   side of our custom `commit-review-git://` diff URIs.
 *
 * • `CRComment extends vscode.Comment` — we add a `reviewId` field so that command
 *   handlers (delete, status-change) can identify which stored record to mutate.
 *
 * Comment commands (resolve, dismiss, reopen, delete) are wired in package.json
 * under `contributes.menus` → `comments/commentThread/title` and
 * `comments/commentThread/context`. The `contextValue` on each thread (e.g.
 * `"status:open"`) controls which menu items are shown via `when` clauses.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { CommentManager, ReviewComment, CommentSnapshot, SnapshotLine } from './CommentManager';
import { GitContentProvider } from './GitContentProvider';
import { GitService } from './GitService';
import { ICON_FILES } from './icons';

// ── Status display labels ────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  'open':          'Open',
  'question':      'Question',
  'agent-replied': 'Agent Replied',
  'in-progress':   'In Progress',
  'needs-input':   'Needs Input',
  'addressed':     'Addressed',
  'approved':      'Approved',
  'dismissed':     'Dismissed',
  'outdated':      'Outdated',
};

// ── Extended Comment interface ────────────────────────────────────────────────

/**
 * We extend vscode.Comment to carry the internal review comment ID so status-
 * change / delete commands can identify which record to mutate.
 */
interface CRComment extends vscode.Comment {
  reviewId: string;
}

// ── Controller ───────────────────────────────────────────────────────────────

export class ReviewCommentController implements vscode.Disposable {
  static readonly id = 'commit-review';

  private controller: vscode.CommentController;
  /** Map from ReviewComment.id → the live VS Code thread. */
  private threads = new Map<string, vscode.CommentThread>();
  private disposables: vscode.Disposable[] = [];
  private repoPath = '';

  /** Called after any mutation so the sidebar counts / status bar stay fresh. */
  onCommentMutation?: (id?: string) => void;

  private git: GitService | undefined;
  private gitUserName = 'reviewer';
  private readonly extensionUri: vscode.Uri;

  constructor(
    context: vscode.ExtensionContext,
    private comments: CommentManager,
  ) {
    this.extensionUri = context.extensionUri;
    this.controller = vscode.comments.createCommentController(
      ReviewCommentController.id,
      'Commit Review',
    );
    this.controller.options = {
      prompt:      'Leave a review comment…',
      placeHolder: 'Write a comment…',
    };

    // Show the gutter icon only on the new (right) side of our custom diffs.
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (document.uri.scheme !== GitContentProvider.scheme) return [];
        const params = new URLSearchParams(document.uri.query);
        if (params.get('side') !== 'new') return [];
        return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
      },
    };

    this.disposables.push(this.controller);
    this.registerCommands(context);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Switch to a new repo / CommentManager and reload all threads. */
  updateRepo(repoPath: string, comments: CommentManager, git: GitService): void {
    this.repoPath     = repoPath;
    this.comments     = comments;
    this.git          = git;
    this.gitUserName  = git.getUserName();
    this.refresh();
  }

  /**
   * Update a single thread by comment id. Faster than full refresh() for
   * targeted mutations (status change, reply) where only one comment changed.
   */
  refreshComment(id: string): void {
    if (!this.repoPath) return;
    const all = this.comments.load();
    const rc = all.find(c => c.id === id);
    if (!rc) {
      // Deleted — remove thread
      this.threads.get(id)?.dispose();
      this.threads.delete(id);
      return;
    }
    const existing = this.threads.get(rc.id);
    if (existing) {
      existing.label          = STATUS_LABELS[rc.status] ?? rc.status;
      existing.contextValue   = `status:${rc.status}`;
      existing.comments       = this.buildComments(rc);
      existing.collapsibleState = this.isClosed(rc.status)
        ? vscode.CommentThreadCollapsibleState.Collapsed
        : vscode.CommentThreadCollapsibleState.Expanded;
    } else {
      this.createThread(rc);
    }
  }

  /**
   * Sync live threads with the current state of CommentManager.
   * Existing threads are updated in-place to avoid closing open reply boxes.
   */
  refresh(): void {
    if (!this.repoPath) return;
    const all = this.comments.load();
    const liveIds = new Set(all.map(c => c.id));

    // Remove threads whose underlying comment was deleted.
    for (const [id, thread] of this.threads) {
      if (!liveIds.has(id)) { thread.dispose(); this.threads.delete(id); }
    }

    for (const rc of all) {
      const existing = this.threads.get(rc.id);
      if (existing) {
        existing.label          = STATUS_LABELS[rc.status] ?? rc.status;
        existing.contextValue   = `status:${rc.status}`;
        existing.comments       = this.buildComments(rc);
        existing.collapsibleState = this.isClosed(rc.status)
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
      } else {
        this.createThread(rc);
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private createThread(rc: ReviewComment): void {
    const uri  = GitContentProvider.makeUri(this.repoPath, rc.file, rc.commitHash, 'new');
    const line = Math.max(0, rc.line - 1);

    const thread = this.controller.createCommentThread(
      uri,
      new vscode.Range(line, 0, line, 0),
      [],
    );
    thread.label              = STATUS_LABELS[rc.status] ?? rc.status;
    thread.collapsibleState   = this.isClosed(rc.status)
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
    thread.contextValue       = `status:${rc.status}`;
    thread.canReply           = true;
    thread.comments           = this.buildComments(rc);

    this.threads.set(rc.id, thread);
  }

  private buildComments(rc: ReviewComment): CRComment[] {
    const items: CRComment[] = [{
      reviewId:  rc.id,
      author:    { name: rc.author === 'reviewer' ? this.gitUserName : rc.author, iconPath: this.statusThemeIcon(rc.status) },
      body:      new vscode.MarkdownString(rc.body),
      mode:      vscode.CommentMode.Preview,
      label:     STATUS_LABELS[rc.status] ?? rc.status,
      timestamp: new Date(rc.createdAt),
    }];

    for (const entry of rc.thread) {
      const isAgent = entry.author !== 'reviewer';
      items.push({
        reviewId:  rc.id,
        author:    {
          name:     entry.author === 'reviewer' ? this.gitUserName : entry.author,
          iconPath: isAgent
            ? this.mediaUri(ICON_FILES.AGENT)
            : this.mediaUri(ICON_FILES.BLANK),
        },
        body:      new vscode.MarkdownString(entry.body),
        mode:      vscode.CommentMode.Preview,
        timestamp: new Date(entry.createdAt),
      });
    }

    // Show the agent's resolvedNote as a pinned note in the thread
    if (rc.resolvedNote) {
      const noteLabel = rc.status === 'needs-input'    ? '🔔 Agent Note'
                      : rc.status === 'outdated'        ? '⚠️ Outdated'
                      : rc.status === 'addressed'       ? '✅ Agent Update'
                      : 'Agent Note';
      items.push({
        reviewId:  rc.id,
        author:    { name: noteLabel, iconPath: this.mediaUri(ICON_FILES.AGENT) },
        body:      new vscode.MarkdownString(rc.resolvedNote),
        mode:      vscode.CommentMode.Preview,
        timestamp: rc.addressedAt ? new Date(rc.addressedAt) : undefined,
      });
    }

    return items;
  }

  private mediaUri(filename: string): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'media', filename);
  }

  private statusThemeIcon(status: string): vscode.Uri {
    switch (status) {
      case 'open':          return this.mediaUri(ICON_FILES.STATUS_OPEN);
      case 'question':
      case 'needs-input':   return this.mediaUri(ICON_FILES.STATUS_QUESTION);
      case 'agent-replied':
      case 'in-progress':   return this.mediaUri(ICON_FILES.STATUS_REPLIED);
      case 'addressed':     return this.mediaUri(ICON_FILES.STATUS_ADDRESSED);
      case 'approved':      return this.mediaUri(ICON_FILES.STATUS_APPROVED);
      case 'dismissed':
      case 'outdated':      return this.mediaUri(ICON_FILES.STATUS_DISMISSED);
      default:              return this.mediaUri(ICON_FILES.STATUS_DEFAULT);
    }
  }

  private isClosed(status: string): boolean {
    return ['approved', 'dismissed', 'outdated'].includes(status);
  }

  // ── Snapshot capture ─────────────────────────────────────────────────────

  /**
   * Fetch the file content at `commitHash` and extract the 3 lines before,
   * the target line, and 3 lines after — matching the `snapshot` schema.
   */
  private captureSnapshot(commitHash: string, file: string, line: number): CommentSnapshot | null {
    if (!this.git) return null;
    try {
      const content = this.git.getFileContentAtCommit(commitHash, file);
      const all     = content.split('\n');
      const idx     = line - 1; // 0-based

      const before: SnapshotLine[] = [];
      for (let i = Math.max(0, idx - 3); i < idx; i++) {
        before.push({ line: i + 1, content: all[i] ?? '' });
      }
      const target: SnapshotLine[] = [{ line, content: all[idx] ?? '' }];
      const after: SnapshotLine[] = [];
      for (let i = idx + 1; i <= Math.min(all.length - 1, idx + 3); i++) {
        after.push({ line: i + 1, content: all[i] ?? '' });
      }

      return { before, target, after };
    } catch {
      return null;
    }
  }

  // ── Command registration ──────────────────────────────────────────────────

  private registerCommands(context: vscode.ExtensionContext): void {

    // ── Submit / reply ──────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'commitReview.comment.reply',
        (reply: vscode.CommentReply) => {
          const { thread, text } = reply;
          if (!text.trim()) return;

          if (thread.comments.length === 0) {
            // New comment from the gutter
            const params      = new URLSearchParams(thread.uri.query);
            const commitHash  = params.get('ref') ?? '';
            const file        = thread.uri.path.startsWith('/') ? thread.uri.path.slice(1) : thread.uri.path;
            const line        = (thread.range?.start.line ?? 0) + 1;

            const snapshot    = this.captureSnapshot(commitHash, file, line);
            const codeSnippet = snapshot?.target.map(l => l.content).join('\n') ?? '';

            const added = this.comments.addComment({ commitHash, file, line, body: text.trim(), codeSnippet, snapshot });
            thread.dispose();  // Replace the temporary "pending" thread with a real one
            this.refresh();
            this.onCommentMutation?.(added.id);
          } else {
            // Reply to existing comment thread
            const first = thread.comments[0] as CRComment | undefined;
            if (first?.reviewId) {
              this.comments.addThreadReply(first.reviewId, 'reviewer', text.trim());
              this.refreshComment(first.reviewId);
              this.onCommentMutation?.(first.reviewId);
            }
          }
        },
      ),
    );

    // ── Resolve / Dismiss / Reopen ────────────────────────────────────────────
    // Commands are wired to BOTH:
    //   • comments/commentThread/title  → receives vscode.CommentThread (icon buttons)
    //   • comments/commentThread/context → receives vscode.CommentReply (text buttons)
    // If called from the reply box with text, the reply is submitted before the status changes.

    const makeStatusAction = (status: ReviewComment['status']) =>
      (arg: vscode.CommentThread | vscode.CommentReply) => {
        // Differentiate between the two call sites by checking for `text` property
        const isReply = arg && typeof (arg as vscode.CommentReply).text === 'string';
        const thread  = isReply ? (arg as vscode.CommentReply).thread : (arg as vscode.CommentThread);
        const text    = isReply ? (arg as vscode.CommentReply).text   : '';

        const first = thread.comments[0] as CRComment | undefined;
        if (!first?.reviewId) return;

        // If called from the reply box and the user typed something, save the reply first
        if (text.trim()) {
          this.comments.addThreadReply(first.reviewId, 'reviewer', text.trim());
        }

        this.comments.updateStatus(first.reviewId, status);
        this.refreshComment(first.reviewId);
        this.onCommentMutation?.(first.reviewId);
      };

    context.subscriptions.push(
      vscode.commands.registerCommand('commitReview.comment.resolve', makeStatusAction('approved')),
      vscode.commands.registerCommand('commitReview.comment.dismiss', makeStatusAction('dismissed')),
      vscode.commands.registerCommand('commitReview.comment.reopen',  makeStatusAction('open')),
      vscode.commands.registerCommand('commitReview.comment.gotoFile', (thread: vscode.CommentThread) => {
        const params   = new URLSearchParams(thread.uri.query);
        const repoPath = params.get('repo') ?? '';
        const filePath = thread.uri.path.startsWith('/') ? thread.uri.path.slice(1) : thread.uri.path;
        const line     = thread.range?.start.line ?? 0;

        const absUri = vscode.Uri.file(path.join(repoPath, filePath));
        vscode.workspace.openTextDocument(absUri).then(doc => {
          vscode.window.showTextDocument(doc, { preview: false }).then(editor => {
            const pos = new vscode.Position(line, 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          });
        });
      }),
    );

    // Cancel — only disposes new (unsaved) threads; for existing threads VS Code closes the reply box automatically
    context.subscriptions.push(
      vscode.commands.registerCommand('commitReview.comment.cancelThread', (reply: vscode.CommentReply) => {
        if (reply.thread.comments.length === 0) {
          reply.thread.dispose();
        }
      }),
    );

    // ── Delete ──────────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand('commitReview.comment.delete', (thread: vscode.CommentThread) => {
        const first = thread?.comments?.[0] as CRComment | undefined;
        if (!first?.reviewId) return;
        const deletedId = first.reviewId;
        this.comments.deleteComment(deletedId);
        this.threads.get(deletedId)?.dispose();
        this.threads.delete(deletedId);
        this.onCommentMutation?.(deletedId);
      }),
    );
  }

  // ── Disposable ────────────────────────────────────────────────────────────

  dispose(): void {
    for (const thread of this.threads.values()) thread.dispose();
    this.threads.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
