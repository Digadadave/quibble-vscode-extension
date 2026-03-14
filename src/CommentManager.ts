import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

export type CommentStatus = 'open' | 'agent-replied' | 'addressed' | 'resolved';

export interface ThreadEntry {
  author: string;
  body: string;
  createdAt: string;
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
}

interface ReviewStore {
  version: number;
  reviews: ReviewComment[];
}

const REVIEWS_DIR = '.code-review';
const REVIEWS_FILE = 'reviews.json';

export class CommentManager implements vscode.Disposable {
  private reviewsPath: string;
  private watcher: vscode.FileSystemWatcher | undefined;

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private repoPath: string) {
    this.reviewsPath = path.join(repoPath, REVIEWS_DIR, REVIEWS_FILE);
  }

  /** Start watching reviews.json for external changes (e.g. agent writes). */
  startWatching(): void {
    const pattern = new vscode.RelativePattern(
      this.repoPath,
      `${REVIEWS_DIR}/${REVIEWS_FILE}`
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(() => this._onDidChange.fire());
    this.watcher.onDidCreate(() => this._onDidChange.fire());
  }

  load(): ReviewComment[] {
    if (!fs.existsSync(this.reviewsPath)) return [];
    try {
      const store: ReviewStore = JSON.parse(fs.readFileSync(this.reviewsPath, 'utf8'));
      return store.reviews ?? [];
    } catch {
      return [];
    }
  }

  save(comments: ReviewComment[]): void {
    const dir = path.dirname(this.reviewsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const store: ReviewStore = { version: 1, reviews: comments };
    fs.writeFileSync(this.reviewsPath, JSON.stringify(store, null, 2), 'utf8');
    this._onDidChange.fire();
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
    if (status === 'addressed' || status === 'resolved') {
      comment.addressedAt = new Date().toISOString();
    }
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

  getOpenComments(): ReviewComment[] {
    return this.load().filter(c => c.status === 'open' || c.status === 'agent-replied');
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
