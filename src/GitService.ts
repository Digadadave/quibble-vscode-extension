import { execSync, exec as childExec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execPRaw = promisify(childExec);

export interface GitCommit {
    hash: string;
    shortHash: string;
    message: string;
    date: string;
    author: string;
    /** Branch / tag names pointing at this commit, e.g. ["HEAD -> main", "origin/main"] */
    refs: string[];
}

export interface GitBranch {
    name: string;
    current: boolean;
    remote: boolean;
}

export interface ChangedFile {
    path: string;
    /** M = modified, A = added, D = deleted, R = renamed */
    status: string;
}

export interface FileWithStats extends ChangedFile {
    insertions: number;
    deletions: number;
}

export interface BranchFileChange {
    path: string;
    /** M = modified, A = added, D = deleted, R = renamed */
    status: string;
    /** Commits that touched this file on the branch, newest first */
    commits: Array<{
        hash: string;
        shortHash: string;
        message: string;
        insertions: number;
        deletions: number;
    }>;
    insertions: number;
    deletions: number;
}

export interface ParsedDiff {
    file: string;
    hunks: DiffHunk[];
}

export interface DiffHunk {
    header: string;
    lines: DiffLine[];
}

export interface DiffLine {
    type: 'context' | 'add' | 'delete';
    content: string;
    /** Line number in the new file (right side), undefined for deletions */
    newLineNum?: number;
    /** Line number in the old file (left side), undefined for additions */
    oldLineNum?: number;
}

// All git commands run synchronously via execSync. This is intentional — git
// operations on local repos are fast and the extension host is single-threaded,
// so async overhead isn't worth the complexity. Failures (non-zero exit, no repo,
// etc.) return '' rather than throwing; callers treat '' as "nothing found".
//
// For the expensive getChangesOnBranchAsync() path, execAsync is used instead so
// two independent git calls can run in parallel without blocking the extension host.
async function execAsync(cmd: string, cwd: string): Promise<string> {
    try {
        const { stdout } = await execPRaw(cmd, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
        return (stdout as string).trim();
    } catch {
        return '';
    }
}

function exec(cmd: string, cwd: string): string {
    try {
        return execSync(cmd, {
            cwd,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
    } catch {
        return '';
    }
}

export class GitService {
    private _defaultBranch = '';
    private _defaultRefCache: string | null = null;
    private _mergeBaseCache = new Map<string, { head: string; base: string }>();
    private _branchChangesCache = new Map<string, { head: string; base: string; result: BranchFileChange[] }>();

    /** Custom base branch for merge-base calculation. Empty string = auto-detect. */
    get defaultBranch(): string { return this._defaultBranch; }
    set defaultBranch(value: string) {
        if (this._defaultBranch !== value) {
            this._defaultBranch = value;
            this.clearCaches();
        }
    }

    /** Force-clear all cached git state (default ref, merge-base, branch changes). */
    clearCaches(): void {
        this._defaultRefCache = null;
        this._mergeBaseCache.clear();
        this._branchChangesCache.clear();
    }

    constructor(private repoPath: string) {}

    getRepoPath(): string {
        return this.repoPath;
    }

    getLog(limit = 30): GitCommit[] {
        const sep = '\x1f';
        const rs = '\x1e';
        // %D = ref names (branch/tag decorations), empty string when none
        // Use %x1f/%x1e so git outputs the control chars — avoids shell mangling
        const format = '--format=%H%x1f%h%x1f%s%x1f%ai%x1f%an%x1f%D%x1e';
        const raw = exec(`git log ${format} -${limit}`, this.repoPath);
        if (!raw) return [];

        return raw
            .split(rs)
            .map(s => s.trim())
            .filter(Boolean)
            .map(record => {
                const parts = record.split(sep);
                const [hash, shortHash, message, date, author, decoration = ''] = parts;
                // %D gives e.g. "HEAD -> main, origin/main, tag: v1.0"
                const refs = decoration
                    .split(',')
                    .map(r => r.trim())
                    .filter(Boolean);
                return { hash, shortHash, message, date, author, refs };
            });
    }

    getBranches(): GitBranch[] {
        const branches: GitBranch[] = [];

        // Determine current branch name
        const currentBranch = exec('git rev-parse --abbrev-ref HEAD', this.repoPath);

        // Local branches — one name per line
        const localRaw = exec("git branch --format='%(refname:short)'", this.repoPath);
        if (localRaw) {
            for (const line of localRaw.split('\n').filter(Boolean)) {
                const name = line.trim();
                if (name) {
                    branches.push({ name, current: name === currentBranch, remote: false });
                }
            }
        }

        // Remote branches — one name per line (e.g. "origin/main")
        const remoteRaw = exec("git branch -r --format='%(refname:short)'", this.repoPath);
        if (remoteRaw) {
            for (const line of remoteRaw.split('\n').filter(Boolean)) {
                const name = line.trim();
                if (!name || name.includes('->')) continue;
                branches.push({ name, current: false, remote: true });
            }
        }

        return branches;
    }

    getCommitsForBranch(branch: string, limit = 30): GitCommit[] {
        const sep = '\x1f';
        const rs = '\x1e';
        const format = '--format=%H%x1f%h%x1f%s%x1f%ai%x1f%an%x1f%D%x1e';
        // Scope to commits unique to this branch (since merge-base with main/master).
        // --first-parent excludes commits merged in from the default branch.
        // Falls back to full log if no merge-base can be found (e.g. on main itself).
        const base = this.getMergeBase(branch);
        const range = base ? `"${base}..${branch}"` : `"${branch}" -${limit}`;
        const limitFlag = base ? `-${limit}` : '';
        const raw = exec(`git log --first-parent ${range} ${format} ${limitFlag}`, this.repoPath);
        if (!raw) return [];

        return raw
            .split(rs)
            .map(s => s.trim())
            .filter(Boolean)
            .map(record => {
                const parts = record.split(sep);
                const [hash, shortHash, message, date, author, decoration = ''] = parts;
                const refs = decoration
                    .split(',')
                    .map(r => r.trim())
                    .filter(Boolean);
                return { hash, shortHash, message, date, author, refs };
            });
    }

    getChangedFiles(hash: string): ChangedFile[] {
        const raw = exec(`git diff-tree --no-commit-id -r --name-status ${hash}`, this.repoPath);
        if (!raw) return [];

        return raw
            .split('\n')
            .filter(Boolean)
            .map(line => {
                const [status, ...parts] = line.split('\t');
                // For renames: status is R100\told\tnew — use the new path
                return { path: parts[parts.length - 1], status: status[0] };
            });
    }

    /** Like getChangedFiles but also includes insertion/deletion line counts. */
    getChangedFilesWithStats(hash: string): FileWithStats[] {
        const statusMap = new Map(this.getChangedFiles(hash).map(f => [f.path, f.status]));
        const raw = exec(`git diff-tree --no-commit-id -r --numstat ${hash}`, this.repoPath);
        if (!raw)
            return [...statusMap.entries()].map(([p, s]) => ({
                path: p,
                status: s,
                insertions: 0,
                deletions: 0,
            }));

        return raw
            .split('\n')
            .filter(Boolean)
            .map(line => {
                const parts = line.split('\t');
                const insertions = parseInt(parts[0]) || 0;
                const deletions = parseInt(parts[1]) || 0;
                const filePath = parts[2] ?? '';
                return {
                    path: filePath,
                    status: statusMap.get(filePath) ?? 'M',
                    insertions,
                    deletions,
                };
            });
    }

    getRawDiff(hash: string): string {
        // Check if the commit has a parent (root commit has none)
        const hasParent = exec(`git rev-parse --verify ${hash}^`, this.repoPath) !== '';
        if (!hasParent) {
            // Root commit: show all files as added via git show (strip the commit header)
            return exec(`git show --format="" ${hash}`, this.repoPath);
        }
        return exec(`git diff ${hash}^..${hash}`, this.repoPath);
    }

    parseDiff(rawDiff: string): ParsedDiff[] {
        const files: ParsedDiff[] = [];
        let current: ParsedDiff | null = null;
        let currentHunk: DiffHunk | null = null;
        let oldLine = 0;
        let newLine = 0;

        for (const line of rawDiff.split('\n')) {
            if (line.startsWith('diff --git')) {
                if (current) files.push(current);
                const match = line.match(/diff --git a\/.+ b\/(.+)/);
                current = { file: match?.[1] ?? 'unknown', hunks: [] };
                currentHunk = null;
                continue;
            }

            if (!current) continue;

            if (
                line.startsWith('--- ') ||
                line.startsWith('+++ ') ||
                line.startsWith('index ') ||
                line.startsWith('new file') ||
                line.startsWith('deleted file') ||
                line.startsWith('old mode') ||
                line.startsWith('new mode')
            ) {
                continue;
            }

            if (line.startsWith('@@')) {
                const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                oldLine = match ? parseInt(match[1]) : 0;
                newLine = match ? parseInt(match[2]) : 0;
                currentHunk = { header: line, lines: [] };
                current.hunks.push(currentHunk);
                continue;
            }

            if (!currentHunk) continue;

            if (line.startsWith('+')) {
                currentHunk.lines.push({
                    type: 'add',
                    content: line.slice(1),
                    newLineNum: newLine++,
                });
            } else if (line.startsWith('-')) {
                currentHunk.lines.push({
                    type: 'delete',
                    content: line.slice(1),
                    oldLineNum: oldLine++,
                });
            } else if (line.startsWith(' ') || line === '') {
                currentHunk.lines.push({
                    type: 'context',
                    content: line.slice(1),
                    oldLineNum: oldLine++,
                    newLineNum: newLine++,
                });
            }
        }

        if (current) files.push(current);
        return files;
    }

    /**
     * Cumulative diff from just before `oldestHash` to the tip of `newestHash`.
     * This mirrors how GitHub shows a PR diff — intermediate states that were
     * later overwritten simply don't appear.
     *
     * `git diff <oldestHash>^..<newestHash>`
     */
    getRangeDiff(oldestHash: string, newestHash: string): string {
        // When oldest === newest, fall back to the single-commit diff
        if (oldestHash === newestHash) {
            return this.getRawDiff(oldestHash);
        }
        return exec(`git diff ${oldestHash}^..${newestHash}`, this.repoPath);
    }

    /**
     * Files changed across a range (same range as getRangeDiff).
     */
    getChangedFilesInRange(oldestHash: string, newestHash: string): ChangedFile[] {
        if (oldestHash === newestHash) {
            return this.getChangedFiles(newestHash);
        }
        const raw = exec(`git diff --name-status ${oldestHash}^..${newestHash}`, this.repoPath);
        if (!raw) return [];
        return raw
            .split('\n')
            .filter(Boolean)
            .map(line => {
                const [status, ...parts] = line.split('\t');
                return { path: parts[parts.length - 1], status: status[0] };
            });
    }

    getCurrentBranch(): string {
        return exec('git rev-parse --abbrev-ref HEAD', this.repoPath) || 'HEAD';
    }

    getHeadHash(): string {
        return exec('git rev-parse HEAD', this.repoPath);
    }

    /** Direct diff between two refs (e.g. merge-base → HEAD). No parent trick. */
    getDirectDiff(baseRef: string, headRef: string): string {
        return exec(`git diff "${baseRef}" "${headRef}"`, this.repoPath);
    }

    /** Changed files between two refs (direct, no parent trick). */
    getDirectChangedFiles(baseRef: string, headRef: string): ChangedFile[] {
        const raw = exec(`git diff --name-status "${baseRef}" "${headRef}"`, this.repoPath);
        if (!raw) return [];
        return raw
            .split('\n')
            .filter(Boolean)
            .map(line => {
                const [status, ...parts] = line.split('\t');
                return { path: parts[parts.length - 1], status: status[0] };
            });
    }

    /** Returns all commit hashes on the branch since it diverged from main/master. */
    getBranchCommitHashes(branch: string): string[] {
        const base = this.getMergeBase(branch);
        if (!base) return [];
        const raw = exec(`git log --first-parent "${base}..${branch}" --format=%H`, this.repoPath);
        if (!raw) return [];
        return raw.split('\n').filter(Boolean);
    }

    /**
     * Returns the merge-base commit hash between this branch and the default branch.
     * The merge-base is the common ancestor — i.e. where this branch diverged from
     * main/master. It's used as the "base" for all PR-style diffs and commit listings.
     * Result is cached per-branch, keyed by the branch's current HEAD hash.
     */
    getMergeBase(branch: string): string {
        const defaultRef = this.findDefaultRef();
        if (!defaultRef) return '';
        const head = exec(`git rev-parse "${branch}"`, this.repoPath);
        if (head) {
            const cached = this._mergeBaseCache.get(branch);
            if (cached && cached.head === head) return cached.base;
        }
        const base = exec(`git merge-base "${branch}" "${defaultRef}"`, this.repoPath);
        if (head) this._mergeBaseCache.set(branch, { head, base });
        return base;
    }

    /** Returns the first valid default branch ref.
     * Checks the user-configured `defaultBranch` first, then falls back to
     * the standard auto-detect list. Result is cached until `defaultBranch` changes.
     */
    private findDefaultRef(): string {
        if (this._defaultRefCache !== null) return this._defaultRefCache;
        let result = '';
        if (this._defaultBranch) {
            if (exec(`git rev-parse --verify "${this._defaultBranch}"`, this.repoPath)) {
                result = this._defaultBranch;
            }
        }
        if (!result) {
            for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
                if (exec(`git rev-parse --verify "${ref}"`, this.repoPath)) { result = ref; break; }
            }
        }
        this._defaultRefCache = result;
        return result;
    }

    /**
     * Returns all files changed on `branch` since it diverged from main/master,
     * sorted with the most-recently-touched file first.
     */
    getChangesOnBranch(branch: string): BranchFileChange[] {
        const base = this.getMergeBase(branch);
        if (!base) return [];

        const head = exec('git rev-parse HEAD', this.repoPath);
        const cached = this._branchChangesCache.get(branch);
        if (cached && cached.head === head && cached.base === base) return cached.result;

        const sep = '\x1f';
        // Single git log call with --numstat to get per-commit file stats without N+1 spawns.
        // Output alternates between a commit header line and numstat lines for that commit.
        const numstatRaw = exec(
            `git log --first-parent "${base}..${branch}" --format="commit:%H${sep}%h${sep}%s" --numstat`,
            this.repoPath
        );

        type CommitMeta = { hash: string; shortHash: string; message: string };
        type CommitEntry = CommitMeta & { insertions: number; deletions: number };
        const fileCommits = new Map<string, CommitEntry[]>();

        let currentCommit: CommitMeta | null = null;
        for (const line of numstatRaw.split('\n')) {
            if (line.startsWith('commit:')) {
                const parts = line.slice('commit:'.length).split(sep);
                currentCommit = { hash: parts[0] ?? '', shortHash: parts[1] ?? '', message: parts[2] ?? '' };
                continue;
            }
            if (!currentCommit || !line.trim()) continue;
            const parts = line.split('\t');
            if (parts.length < 3) continue;
            const insertions = parseInt(parts[0]) || 0;
            const deletions = parseInt(parts[1]) || 0;
            const filePath = parts[2] ?? '';
            if (!filePath) continue;
            if (!fileCommits.has(filePath)) fileCommits.set(filePath, []);
            fileCommits.get(filePath)!.push({ ...currentCommit, insertions, deletions });
        }

        // Cumulative net +/- per file across the whole branch
        const statsRaw = exec(`git diff "${base}" "${branch}" --numstat`, this.repoPath);
        const statsMap = new Map<string, { insertions: number; deletions: number }>();
        for (const line of statsRaw.split('\n').filter(Boolean)) {
            const parts = line.split('\t');
            const ins = parseInt(parts[0]) || 0;
            const del = parseInt(parts[1]) || 0;
            const file = parts[2] ?? '';
            if (file) statsMap.set(file, { insertions: ins, deletions: del });
        }

        // Get cumulative file status (A/M/D) across the whole branch
        const statusFiles = this.getDirectChangedFiles(base, branch);
        const statusMap = new Map(statusFiles.map(f => [f.path, f.status]));

        const result: BranchFileChange[] = [];
        const seen = new Set<string>();
        for (const [filePath, fileCommitList] of fileCommits) {
            // Skip files with no net change base→HEAD (added then deleted/renamed within the branch).
            // They appear in per-commit data but not in the cumulative diff.
            if (!statusMap.has(filePath)) continue;
            seen.add(filePath);
            const stats = statsMap.get(filePath) ?? { insertions: 0, deletions: 0 };
            const status = statusMap.get(filePath) ?? 'M';
            result.push({ path: filePath, status, commits: fileCommitList, ...stats });
        }
        // Pure renames / mode-only changes produce zero numstat lines, so they never
        // enter fileCommits. Pick them up from the cumulative status instead.
        for (const [filePath, status] of statusMap) {
            if (seen.has(filePath)) continue;
            const stats = statsMap.get(filePath) ?? { insertions: 0, deletions: 0 };
            result.push({ path: filePath, status, commits: [], ...stats });
        }
        this._branchChangesCache.set(branch, { head, base, result });
        return result;
    }

    /**
     * Async variant of getChangesOnBranch — runs the two heaviest git calls in parallel
     * so the extension host is not blocked while the results load. The ChangesView uses
     * this so the sidebar can show a loading spinner while data arrives in the background.
     */
    async getChangesOnBranchAsync(branch: string): Promise<BranchFileChange[]> {
        const base = this.getMergeBase(branch);
        if (!base) return [];

        const head = exec('git rev-parse HEAD', this.repoPath);
        const cached = this._branchChangesCache.get(branch);
        if (cached && cached.head === head && cached.base === base) return cached.result;

        const sep = '\x1f';
        try {
            const [numstatRaw, statsRaw] = await Promise.all([
                execAsync(
                    `git log --first-parent "${base}..${branch}" --format="commit:%H${sep}%h${sep}%s" --numstat`,
                    this.repoPath
                ),
                execAsync(`git diff "${base}" "${branch}" --numstat`, this.repoPath),
            ]);

            type CommitMeta = { hash: string; shortHash: string; message: string };
            type CommitEntry = CommitMeta & { insertions: number; deletions: number };
            const fileCommits = new Map<string, CommitEntry[]>();

            let currentCommit: CommitMeta | null = null;
            for (const line of numstatRaw.split('\n')) {
                if (line.startsWith('commit:')) {
                    const parts = line.slice('commit:'.length).split(sep);
                    currentCommit = { hash: parts[0] ?? '', shortHash: parts[1] ?? '', message: parts[2] ?? '' };
                    continue;
                }
                if (!currentCommit || !line.trim()) continue;
                const parts = line.split('\t');
                if (parts.length < 3) continue;
                const insertions = parseInt(parts[0]) || 0;
                const deletions = parseInt(parts[1]) || 0;
                const filePath = parts[2] ?? '';
                if (!filePath) continue;
                if (!fileCommits.has(filePath)) fileCommits.set(filePath, []);
                fileCommits.get(filePath)!.push({ ...currentCommit, insertions, deletions });
            }

            const statsMap = new Map<string, { insertions: number; deletions: number }>();
            for (const line of statsRaw.split('\n').filter(Boolean)) {
                const parts = line.split('\t');
                const ins = parseInt(parts[0]) || 0;
                const del = parseInt(parts[1]) || 0;
                const file = parts[2] ?? '';
                if (file) statsMap.set(file, { insertions: ins, deletions: del });
            }

            const statusFiles = this.getDirectChangedFiles(base, branch);
            const statusMap = new Map(statusFiles.map(f => [f.path, f.status]));

            const result: BranchFileChange[] = [];
            const seen = new Set<string>();
            for (const [filePath, fileCommitList] of fileCommits) {
                if (!statusMap.has(filePath)) continue;
                seen.add(filePath);
                const stats = statsMap.get(filePath) ?? { insertions: 0, deletions: 0 };
                const status = statusMap.get(filePath) ?? 'M';
                result.push({ path: filePath, status, commits: fileCommitList, ...stats });
            }
            for (const [filePath, status] of statusMap) {
                if (seen.has(filePath)) continue;
                const stats = statsMap.get(filePath) ?? { insertions: 0, deletions: 0 };
                result.push({ path: filePath, status, commits: [], ...stats });
            }
            this._branchChangesCache.set(branch, { head, base, result });
            return result;
        } catch {
            return [];
        }
    }

    getUserName(): string {
        return exec('git config user.name', this.repoPath) || 'reviewer';
    }

    /** Returns diagnostic info for debugging remote environment issues. */
    getDiagnostics(): Record<string, string> {
        const branch = this.getCurrentBranch();
        const defaultRef = this.findDefaultRef();
        const mergeBase = this.getMergeBase(branch);
        const headHash = exec('git rev-parse HEAD', this.repoPath);
        const commitCount = mergeBase
            ? exec(`git rev-list --count "${mergeBase}..${branch}"`, this.repoPath)
            : '(no merge-base)';
        const fileCount = mergeBase
            ? exec(`git diff --name-only "${mergeBase}" "${branch}" | wc -l`, this.repoPath)
            : '(no merge-base)';
        const gitVersion = exec('git --version', this.repoPath);
        return {
            repoPath: this.repoPath,
            branch,
            defaultBranch: this._defaultBranch || '(auto-detect)',
            defaultRef: defaultRef || '(none found)',
            mergeBase: mergeBase || '(empty)',
            headHash,
            commitCount,
            fileCount,
            gitVersion,
            cacheState: `defaultRefCache=${this._defaultRefCache ?? 'null'}, mergeBaseCacheSize=${this._mergeBaseCache.size}`,
        };
    }

    /**
     * Times each major git operation cold (caches cleared before each call).
     * Useful for diagnosing which operation is the bottleneck on large repos.
     */
    getTimings(): Record<string, number> {
        const time = (fn: () => unknown): number => { const s = Date.now(); fn(); return Date.now() - s; };
        const branch = this.getCurrentBranch();
        this.clearCaches();
        const findDefaultRef_ms = time(() => this.findDefaultRef());
        this.clearCaches();
        const getMergeBase_ms = time(() => this.getMergeBase(branch));
        this.clearCaches();
        const getChangesOnBranch_ms = time(() => this.getChangesOnBranch(branch));
        this.clearCaches();
        const getBranchCommitHashes_ms = time(() => this.getBranchCommitHashes(branch));
        return { findDefaultRef_ms, getMergeBase_ms, getChangesOnBranch_ms, getBranchCommitHashes_ms };
    }

    /** Returns the 1-based line number of the first change for `file` on the current branch. */
    getFirstChangedLine(file: string): number {
        const branch = this.getCurrentBranch();
        const base = this.getMergeBase(branch);
        if (!base) return 1;
        const raw = exec(`git diff -U0 "${base}" HEAD -- "${file}"`, this.repoPath);
        const match = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        return match ? Math.max(1, parseInt(match[1])) : 1;
    }

    getFileContentAtCommit(hash: string, filePath: string): string {
        const normalized = filePath.replace(/\\/g, '/');
        try {
            return execSync(`git show ${hash}:${normalized}`, {
                cwd: this.repoPath,
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024,
            }).trim();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
                `[CommitReview] getFileContentAtCommit failed — hash=${hash.slice(0, 8)} file=${normalized} — ${msg}`
            );
            return '';
        }
    }

    /**
     * Returns the full hash of the parent commit, or empty string for root commits.
     * Use `'__empty__'` as the old-side ref when this returns empty.
     */
    getParentHash(hash: string): string {
        return exec(`git rev-parse --verify ${hash}^`, this.repoPath);
    }

    static getRepoRoot(startPath: string): string | undefined {
        try {
            const result = execSync('git rev-parse --show-toplevel', {
                cwd: startPath,
                encoding: 'utf8',
            }).trim();
            return path.normalize(result);
        } catch {
            return undefined;
        }
    }

    /**
     * Discover git repos within a directory (one level deep).
     * Checks each immediate subdirectory for a .git folder.
     */
    static discoverRepos(rootDir: string): string[] {
        const repos: string[] = [];

        // Check if rootDir is inside a git repo — use the actual repo root,
        // not rootDir itself (which may be a subdirectory of the git root).
        const rootRepoRoot = GitService.getRepoRoot(rootDir);
        if (rootRepoRoot) {
            repos.push(rootRepoRoot);
        }

        // Check immediate subdirectories
        try {
            const entries = fs.readdirSync(rootDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
                const sub = path.join(rootDir, entry.name);
                const repoRoot = GitService.getRepoRoot(sub);
                if (repoRoot && !repos.includes(repoRoot)) {
                    repos.push(repoRoot);
                }
            }
        } catch {
            // Can't read directory — just return what we have
        }

        return repos;
    }
}
