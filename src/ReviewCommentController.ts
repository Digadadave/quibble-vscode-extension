import * as vscode from 'vscode';
import { CommentManager, ReviewComment, CommentSnapshot, SnapshotLine } from './CommentManager';
import { GitContentProvider } from './GitContentProvider';
import { GitService } from './GitService';

// ── Status display labels ────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  'open':         'Open',
  'in-progress':  'In Progress',
  'needs-input':  'Needs Input',
  'addressed':    'Addressed',
  'resolved':     'Resolved',
  'dismissed':    'Dismissed',
  'outdated':     'Outdated',
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
      author:    { name: rc.author, iconPath: this.statusThemeIcon(rc.status) },
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
          name:     entry.author,
          iconPath: isAgent
            ? this.mediaUri('icon-agent.svg')
            : undefined,
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
        author:    { name: noteLabel, iconPath: this.mediaUri('icon-agent.svg') },
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
      case 'open':        return this.mediaUri('icon-status-open.svg');
      case 'in-progress': return this.mediaUri('icon-status-progress.svg');
      case 'needs-input': return this.mediaUri('icon-status-input.svg');
      case 'addressed':
      case 'resolved':    return this.mediaUri('icon-status-addressed.svg');
      case 'outdated':    return this.mediaUri('icon-status-outdated.svg');
      default:            return this.mediaUri('icon-status-default.svg');
    }
  }

  private isClosed(status: string): boolean {
    return ['resolved', 'dismissed', 'outdated'].includes(status);
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

    // ── Change Status (⚙ button on thread header) ────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'commitReview.comment.changeStatus',
        async (thread: vscode.CommentThread) => {
          const first = thread.comments[0] as CRComment | undefined;
          if (!first?.reviewId) return;

          const rc = this.comments.load().find(c => c.id === first.reviewId);
          if (!rc) return;

          // Only user-settable statuses — agent sets the others
          const allChoices: Array<{ label: string; description: string; status: ReviewComment['status'] }> = [
            { label: '$(circle-outline) Open',      description: 'Reopen for agent to address',    status: 'open' },
            { label: '$(pass-filled) Resolved',     description: 'Confirmed — work is acceptable', status: 'resolved' },
            { label: '$(circle-slash) Dismissed',   description: 'Skip — no action needed',        status: 'dismissed' },
          ];
          const choices = allChoices.filter(c => c.status !== rc.status);

          const picked = await vscode.window.showQuickPick(choices, {
            title: `Change Status — currently "${STATUS_LABELS[rc.status] ?? rc.status}"`,
            placeHolder: 'Select new status',
          });
          if (!picked) return;

          this.comments.updateStatus(first.reviewId, picked.status);
          this.refresh();
          this.onCommentMutation?.();
        },
      ),
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
