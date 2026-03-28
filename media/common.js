// @ts-check
/// <reference lib="dom" />

// ── Shared utilities for all webviews ────────────────────────────────────────

/**
 * HTML-escape a string for safe insertion into innerHTML.
 * @param {unknown} s
 * @returns {string}
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
