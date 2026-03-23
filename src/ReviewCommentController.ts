import * as vscode from 'vscode';
import { CommentManager, ReviewComment, CommentSnapshot, SnapshotLine } from './CommentManager';
import { GitContentProvider } from './GitContentProvider';
import { GitService } from './GitService';

// ── Status display labels ────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  'open':          'Open',
  'pending':       'Pending',
  'in-progress':   'In Progress',
  'outdated':      'Outdated',
  'resolved':      'Resolved',
  'wont-fix':      "Won't Fix",
  'question':      'Question',
  'agent-replied': 'Agent Replied',
  'addressed':     'Addressed',
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
  onCommentMutation?: () => void;

  private git: GitService | undefined;

  constructor(
    context: vscode.ExtensionContext,
    private comments: CommentManager,
  ) {
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
    this.repoPath   = repoPath;
    this.comments   = comments;
    this.git        = git;
    this.refresh();
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
        existing.label        = STATUS_LABELS[rc.status] ?? rc.status;
        existing.contextValue = `status:${rc.status}`;
        existing.comments     = this.buildComments(rc);
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
    thread.collapsibleState   = vscode.CommentThreadCollapsibleState.Expanded;
    thread.contextValue       = `status:${rc.status}`;
    thread.canReply           = true;
    thread.comments           = this.buildComments(rc);

    this.threads.set(rc.id, thread);
  }

  private buildComments(rc: ReviewComment): CRComment[] {
    const items: CRComment[] = [{
      reviewId:  rc.id,
      author:    { name: rc.author },
      body:      new vscode.MarkdownString(rc.body),
      mode:      vscode.CommentMode.Preview,
      label:     STATUS_LABELS[rc.status] ?? rc.status,
      timestamp: new Date(rc.createdAt),
    }];

    for (const entry of rc.thread) {
      items.push({
        reviewId:  rc.id,
        author:    { name: entry.author },
        body:      new vscode.MarkdownString(entry.body),
        mode:      vscode.CommentMode.Preview,
        timestamp: new Date(entry.createdAt),
      });
    }

    return items;
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

            this.comments.addComment({ commitHash, file, line, body: text.trim(), codeSnippet, snapshot });
            thread.dispose();  // Replace the temporary "pending" thread with a real one
          } else {
            // Reply to existing comment thread
            const first = thread.comments[0] as CRComment | undefined;
            if (first?.reviewId) {
              this.comments.addThreadReply(first.reviewId, 'reviewer', text.trim());
            }
          }

          this.refresh();
          this.onCommentMutation?.();
        },
      ),
    );

    // ── Status changes ──────────────────────────────────────────────────────
    const makeSetStatus = (status: ReviewComment['status']) =>
      (comment: CRComment) => {
        if (!comment?.reviewId) return;
        this.comments.updateStatus(comment.reviewId, status);
        this.refresh();
        this.onCommentMutation?.();
      };

    context.subscriptions.push(
      vscode.commands.registerCommand('commitReview.comment.setOpen',     makeSetStatus('open')),
      vscode.commands.registerCommand('commitReview.comment.setResolved', makeSetStatus('resolved')),
      vscode.commands.registerCommand('commitReview.comment.setWontFix',  makeSetStatus('wont-fix')),
      vscode.commands.registerCommand('commitReview.comment.setPending',  makeSetStatus('pending')),
    );

    // ── Delete ──────────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand('commitReview.comment.delete', (comment: CRComment) => {
        if (!comment?.reviewId) return;
        this.comments.deleteComment(comment.reviewId);
        this.threads.get(comment.reviewId)?.dispose();
        this.threads.delete(comment.reviewId);
        this.onCommentMutation?.();
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
