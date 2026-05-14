import { describe, it, expect } from 'vitest';
import { parseGitLog, parseChangesOutput } from '../GitService';

describe('parseGitLog', () => {
  const sep = '\x1f';
  const rs = '\x1e';

  it('parses a single commit record', () => {
    const raw = `abc123${sep}abc${sep}Fix bug${sep}2024-01-15${sep}Alice${sep}HEAD -> main${rs}`;
    const result = parseGitLog(raw);
    expect(result).toEqual([
      {
        hash: 'abc123',
        shortHash: 'abc',
        message: 'Fix bug',
        date: '2024-01-15',
        author: 'Alice',
        refs: ['HEAD -> main'],
      },
    ]);
  });

  it('parses multiple commit records', () => {
    const raw = [
      `aaa${sep}aa${sep}First${sep}2024-01-01${sep}Alice${sep}`,
      `bbb${sep}bb${sep}Second${sep}2024-01-02${sep}Bob${sep}origin/main`,
    ].join(rs) + rs;

    const result = parseGitLog(raw);
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe('First');
    expect(result[0].refs).toEqual([]);
    expect(result[1].message).toBe('Second');
    expect(result[1].refs).toEqual(['origin/main']);
  });

  it('handles empty decoration with multiple refs', () => {
    const raw = `abc${sep}ab${sep}Msg${sep}2024-01-01${sep}Alice${sep}HEAD -> main, origin/main, tag: v1.0${rs}`;
    const result = parseGitLog(raw);
    expect(result[0].refs).toEqual(['HEAD -> main', 'origin/main', 'tag: v1.0']);
  });

  it('returns empty array for empty input', () => {
    expect(parseGitLog('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseGitLog('  \n  ')).toEqual([]);
  });

  it('handles records with no decoration field', () => {
    // When %D is empty, the field may be missing entirely
    const raw = `abc${sep}ab${sep}Msg${sep}2024-01-01${sep}Alice${rs}`;
    const result = parseGitLog(raw);
    expect(result[0].refs).toEqual([]);
  });
});

describe('parseChangesOutput', () => {
  const sep = '\x1f';

  it('parses numstat output with commit headers and merges cumulative stats', () => {
    const numstatRaw = [
      `commit:aaa111${sep}aaa${sep}Add feature`,
      `10\t2\tsrc/foo.ts`,
      `5\t0\tsrc/bar.ts`,
      '',
      `commit:bbb222${sep}bbb${sep}Fix bug`,
      `3\t1\tsrc/foo.ts`,
    ].join('\n');

    const statsRaw = [
      '13\t3\tsrc/foo.ts',
      '5\t0\tsrc/bar.ts',
    ].join('\n');

    const statusFiles = [
      { path: 'src/foo.ts', status: 'M' },
      { path: 'src/bar.ts', status: 'A' },
    ];

    const result = parseChangesOutput(numstatRaw, statsRaw, statusFiles);

    expect(result).toHaveLength(2);

    const foo = result.find(f => f.path === 'src/foo.ts')!;
    expect(foo.status).toBe('M');
    expect(foo.insertions).toBe(13);
    expect(foo.deletions).toBe(3);
    expect(foo.commits).toHaveLength(2);
    expect(foo.commits[0].hash).toBe('aaa111');
    expect(foo.commits[1].hash).toBe('bbb222');

    const bar = result.find(f => f.path === 'src/bar.ts')!;
    expect(bar.status).toBe('A');
    expect(bar.insertions).toBe(5);
    expect(bar.deletions).toBe(0);
    expect(bar.commits).toHaveLength(1);
  });

  it('skips files with no net change (in numstat but not in statusFiles)', () => {
    const numstatRaw = [
      `commit:aaa${sep}aa${sep}Temp file`,
      `10\t0\ttemp.ts`,
    ].join('\n');
    const statsRaw = '';
    const statusFiles: { path: string; status: string }[] = [];

    const result = parseChangesOutput(numstatRaw, statsRaw, statusFiles);
    expect(result).toEqual([]);
  });

  it('picks up pure renames (in statusFiles but not in numstat)', () => {
    const numstatRaw = '';
    const statsRaw = '';
    const statusFiles = [{ path: 'renamed.ts', status: 'R' }];

    const result = parseChangesOutput(numstatRaw, statsRaw, statusFiles);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      path: 'renamed.ts',
      status: 'R',
      commits: [],
      insertions: 0,
      deletions: 0,
    });
  });

  it('handles empty inputs gracefully', () => {
    const result = parseChangesOutput('', '', []);
    expect(result).toEqual([]);
  });
});
