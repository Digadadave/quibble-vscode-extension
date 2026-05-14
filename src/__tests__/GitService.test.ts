import { describe, it, expect } from 'vitest';
import { parseGitLog } from '../GitService';

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
