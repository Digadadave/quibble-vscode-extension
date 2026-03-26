import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

export type CommentStatus = 'open' | 'in-progress' | 'needs-input' | 'addressed' | 'resolved' | 'dismissed' | 'outdated';

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
  /** Stable identity across squash/rebase copies. Same uuid = same comment. */
  uuid: string;
  status: CommentStatus;
  commitHash: string;
  /** Branch where this comment was originally created (metadata for orphan detection). */
  branchName: string;
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

// ── Store shapes ────────────────────────────────────────────────────────────

/** Working JSON shape (the file the agent reads/writes). */
interface ReviewStore {
  _schema?: unknown;
  version: number;
  reviews: ReviewComment[];
}

/** DB shape (globalStorageUri — all comments across all branches). */
interface DbStore {
  version: number;
  comments: ReviewComment[];
}

// ── Default schema description (embedded in the working JSON) ───────────────

const SCHEMA_DESCRIPTION = {
  description: 'Local commit review metadata for a VS Code extension. Each entry in \'reviews\' represents a comment left by the user on a specific file and line at the time of a commit. Comments are intended to be addressed by an AI agent. The snapshot field captures surrounding code context at the time the comment was made so the agent can understand the original intent even if the code has since changed. The agent should check this file before starting any task and address all open comments.',
  fields: {
    id: 'Unique identifier for the comment (e.g. \'cr_a1b2c3d4\')',
    uuid: 'Stable identity across copies — same uuid means same logical comment, even if commitHash differs (squash/rebase remap)',
    commitHash: 'Full git commit hash the comment was made against',
    branchName: 'Branch where this comment was originally created (metadata for orphan detection)',
    file: 'Relative path to the file from the repo root',
    line: 'First line number of the selection at the time of the commit (1-based)',
    lineEnd: 'Last line number of the selection; equals line for single-line comments',
    side: '\'right\' = new (post-commit) file side; \'left\' = old (pre-commit) file side',
    body: 'The review comment text written by the user',
    author: 'Who wrote the comment — \'reviewer\' for the user, any string for agent replies',
    status: {
      description: 'Current state of the comment.',
      'user-sets': 'open | resolved | dismissed',
      'agent-sets': 'in-progress | needs-input | addressed | outdated',
      values: {
        open: 'User has left a comment or question for the agent to address',
        'in-progress': 'Agent is actively working on this comment',
        'needs-input': 'Ball is in the user\'s court — either the agent has a question, or the agent answered a user question',
        addressed: 'Agent has finished — user should confirm or reopen',
        resolved: 'User confirmed the agent\'s work is acceptable',
        dismissed: 'User decided no action is needed',
        outdated: 'Agent detected the code has changed enough that the comment may no longer apply. See resolvedNote for details. User should reopen or dismiss.',
      },
    },
    createdAt: 'ISO 8601 timestamp when the comment was first created',
    addressedAt: 'ISO 8601 timestamp when the agent marked it addressed, null otherwise',
    addressedByCommit: 'Full hash of the commit where the agent fixed the issue, null otherwise',
    codeSnippet: 'Plain-text copy of the target line(s) at the time of the comment, for quick reference',
    resolvedNote: 'Written by the agent when updating status. For \'resolved\'/\'addressed\': what was changed. For \'outdated\': what changed in the code. For \'pending\': the agent\'s question for the user. Null if status is \'open\'.',
    thread: {
      description: 'Ordered list of follow-up messages after the initial comment body',
      items: {
        author: 'Who wrote this reply (\'reviewer\' for the user, any string for the agent)',
        body: 'The reply text',
        createdAt: 'ISO 8601 timestamp of this reply',
      },
    },
    snapshot: {
      description: 'Code context captured at the time of the comment. Use this to understand the original code the comment refers to regardless of how the file has changed since. Compare against the current file state to determine if the comment is still relevant. Each entry has \'line\' (1-based line number) and \'content\' (the line text).',
      before: 'Up to 3 lines immediately preceding the target line',
      target: 'The specific line or lines the comment is about',
      after: 'Up to 3 lines immediately following the target line',
    },
  },
};

// ── CommentManager ──────────────────────────────────────────────────────────

export class CommentManager implements vscode.Disposable {
  private workingJsonPath: string;
  private dbPath: string;
  private watcher: vscode.FileSystemWatcher | undefined;
  /** Prevents the file watcher from echoing back our own saves. */
  private suppressNextWatchEvent = false;
  private cachedSchema: unknown = undefined;

  /** Current branch's commit hashes — for filtering DB → working JSON. */
  private currentHashes: Set<string> = new Set();
  private currentBranch = '';

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /**
   * @param repoPath        Absolute path to the repository root.
   * @param globalStorageUri VS Code's globalStorageUri for persistent DB storage.
   */
  constructor(
    private repoPath: string,
    globalStorageUri?: vscode.Uri,
  ) {
    // Working JSON path — configurable, defaults to .vscode/commit-reviews.json
    const configPath = vscode.workspace
      .getConfiguration('commitReview')
      .get<string>('reviewsPath', '.vscode/commit-reviews.json');
    this.workingJsonPath = repoPath ? path.join(repoPath, configPath) : '';

    // DB path in VS Code global storage
    if (globalStorageUri && repoPath) {
      const repoName = path.basename(repoPath);
      this.dbPath = path.join(globalStorageUri.fsPath, `${repoName}.json`);
    } else {
      this.dbPath = '';
    }
  }

  // ── Branch switching ──────────────────────────────────────────────────────

  /**
   * Switch to a branch: query the DB for all comments matching the branch's
   * commit hashes and populate the working JSON.
   */
  switchBranch(branchName: string, commitHashes: string[]): void {
    this.currentBranch = branchName;
    this.currentHashes = new Set(commitHashes);
    this.populateWorkingJson();
  }

  /** Re-populate the working JSON from the DB using the current hash set. */
  private populateWorkingJson(): void {
    const all = this.dbLoad();
    const filtered = all.filter(c => this.currentHashes.has(c.commitHash));

    // Deduplicate by uuid — if somehow the same uuid appears at multiple hashes
    // in this branch (e.g. cherry-pick), keep the most recently created one.
    const byUuid = new Map<string, ReviewComment>();
    for (const c of filtered) {
      const existing = byUuid.get(c.uuid);
      if (!existing || c.createdAt > existing.createdAt) {
        byUuid.set(c.uuid, c);
      }
    }
    this.saveWorkingJson([...byUuid.values()]);
  }

  // ── Working JSON (active branch view, read by the agent) ───────────────

  /** Start watching the working JSON for external changes (e.g. agent writes). */
  startWatching(): void {
    if (!this.repoPath || !this.workingJsonPath) return;
    const rel = path.relative(this.repoPath, this.workingJsonPath).replace(/\\/g, '/');
    const pattern = new vscode.RelativePattern(this.repoPath, rel);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const maybefire = () => {
      if (this.suppressNextWatchEvent) { this.suppressNextWatchEvent = false; return; }
      // External change to working JSON — sync back to DB
      this.syncWorkingJsonToDb();
      this._onDidChange.fire();
    };
    this.watcher.onDidChange(maybefire);
    this.watcher.onDidCreate(maybefire);
  }

  /** Load comments from the working JSON (current branch view). */
  load(): ReviewComment[] {
    if (!this.workingJsonPath || !fs.existsSync(this.workingJsonPath)) return [];
    try {
      const store: ReviewStore = JSON.parse(fs.readFileSync(this.workingJsonPath, 'utf8'));
      if (store._schema !== undefined) this.cachedSchema = store._schema;
      return store.reviews ?? [];
    } catch {
      return [];
    }
  }

  private saveWorkingJson(comments: ReviewComment[]): void {
    if (!this.workingJsonPath) return;
    const dir = path.dirname(this.workingJsonPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.suppressNextWatchEvent = true;

    // Preserve existing schema block, or use the default
    if (this.cachedSchema === undefined && fs.existsSync(this.workingJsonPath)) {
      try {
        const existing: ReviewStore = JSON.parse(fs.readFileSync(this.workingJsonPath, 'utf8'));
        if (existing._schema !== undefined) this.cachedSchema = existing._schema;
      } catch { /* ignore */ }
    }
    if (this.cachedSchema === undefined) {
      this.cachedSchema = SCHEMA_DESCRIPTION;
    }

    const store: ReviewStore = {
      _schema: this.cachedSchema,
      version: 1,
      reviews: comments,
    };
    fs.writeFileSync(this.workingJsonPath, JSON.stringify(store, null, 2), 'utf8');
  }

  // ── DB (all comments across all branches) ──────────────────────────────

  private dbLoad(): ReviewComment[] {
    if (!this.dbPath || !fs.existsSync(this.dbPath)) return [];
    try {
      const store: DbStore = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      return store.comments ?? [];
    } catch {
      return [];
    }
  }

  private dbSave(comments: ReviewComment[]): void {
    if (!this.dbPath) return;
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const store: DbStore = { version: 1, comments };
    fs.writeFileSync(this.dbPath, JSON.stringify(store, null, 2), 'utf8');
  }

  /**
   * Sync external changes to the working JSON back to the DB.
   * Called when the file watcher detects an agent edit.
   */
  private syncWorkingJsonToDb(): void {
    const workingComments = this.load();
    const all = this.dbLoad();

    // Build a lookup by id for fast matching
    const dbById = new Map(all.map((c, i) => [c.id, i]));

    for (const wc of workingComments) {
      const dbIdx = dbById.get(wc.id);
      if (dbIdx !== undefined) {
        // Update ALL records with same uuid (propagate status, thread, etc.)
        const uuid = all[dbIdx].uuid;
        for (let i = 0; i < all.length; i++) {
          if (all[i].uuid === uuid) {
            // Keep each record's own id, commitHash, branchName — update everything else
            all[i] = {
              ...wc,
              id: all[i].id,
              uuid,
              commitHash: all[i].commitHash,
              branchName: all[i].branchName,
            };
          }
        }
      } else {
        // New comment added externally — add to DB
        const comment = { ...wc };
        if (!comment.uuid) comment.uuid = comment.id;
        if (!comment.branchName) comment.branchName = this.currentBranch;
        all.push(comment);
      }
    }

    this.dbSave(all);
  }

  // ── CRUD (writes to both working JSON and DB) ─────────────────────────

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
    const id = `cr_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const comment: ReviewComment = {
      id,
      uuid: id,
      status: 'open',
      commitHash: params.commitHash,
      branchName: this.currentBranch,
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

    // Working JSON
    const working = this.load();
    working.push(comment);
    this.saveWorkingJson(working);

    // DB
    const all = this.dbLoad();
    all.push(comment);
    this.dbSave(all);

    return comment;
  }

  updateStatus(id: string, status: CommentStatus): boolean {
    // Working JSON
    const working = this.load();
    const wc = working.find(c => c.id === id);
    if (!wc) return false;

    wc.status = status;
    if (status === 'addressed') wc.addressedAt = new Date().toISOString();
    this.saveWorkingJson(working);

    // DB — update ALL records with same uuid
    const all = this.dbLoad();
    const uuid = wc.uuid;
    for (const c of all) {
      if (c.uuid === uuid) {
        c.status = status;
        if (status === 'addressed') c.addressedAt = new Date().toISOString();
      }
    }
    this.dbSave(all);

    return true;
  }

  deleteComment(id: string): boolean {
    // Find uuid before deleting
    const working = this.load();
    const wc = working.find(c => c.id === id);
    if (!wc) return false;
    const uuid = wc.uuid;

    // Remove from working JSON
    const idx = working.findIndex(c => c.id === id);
    working.splice(idx, 1);
    this.saveWorkingJson(working);

    // Remove ALL DB records with same uuid
    const all = this.dbLoad();
    const filtered = all.filter(c => c.uuid !== uuid);
    this.dbSave(filtered);

    return true;
  }

  addThreadReply(id: string, author: string, body: string): boolean {
    const entry: ThreadEntry = { author, body, createdAt: new Date().toISOString() };

    // Working JSON
    const working = this.load();
    const wc = working.find(c => c.id === id);
    if (!wc) return false;
    wc.thread.push(entry);
    this.saveWorkingJson(working);

    // DB — update ALL records with same uuid
    const all = this.dbLoad();
    const uuid = wc.uuid;
    for (const c of all) {
      if (c.uuid === uuid) {
        c.thread.push({ ...entry });
      }
    }
    this.dbSave(all);

    return true;
  }

  getOpenComments(): ReviewComment[] {
    return this.load().filter(c => c.status !== 'resolved' && c.status !== 'dismissed');
  }

  getCommentsForCommit(hash: string): ReviewComment[] {
    return this.load().filter(c => c.commitHash === hash);
  }

  getReviewsFilePath(): string {
    return this.workingJsonPath;
  }

  // ── Migration ─────────────────────────────────────────────────────────────

  /**
   * Import old per-branch JSON files (`.vscode/commit-reviews/<key>.json`)
   * into the DB. Called once on repo init. Adds uuid and branchName fields
   * where missing.
   */
  migrateOldFiles(): void {
    if (!this.repoPath) return;
    const oldDir = path.join(this.repoPath, '.vscode', 'commit-reviews');
    if (!fs.existsSync(oldDir)) return;

    let entries: string[];
    try {
      entries = fs.readdirSync(oldDir).filter(f => f.endsWith('.json'));
    } catch { return; }
    if (entries.length === 0) return;

    const all = this.dbLoad();
    const existingIds = new Set(all.map(c => c.id));
    let imported = 0;

    for (const file of entries) {
      try {
        const content = JSON.parse(
          fs.readFileSync(path.join(oldDir, file), 'utf8'),
        );
        const reviews: ReviewComment[] = content.reviews ?? [];
        for (const r of reviews) {
          if (existingIds.has(r.id)) continue;
          // Back-fill new fields
          if (!r.uuid) r.uuid = r.id;
          if (!r.branchName) r.branchName = file.replace('.json', '');
          all.push(r);
          existingIds.add(r.id);
          imported++;
        }
      } catch { /* skip invalid files */ }
    }

    if (imported > 0) {
      this.dbSave(all);
      vscode.window.showInformationMessage(
        `Commit Review: migrated ${imported} comment(s) from old format.`,
      );
    }
  }

  // ── Dispose ───────────────────────────────────────────────────────────────

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }
}
