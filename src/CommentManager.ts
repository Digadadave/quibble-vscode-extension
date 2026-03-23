import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

export type CommentStatus = 'open' | 'question' | 'agent-replied' | 'addressed' |
  'in-progress' | 'outdated' | 'pending' | 'resolved' | 'wont-fix';

export interface ThreadEntry {
  author: string;
  body: string;
  createdAt: string;
}

export interface SnapshotLine {
  line: number;
  content: string;
}

export interface CommentSnapshot {
  before: SnapshotLine[];
  target: SnapshotLine[];
  after: SnapshotLine[];
}

export interface ReviewComment {
  id: string;
  status: CommentStatus;
  commitHash: string;
  file: string;
  line: number;
  lineEnd: number;
  /** 'left' = old file side, 'right' = new file side */
  side: 'left' | 'right';
  body: string;
  author: string;
  createdAt: string;
  thread: ThreadEntry[];
  addressedAt: string | null;
  addressedByCommit: string | null;
  codeSnippet: string;
  /** Written by the agent when updating status. Null until the agent acts. */
  resolvedNote: string | null;
  /** Code context captured at comment creation time. */
  snapshot: CommentSnapshot | null;
}

interface ReviewStore {
  _schema?: unknown;
  version: number;
  reviews: ReviewComment[];
}

const DEFAULT_REVIEWS_RELPATH = '.vscode/commit-reviews.json';

export class CommentManager implements vscode.Disposable {
  private reviewsPath: string;
  private watcher: vscode.FileSystemWatcher | undefined;
  /** Prevents the file watcher from echoing back our own saves. */
  private suppressNextWatchEvent = false;

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /**
   * @param repoPath  Absolute path to the repository root.
   * @param relPath   Path to reviews file relative to repoPath.
   *                  Defaults to the `commitReview.reviewsPath` setting,
   *                  falling back to `.vscode/commit-reviews.json`.
   */
  constructor(
    private repoPath: string,
    relPath?: string
  ) {
    const configured = relPath
      ?? vscode.workspace.getConfiguration('commitReview').get<string>('reviewsPath')
      ?? DEFAULT_REVIEWS_RELPATH;
    this.reviewsPath = path.join(repoPath, configured);
  }

  /** Start watching the reviews file for external changes (e.g. agent writes). */
  startWatching(): void {
    if (!this.repoPath) return;
    const rel = path.relative(this.repoPath, this.reviewsPath).replace(/\\/g, '/');
    const pattern = new vscode.RelativePattern(this.repoPath, rel);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const maybefire = () => {
      if (this.suppressNextWatchEvent) { this.suppressNextWatchEvent = false; return; }
      this._onDidChange.fire();
    };
    this.watcher.onDidChange(maybefire);
    this.watcher.onDidCreate(maybefire);
  }

  private cachedSchema: unknown = undefined;

  load(): ReviewComment[] {
    if (!fs.existsSync(this.reviewsPath)) return [];
    try {
      const store: ReviewStore = JSON.parse(fs.readFileSync(this.reviewsPath, 'utf8'));
      // Preserve the _schema block so save() can write it back unchanged.
      if (store._schema !== undefined) this.cachedSchema = store._schema;
      return store.reviews ?? [];
    } catch {
      return [];
    }
  }

  save(comments: ReviewComment[]): void {
    const dir = path.dirname(this.reviewsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Suppress the file-watcher echo so we don't trigger a second refreshAll
    this.suppressNextWatchEvent = true;
    // Re-read to pick up any _schema block written by an agent.
    if (this.cachedSchema === undefined && fs.existsSync(this.reviewsPath)) {
      try {
        const existing: ReviewStore = JSON.parse(fs.readFileSync(this.reviewsPath, 'utf8'));
        if (existing._schema !== undefined) this.cachedSchema = existing._schema;
      } catch { /* ignore */ }
    }
    const store: ReviewStore = {
      ...(this.cachedSchema !== undefined ? { _schema: this.cachedSchema } : {}),
      version: 1,
      reviews: comments,
    };
    fs.writeFileSync(this.reviewsPath, JSON.stringify(store, null, 2), 'utf8');
    // Do NOT fire _onDidChange here — internal mutations use onCommentMutation callback.
    // External/agent changes use the file watcher.
  }

  addComment(params: {
    commitHash: string;
    file: string;
    line: number;
    lineEnd?: number;
    side?: 'left' | 'right';
    body: string;
    author?: string;
    codeSnippet?: string;
    snapshot?: CommentSnapshot | null;
  }): ReviewComment {
    const comments = this.load();
    const comment: ReviewComment = {
      id: `cr_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
      status: 'open',
      commitHash: params.commitHash,
      file: params.file,
      line: params.line,
      lineEnd: params.lineEnd ?? params.line,
      side: params.side ?? 'right',
      body: params.body,
      author: params.author ?? 'reviewer',
      createdAt: new Date().toISOString(),
      thread: [],
      addressedAt: null,
      addressedByCommit: null,
      codeSnippet: params.codeSnippet ?? '',
      resolvedNote: null,
      snapshot: params.snapshot ?? null,
    };
    comments.push(comment);
    this.save(comments);
    return comment;
  }

  updateStatus(id: string, status: CommentStatus): boolean {
    const comments = this.load();
    const comment = comments.find(c => c.id === id);
    if (!comment) return false;
    comment.status = status;
    if (status === 'addressed') {
      comment.addressedAt = new Date().toISOString();
    }
    this.save(comments);
    return true;
  }

  deleteComment(id: string): boolean {
    const comments = this.load();
    const idx = comments.findIndex(c => c.id === id);
    if (idx === -1) return false;
    comments.splice(idx, 1);
    this.save(comments);
    return true;
  }

  addThreadReply(id: string, author: string, body: string): boolean {
    const comments = this.load();
    const comment = comments.find(c => c.id === id);
    if (!comment) return false;
    comment.thread.push({ author, body, createdAt: new Date().toISOString() });
    if (author !== 'reviewer' && comment.status === 'open') {
      comment.status = 'agent-replied';
    }
    this.save(comments);
    return true;
  }

  /** Add a question thread entry with author='reviewer' and set status to 'question'. */
  askQuestion(id: string, questionBody: string): boolean {
    const comments = this.load();
    const comment = comments.find(c => c.id === id);
    if (!comment) return false;
    comment.thread.push({ author: 'reviewer', body: questionBody, createdAt: new Date().toISOString() });
    comment.status = 'question';
    this.save(comments);
    return true;
  }

  getOpenComments(): ReviewComment[] {
    return this.load().filter(c => c.status === 'open' || c.status === 'question' || c.status === 'agent-replied');
  }

  getCommentsForCommit(hash: string): ReviewComment[] {
    return this.load().filter(c => c.commitHash === hash);
  }

  getReviewsFilePath(): string {
    return this.reviewsPath;
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }
}
