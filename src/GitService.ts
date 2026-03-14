import { execSync } from 'child_process';
import * as path from 'path';

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  date: string;
  author: string;
  /** Branch / tag names pointing at this commit, e.g. ["HEAD -> main", "origin/main"] */
  refs: string[];
}

export interface ChangedFile {
  path: string;
  /** M = modified, A = added, D = deleted, R = renamed */
  status: string;
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

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

export class GitService {
  constructor(private repoPath: string) {}

  getLog(limit = 30): GitCommit[] {
    const sep = '\x1f';
    const rs = '\x1e';
    // %D = ref names (branch/tag decorations), empty string when none
    const format = `--format=%H${sep}%h${sep}%s${sep}%ai${sep}%an${sep}%D${rs}`;
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

  getRawDiff(hash: string): string {
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

      if (line.startsWith('--- ') || line.startsWith('+++ ') ||
          line.startsWith('index ') || line.startsWith('new file') ||
          line.startsWith('deleted file') || line.startsWith('old mode') ||
          line.startsWith('new mode')) {
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
        currentHunk.lines.push({ type: 'add', content: line.slice(1), newLineNum: newLine++ });
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'delete', content: line.slice(1), oldLineNum: oldLine++ });
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.lines.push({ type: 'context', content: line.slice(1), oldLineNum: oldLine++, newLineNum: newLine++ });
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
    const raw = exec(
      `git diff --name-status ${oldestHash}^..${newestHash}`,
      this.repoPath
    );
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

  getFileContentAtCommit(hash: string, filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    return exec(`git show ${hash}:${normalized}`, this.repoPath);
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
    const fs = require('fs') as typeof import('fs');
    const repos: string[] = [];

    // Check if rootDir itself is a git repo
    if (GitService.getRepoRoot(rootDir)) {
      repos.push(path.normalize(rootDir));
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
