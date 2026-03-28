import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

export type CommentStatus = 'open' | 'in-progress' | 'needs-input' | 'addressed' | 'approved' | 'dismissed' | 'outdated';

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
  /** Stable identity across squash/rebase copies. Same uuid = same logical comment. */
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

// ── DB shape (stored in context.globalState) ────────────────────────────────

/**
 * Per-repo DB stored under key `"repo:<repoPath>"` in VS Code's globalState.
 *
 * branches: maps branch names → array of known commit hashes (superset of
 *           current git hashes — includes orphaned hashes until remapped).
 * comments: maps commit hashes → array of comments anchored to that commit.
 */
export interface RepoDb {
  branches: Record<string, string[]>;
  comments: Record<string, ReviewComment[]>;
}

// ── Working JSON shape (the file the agent reads/writes) ─────────────────────

interface ReviewStore {
  _schema?: unknown;
  version: number;
  reviews: ReviewComment[];
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
      'user-sets': 'open | approved | dismissed',
      'agent-sets': 'in-progress | needs-input | addressed | outdated',
      'actionable-like-open': 'needs-input — agent should check these alongside open comments',
      values: {
        open: 'User has left a comment or question for the agent to address',
        'in-progress': 'Agent is actively working on this comment',
        'needs-input': 'Ball is in the user\'s court — either the agent has a question, or the agent answered a user question. Treat as actionable like open.',
        addressed: 'Agent has finished — user should confirm or reopen',
        approved: 'User confirmed and approved the agent\'s work',
        dismissed: 'User decided no action is needed',
        outdated: 'Agent detected the code has changed enough that the comment may no longer apply. See resolvedNote for details. User should reopen or dismiss.',
      },
    },
    createdAt: 'ISO 8601 timestamp when the comment was first created',
    addressedAt: 'ISO 8601 timestamp when the agent marked it addressed, null otherwise',
    addressedByCommit: 'Full hash of the commit where the agent fixed the issue, null otherwise',
    codeSnippet: 'Plain-text copy of the target line(s) at the time of the comment, for quick reference',
    resolvedNote: 'Written by the agent when updating status. For \'addressed\': what was changed. For \'outdated\': what changed in the code. For \'pending\': the agent\'s question for the user. Null if status is \'open\'.',
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
  private globalState: vscode.Memento;
  private dbKey: string;
  private watcher: vscode.FileSystemWatcher | undefined;
  /** Prevents the file watcher from echoing back our own saves. */
  private suppressNextWatchEvent = false;
  private cachedSchema: unknown = undefined;

  /** Current branch's git commit hashes. */
  private currentHashes: Set<string> = new Set();
  private currentBranch = '';

  /** Orphaned hashes: stored for this branch but no longer in git (squash/rebase). */
  private _orphanedHashes: string[] = [];
  /** Orphaned comments: comments from the orphaned hashes. */
  private _orphanedComments: ReviewComment[] = [];

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /**
   * @param repoPath    Absolute path to the repository root. Empty string for placeholder instances.
   * @param globalState VS Code globalState Memento for persistent DB storage.
   */
  constructor(
    private repoPath: string,
    globalState: vscode.Memento,
  ) {
    const configPath = vscode.workspace
      .getConfiguration('commitReview')
      .get<string>('reviewsPath', '.vscode/commit-reviews.json');
    this.workingJsonPath = repoPath ? path.join(repoPath, configPath) : '';
    this.globalState = globalState;
    this.dbKey = repoPath ? `repo:${repoPath}` : '';
  }

  // ── DB access (globalState) ───────────────────────────────────────────────

  private dbLoad(): RepoDb {
    if (!this.dbKey) return { branches: {}, comments: {} };
    return this.globalState.get<RepoDb>(this.dbKey, { branches: {}, comments: {} });
  }

  private dbSave(db: RepoDb): void {
    if (!this.dbKey) return;
    // Memento.update() updates in-memory cache synchronously, persists async.
    this.globalState.update(this.dbKey, db);
  }

  // ── Branch switching ──────────────────────────────────────────────────────

  /**
   * Switch to a branch: compare stored hashes with current git hashes, detect
   * orphans, and populate the working JSON with matched comments.
   */
  switchBranch(branchName: string, gitHashes: string[]): void {
    this.currentBranch = branchName;
    this.currentHashes = new Set(gitHashes);

    const db = this.dbLoad();
    const storedHashes = db.branches[branchName] ?? [];

    // ── Orphan detection ──────────────────────────────────────────────────
    // Hashes that were stored for this branch but no longer exist in git,
    // AND have comments attached. These are squash/rebase casualties.
    this._orphanedHashes = [];
    this._orphanedComments = [];
    for (const hash of storedHashes) {
      if (!this.currentHashes.has(hash)) {
        const comments = db.comments[hash];
        if (comments && comments.length > 0) {
          this._orphanedHashes.push(hash);
          this._orphanedComments.push(...comments);
        }
      }
    }

    // ── Update stored hashes ──────────────────────────────────────────────
    // Keep orphaned hashes in the stored list (so they persist across
    // refreshes until the user remaps or dismisses them). Add any new
    // git hashes that aren't already stored.
    const storedSet = new Set(storedHashes);
    const updatedHashes = [...storedHashes];
    for (const h of gitHashes) {
      if (!storedSet.has(h)) updatedHashes.push(h);
    }
    db.branches[branchName] = updatedHashes;
    this.dbSave(db);

    // ── Populate working JSON ─────────────────────────────────────────────
    this.populateWorkingJson();

    // Set context key for orphan indicator in the UI
    vscode.commands.executeCommand(
      'setContext',
      'commitReview.hasOrphans',
      this._orphanedComments.length > 0,
    );
  }

  /** Re-populate the working JSON from the DB using the current hash set. */
  private populateWorkingJson(): void {
    const db = this.dbLoad();
    const matched: ReviewComment[] = [];
    for (const hash of this.currentHashes) {
      const comments = db.comments[hash];
      if (comments) matched.push(...comments);
    }

    // Deduplicate by uuid — if the same comment was remapped to a hash that's
    // also in the current branch (e.g. merge brought in both original and copy),
    // keep the most recently created copy.
    const byUuid = new Map<string, ReviewComment>();
    for (const c of matched) {
      const existing = byUuid.get(c.uuid);
      if (!existing || c.createdAt > existing.createdAt) {
        byUuid.set(c.uuid, c);
      }
    }
    this.saveWorkingJson([...byUuid.values()]);
  }

  // ── Orphan API ────────────────────────────────────────────────────────────

  /** True if there are orphaned comments (squash/rebase detected). */
  get hasOrphans(): boolean {
    return this._orphanedComments.length > 0;
  }

  /** Orphaned comments from stored hashes that no longer exist in git. */
  get orphanedComments(): ReviewComment[] {
    return this._orphanedComments;
  }

  /**
   * Remap all orphaned comments to a target commit hash. Called when the user
   * selects a commit to receive the orphaned comments (e.g. the squash commit).
   *
   * Each orphaned comment is COPIED to the target hash with a new id but the
   * same uuid. The originals remain in the DB at their old hashes — this way
   * if the user returns to the original branch, those comments are still there.
   * The uuid ties all copies together: status updates propagate to all of them,
   * and the uuid dedup in populateWorkingJson prevents double-showing.
   */
  remapOrphans(targetHash: string): void {
    const db = this.dbLoad();

    // Ensure the target hash bucket exists
    if (!db.comments[targetHash]) db.comments[targetHash] = [];
    const existingUuids = new Set(db.comments[targetHash].map(c => c.uuid));

    // Copy orphaned comments to target (skip if same uuid already present)
    for (const hash of this._orphanedHashes) {
      const orphans = db.comments[hash] ?? [];
      for (const c of orphans) {
        if (existingUuids.has(c.uuid)) continue;
        db.comments[targetHash].push({
          ...c,
          id: `cr_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
          commitHash: targetHash,
        });
        existingUuids.add(c.uuid);
      }
      // Originals stay in db.comments[hash] — not deleted.
    }

    this.dbSave(db);

    // Clear orphan state for this session (they've been handled)
    this._orphanedHashes = [];
    this._orphanedComments = [];
    vscode.commands.executeCommand('setContext', 'commitReview.hasOrphans', false);

    // Repopulate working JSON (target hash is in currentHashes)
    this.populateWorkingJson();
  }

  /**
   * Dismiss orphaned comments — acknowledge them without remapping.
   * Originals stay in the DB (no data loss), but the orphan indicator clears.
   */
  dismissOrphans(): void {
    this._orphanedHashes = [];
    this._orphanedComments = [];
    vscode.commands.executeCommand('setContext', 'commitReview.hasOrphans', false);
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

  /**
   * Sync external changes to the working JSON back to the DB.
   * Called when the file watcher detects an agent edit.
   */
  private syncWorkingJsonToDb(): void {
    const workingComments = this.load();
    const db = this.dbLoad();

    for (const wc of workingComments) {
      const bucket = db.comments[wc.commitHash] ?? [];

      // Find existing record by id
      const existing = bucket.find(c => c.id === wc.id);
      if (existing) {
        // Propagate update to ALL copies with same uuid across all hashes
        const uuid = existing.uuid;
        for (const hash of Object.keys(db.comments)) {
          for (let i = 0; i < db.comments[hash].length; i++) {
            if (db.comments[hash][i].uuid === uuid) {
              // Keep each copy's own id, commitHash, branchName
              db.comments[hash][i] = {
                ...wc,
                id: db.comments[hash][i].id,
                uuid,
                commitHash: db.comments[hash][i].commitHash,
                branchName: db.comments[hash][i].branchName,
              };
            }
          }
        }
      } else {
        // New comment added externally — add to the hash bucket
        const comment = { ...wc };
        if (!comment.uuid) comment.uuid = comment.id;
        if (!comment.branchName) comment.branchName = this.currentBranch;
        if (!db.comments[wc.commitHash]) db.comments[wc.commitHash] = [];
        db.comments[wc.commitHash].push(comment);
      }
    }

    this.dbSave(db);
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

    // DB — add to hash bucket
    const db = this.dbLoad();
    if (!db.comments[params.commitHash]) db.comments[params.commitHash] = [];
    db.comments[params.commitHash].push(comment);
    this.dbSave(db);

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

    // DB — update ALL copies with same uuid across all hash buckets
    const db = this.dbLoad();
    const uuid = wc.uuid;
    for (const hash of Object.keys(db.comments)) {
      for (const c of db.comments[hash]) {
        if (c.uuid === uuid) {
          c.status = status;
          if (status === 'addressed') c.addressedAt = new Date().toISOString();
        }
      }
    }
    this.dbSave(db);

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

    // DB — remove ALL copies with same uuid across all hash buckets
    const db = this.dbLoad();
    for (const hash of Object.keys(db.comments)) {
      db.comments[hash] = db.comments[hash].filter(c => c.uuid !== uuid);
      // Clean up empty buckets
      if (db.comments[hash].length === 0) delete db.comments[hash];
    }
    this.dbSave(db);

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

    // DB — update ALL copies with same uuid across all hash buckets
    const db = this.dbLoad();
    const uuid = wc.uuid;
    for (const hash of Object.keys(db.comments)) {
      for (const c of db.comments[hash]) {
        if (c.uuid === uuid) {
          c.thread.push({ ...entry });
        }
      }
    }
    this.dbSave(db);

    return true;
  }

  getOpenComments(): ReviewComment[] {
    return this.load().filter(c => c.status !== 'approved' && c.status !== 'dismissed');
  }

  getCommentsForCommit(hash: string): ReviewComment[] {
    return this.load().filter(c => c.commitHash === hash);
  }

  getReviewsFilePath(): string {
    return this.workingJsonPath;
  }

  // ── Migration ─────────────────────────────────────────────────────────────

  /**
   * Import old comment files into the globalState DB.
   *
   * Checks two sources:
   * 1. Per-branch JSON files: `.vscode/commit-reviews/<key>.json`
   * 2. Flat DB file: `globalStorageUri/<repo>.json`
   *
   * Called once when switching to a repo. Adds uuid and branchName fields
   * where missing.
   */
  migrateOldFiles(globalStorageUri?: vscode.Uri): void {
    if (!this.repoPath) return;
    const db = this.dbLoad();
    const existingIds = new Set<string>();
    for (const hash of Object.keys(db.comments)) {
      for (const c of db.comments[hash]) existingIds.add(c.id);
    }

    let imported = 0;

    // ── Source 1: per-branch JSON files ──────────────────────────────────
    const oldDir = path.join(this.repoPath, '.vscode', 'commit-reviews');
    if (fs.existsSync(oldDir)) {
      try {
        const files = fs.readdirSync(oldDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const content = JSON.parse(
              fs.readFileSync(path.join(oldDir, file), 'utf8'),
            );
            const reviews: ReviewComment[] = content.reviews ?? [];
            for (const r of reviews) {
              if (existingIds.has(r.id)) continue;
              if (!r.uuid) r.uuid = r.id;
              if (!r.branchName) r.branchName = file.replace('.json', '');
              if (!db.comments[r.commitHash]) db.comments[r.commitHash] = [];
              db.comments[r.commitHash].push(r);
              existingIds.add(r.id);
              imported++;
            }
          } catch { /* skip invalid files */ }
        }
      } catch { /* can't read dir */ }
    }

    // ── Source 2: flat globalStorageUri DB file ──────────────────────────
    if (globalStorageUri) {
      const repoName = path.basename(this.repoPath);
      const flatDbPath = path.join(globalStorageUri.fsPath, `${repoName}.json`);
      if (fs.existsSync(flatDbPath)) {
        try {
          const content = JSON.parse(fs.readFileSync(flatDbPath, 'utf8'));
          const comments: ReviewComment[] = content.comments ?? [];
          for (const r of comments) {
            if (existingIds.has(r.id)) continue;
            if (!r.uuid) r.uuid = r.id;
            if (!r.branchName) r.branchName = '';
            if (!db.comments[r.commitHash]) db.comments[r.commitHash] = [];
            db.comments[r.commitHash].push(r);
            existingIds.add(r.id);
            imported++;
          }
          // Clean up old file after successful migration
          fs.unlinkSync(flatDbPath);
        } catch { /* skip */ }
      }
    }

    if (imported > 0) {
      this.dbSave(db);
      vscode.window.showInformationMessage(
        `Commit Review: migrated ${imported} comment(s) to new storage.`,
      );
    }
  }

  // ── Dispose ───────────────────────────────────────────────────────────────

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }
}
