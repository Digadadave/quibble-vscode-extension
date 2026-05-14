---
name: address-comments
description: Address open reviewer comments in .vscode/quibbles.json
allowed-tools: Read, Edit, Write, Bash, Glob, Grep
---

Address all open reviewer comments in `.vscode/quibbles.json`.

## Steps

1. **Read** `.vscode/quibbles.json` and collect every entry where `status` is `"open"` or `"needs-input"`. Skip `approved`, `dismissed`, `addressed`, `outdated`, `in-progress`.

2. **For each actionable comment**, in order:

    a. Read the referenced `file` at its current state on disk.

    b. Locate the target code using the `snapshot` fields — compare against the current file to check if the code has changed significantly. If the comment no longer applies (code already fixed, target lines gone, etc.), mark it `"outdated"` and write a `resolvedNote` explaining what changed.

    c. Determine what the comment asks for:
    - **Question / curiosity** (no code change needed) → reply in `thread`, set status to `"addressed-no-change"`, set `addressedAt` (current ISO timestamp), write `resolvedNote` with the answer. Do NOT use `needs-input` for this — that is only for when you have a question back for the user.
    - **Bug / improvement** (code change needed) → make the fix, reply in `thread` describing what you changed, set status to `"addressed"`, set `addressedAt` (current ISO timestamp), set `addressedByCommit` to `null` (filled after commit), write `resolvedNote` summarizing the change.
    - **Agent has a follow-up question** → reply in `thread` with the question, set status to `"needs-input"`, write `resolvedNote` with the question. Use this only when you genuinely cannot proceed without user input.

3. **Update** `.vscode/quibbles.json` in place. For each comment you handled, write fields in this exact order:
    1. `thread` — append `{ "author": "claude", "body": "...", "createdAt": "<ISO timestamp>" }`
    2. `resolvedNote` — short plain-text summary (1–2 sentences)
    3. `addressedAt` — current ISO timestamp (for `addressed` and `addressed-no-change`; null otherwise)
    4. `addressedByCommit` — set to `null` now; backfill after committing
    5. `status` — update **last**, after all other fields are written

    Never modify `id`, `uuid`, `commitHash`, `branchName`, `file`, `line`, `lineEnd`, `side`, `body`, `author`, `createdAt`, or `snapshot`.

4. **If any code files were changed**, run `npm run compile` and fix all TypeScript errors before continuing.

5. **Commit**: stage changed files (code files + `.vscode/quibbles.json`) and create a git commit. Message format:

    ```
    review: address N comment(s) from quibbles
    ```

6. **After committing**, update `addressedByCommit` in `.vscode/quibbles.json` for any comments you just marked `"addressed"` — set it to the full hash of the commit just created. Write the file again (no second commit needed for this update).

## Rules

- Set `in-progress` before starting on a comment that will require code changes, so a crash mid-task leaves a visible marker. Revert to `addressed`, `addressed-no-change`, or `needs-input` when done.
- If a comment is just curiosity or a question, do NOT make unnecessary code changes — answer in the thread only.
- Never touch comments with status `approved`, `dismissed`, `addressed`, `outdated`.
- Keep thread replies concise and direct — no filler phrases.
- The `resolvedNote` is for the user's quick reference in the sidebar, so keep it to 1–2 sentences.
