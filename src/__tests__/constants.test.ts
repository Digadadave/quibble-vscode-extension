import { describe, it, expect } from 'vitest';
import { STATUS, STATUS_LABELS } from '../constants';

describe('STATUS_LABELS', () => {
  it('has an entry for every status in STATUS', () => {
    for (const key of Object.keys(STATUS) as Array<keyof typeof STATUS>) {
      const statusValue = STATUS[key];
      expect(STATUS_LABELS).toHaveProperty(statusValue);
      expect(typeof STATUS_LABELS[statusValue]).toBe('string');
      expect(STATUS_LABELS[statusValue].length).toBeGreaterThan(0);
    }
  });

  it('has no extra entries beyond STATUS values', () => {
    const statusValues = new Set(Object.values(STATUS));
    for (const key of Object.keys(STATUS_LABELS)) {
      expect(statusValues.has(key as any)).toBe(true);
    }
  });
});
