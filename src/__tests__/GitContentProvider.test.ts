import { describe, it, expect } from 'vitest';
import { parseGitUri } from '../GitContentProvider';

describe('parseGitUri', () => {
  it('parses a standard URI with all params', () => {
    const query = 'repo=/Users/me/repo&ref=abc123&side=old&reviewHash=def456';
    const result = parseGitUri('/src/foo.ts', query);
    expect(result).toEqual({
      file: 'src/foo.ts',
      repo: '/Users/me/repo',
      ref: 'abc123',
      side: 'old',
      reviewHash: 'def456',
    });
  });

  it('strips leading / from path', () => {
    const result = parseGitUri('/src/bar.ts', 'ref=aaa&repo=r&side=new');
    expect(result.file).toBe('src/bar.ts');
  });

  it('handles path without leading /', () => {
    const result = parseGitUri('src/bar.ts', 'ref=aaa&repo=r&side=new');
    expect(result.file).toBe('src/bar.ts');
  });

  it('returns null for missing reviewHash', () => {
    const result = parseGitUri('/f.ts', 'ref=aaa&repo=r&side=new');
    expect(result.reviewHash).toBeNull();
  });

  it('returns empty strings for empty query', () => {
    const result = parseGitUri('/f.ts', '');
    expect(result.ref).toBe('');
    expect(result.repo).toBe('');
    expect(result.side).toBe('');
    expect(result.reviewHash).toBeNull();
  });
});
