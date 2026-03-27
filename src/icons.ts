// ── Codicon IDs ───────────────────────────────────────────────────────────────
// Used as ThemeIcon IDs, $(name) in labels/markdown, and codicon-{name} in webviews.

export const ICONS = {
  // Git
  GIT_BRANCH:         'git-branch',
  GIT_COMMIT:         'git-commit',
  GIT_PULL_REQUEST:   'git-pull-request',
  REPO:               'repo',
  // Comments
  COMMENT:            'comment',
  COMMENT_DISCUSSION: 'comment-discussion',
  COMMENT_UNRESOLVED: 'comment-unresolved',
  CIRCLE_SLASH:       'circle-slash',
  // Status actions
  CHECK:              'check',
  CHECK_ALL:          'check-all',
  VERIFIED_FILLED:    'verified-filled',
  SYNC_IGNORED:       'sync-ignored',
  QUESTION:           'question',
  TRASH:              'trash',
  // People
  HUBOT:              'hubot',
  PERSON:             'person',
  // Diff
  DIFF_ADDED:         'diff-added',
  DIFF_REMOVED:       'diff-removed',
  DIFF_RENAMED:       'diff-renamed',
  DIFF_MODIFIED:      'diff-modified',
} as const;

// ── Status colors ─────────────────────────────────────────────────────────────
// Single source of truth for status colors.
//
// • `token`      — vscode.ThemeColor id used in CommentsView STATUS_META
// • `fallback`   — hex fallback for the webview CSS variable
// • `bgFallback` — rgba tint fallback (CSS can't alpha-blend a var(), so kept fixed)
//
// The key is also the CSS variable suffix: --status-{key} / --status-{key}-bg.
// To add or change a color, edit here only — both the TreeView icons and the
// webview CSS are derived from this table automatically.

export const STATUS_COLORS = {
  open:      { token: 'editorInfo.foreground',    fallback: '#6c9bcf', bgFallback: 'rgba(108,155,207,0.15)' },
  question:  { token: 'editorWarning.foreground', fallback: '#c08060', bgFallback: 'rgba(192,128,96,0.15)'  },
  replied:   { token: 'terminal.ansiMagenta',     fallback: '#a78bca', bgFallback: 'rgba(167,139,202,0.15)' },
  addressed: { token: 'testing.iconPassed',       fallback: '#73a66c', bgFallback: 'rgba(115,166,108,0.15)' },
  closed:    { token: 'testing.iconPassed',       fallback: '#73a66c', bgFallback: 'rgba(115,166,108,0.15)' },
  dismissed: { token: 'disabledForeground',       fallback: '#888888', bgFallback: 'rgba(136,136,136,0.15)' },
} as const;

/** Converts a vscode.ThemeColor token to its webview CSS variable name.
 *  e.g. 'editorInfo.foreground' → '--vscode-editorInfo-foreground' */
export function themeTokenToCssVar(token: string): string {
  return '--vscode-' + token.replace('.', '-');
}

/** Returns an inline <style> block that defines --status-* CSS variables,
 *  derived from STATUS_COLORS. Inject into every webview that loads review.css. */
export function buildStatusCssVars(): string {
  const lines = (Object.entries(STATUS_COLORS) as [string, typeof STATUS_COLORS[keyof typeof STATUS_COLORS]][])
    .flatMap(([name, { token, fallback, bgFallback }]) => [
      `    --status-${name}:    var(${themeTokenToCssVar(token)}, ${fallback});`,
      `    --status-${name}-bg: ${bgFallback};`,
    ]);
  return `<style>\n  :root {\n${lines.join('\n')}\n  }\n</style>`;
}

// ── SVG icon filenames (relative to media/) ───────────────────────────────────
// Used with vscode.Uri.joinPath(extensionUri, 'media', ICON_FILES.X).

export const ICON_FILES = {
  AGENT:            'icon-agent.svg',
  BLANK:            'icon-blank.svg',
  STATUS_OPEN:      'icon-status-open.svg',
  STATUS_QUESTION:  'icon-status-question.svg',
  STATUS_REPLIED:   'icon-status-replied.svg',
  STATUS_ADDRESSED: 'icon-status-addressed.svg',
  STATUS_CLOSED:    'icon-status-closed.svg',
  STATUS_DISMISSED: 'icon-status-dismissed.svg',
  STATUS_DEFAULT:   'icon-status-default.svg',
} as const;
