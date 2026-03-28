# Refactor v1 — Remove ReviewPanel + HTML Templates for ChangesView

## Goals
1. Remove the COMMITS panel (ReviewPanel) entirely
2. Introduce `.html` template files for the remaining webview (ChangesView)
3. Clean up CSS — remove dead styles, split by view
4. Extract shared JS utilities

---

## Phase 1: Remove ReviewPanel

Everything related to the COMMITS sidebar webview.

### Delete files
- `src/ReviewPanel.ts`
- `media/sidebar.js`

### src/extension.ts
- Remove import of `ReviewPanel` (line 5)
- Remove `let activeReviewPanel` declaration (line 16)
- Remove `ReviewPanel.register()` + all 4 callback registrations (lines 44–79)
- Remove `activeReviewPanel?.sendCommits()` in `refreshAll()` (line 264)
- Remove `activeReviewPanel?.showLoading()` in `switchToRepo()` (line 298)
- Remove `activeReviewPanel?.updateServices()` in `switchToRepo()` (line 320)
- Remove `commitReview.openPanel` command registration (line 375)

### package.json
- Remove view: `commitReview.reviewView` from `contributes.views` (lines 179–184)
- Remove command: `commitReview.openPanel` from `contributes.commands` (lines 19–24)
- Remove menu entry: `commitReview.selectRepo` with `when: view == commitReview.reviewView` (lines 199–204)

### media/review.css
- Remove ReviewPanel-specific CSS (lines ~38–1053):
  - `#layout`, `#sidebar` layout
  - `.sidebar-section-header`, `.sidebar-actions`, `.sidebar-btn`
  - `#commits-list`, `.commit-item`, `.commit-body`, `.commit-row-top`, `.commit-msg`, `.commit-date`
  - `.commit-graph-col`, `.commit-dot`, `.commit-refs-row`, `.commit-ref-tag`
  - `.commit-file-row`, `.commit-file-list`, `.commit-file-status`, `.commit-file-name`, `.commit-file-folder`
  - `.graph-*` classes
  - `#right-panel`, `#top-bar`, `.diff-table`, `.thread-*`, `.file-*`
  - `#commit-tooltip`, context menu styles
  - `.thread-reply-form`, footer, empty state

**Careful:** Some classes (`.sidebar-section-header`, `.sidebar-btn`) may be shared with ChangesView — verify before removing.

---

## Phase 2: HTML Template for ChangesView

Move the webview HTML shell out of TypeScript into a standalone file.

### Create `media/changes.html`
Extract from `ChangesView.ts` `buildHtml()` method (lines 151–195). The HTML file will contain:
- `<!DOCTYPE html>` shell
- CSP meta tag with `{{nonce}}` placeholder
- `<link>` tags for CSS with `{{cssUri}}` and `{{codiconsUri}}` placeholders
- `<style>` block with `{{statusCssVars}}` placeholder
- Container markup: section header + `<div id="changes-list">`
- `<script>` tag with `{{jsUri}}` and `{{nonce}}` placeholders

Template placeholders to replace at runtime:
| Placeholder | Source |
|---|---|
| `{{nonce}}` | Generated per render |
| `{{cspSource}}` | `webview.cspSource` |
| `{{cssUri}}` | URI to `review.css` (or `changes.css` after Phase 3) |
| `{{codiconsUri}}` | URI to `codicon.css` |
| `{{statusCssVars}}` | Output of `buildStatusCssVars()` |
| `{{jsUri}}` | URI to `changes.js` |

### Update `src/ChangesView.ts`
- Replace `buildHtml()` method body:
  - Read `media/changes.html` via `fs.readFileSync`
  - Replace `{{placeholder}}` tokens with actual values
  - Return the resulting string
- Add `import * as fs from 'fs'` and `import * as path from 'path'`

---

## Phase 3: CSS Cleanup

### Split `review.css` into focused files
After Phase 1 removes the dead ReviewPanel styles, what remains:

| File | Contents |
|---|---|
| `media/shared.css` | CSS variables, reset, body base, shared typography (lines 1–37) |
| `media/changes.css` | All `.ch-*` classes + changes header styles (lines ~1054–1385) |
| `media/comments.css` | `.sidebar-comment-*` classes if still used by CommentsView (lines ~241–280) |

**Note:** CommentsView uses native TreeView, not a webview — verify whether `comments.css` styles are actually referenced anywhere. If not, delete them.

### Update `changes.html`
- Reference `shared.css` + `changes.css` instead of `review.css`

### Delete `media/review.css`
- Only after all styles have been migrated to split files

---

## Phase 4: Extract Shared JS Utilities

### Create `media/common.js`
Move duplicated/reusable functions:
- `esc()` — HTML entity escaping (currently duplicated in sidebar.js and changes.js)

After ReviewPanel removal, `sidebar.js` is deleted, so `esc()` only lives in `changes.js`. Still worth extracting to `common.js` for future webviews.

### Update `changes.html`
- Add `<script src="{{commonJsUri}}" nonce="{{nonce}}"></script>` before `changes.js`

### Update `changes.js`
- Remove local `esc()` definition
- Rely on `common.js` being loaded first (global scope in webview)

---

## Execution Order

```
Phase 1  →  Phase 2  →  Phase 3  →  Phase 4
Remove      HTML         CSS          JS
ReviewPanel templates    cleanup      utilities
```

Each phase should compile cleanly (`npm run compile`) and be committed independently.

---

## Verification Checklist
- [ ] `npm run compile` passes with zero errors after each phase
- [ ] Extension activates without errors (`Developer: Open Extension Host`)
- [ ] ChangesView loads and renders correctly
- [ ] CommentsView (TreeView) still works
- [ ] ReviewTreeProvider (Commits tree) still works
- [ ] No console errors in webview dev tools
- [ ] No orphaned CSS classes referencing deleted views
