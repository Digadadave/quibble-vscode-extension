# Quibble

**Review local git commits with inline comments — right inside VS Code.**

You know that feeling when you're about to push and think *"wait, did I actually look at all of this?"* Quibble lets you review your own branch like a proper code review — browse commits, leave inline comments on specific lines, and track them as you go. It's like having a PR review, minus the PR.

And if you're working with AI agents? Quibble is how you keep them from going rogue. [Skip ahead if you want to see how.](#working-with-ai-agents--keeping-the-herd-in-line)

---

## What It Does

Quibble adds a dedicated sidebar to VS Code where you can see all the commits on your current branch (compared to a base branch like `main` or `master`). Click any commit to open a native VS Code diff view, and from there you can leave comments on specific lines — just like you would in a pull request.

Comments are stored locally (in VS Code's `globalState`) and optionally mirrored to a `.vscode/quibbles.json` file for external tools to read and write (more on that later).

### How to Use It

1. **Open the sidebar** — Look for the Quibble icon in the activity bar (left side of VS Code). Click it to open the panel.
2. **Pick a repo** — If you have multiple repos in your workspace, use the repo icon in the Changes panel header to select which one you're reviewing.
3. **Set your base branch** — The extension compares your current branch against a base branch (defaults to `main` or `master`). You can change this via **Repository Settings** > **Set Base Branch**.
4. **Browse commits and files** — The **Changes** panel shows all the commits and changed files on your branch. Click a file to open a diff view.
5. **Leave comments** — In the diff view, hover over the gutter and click the `+` icon to start a comment thread on any line. Write your comment and hit **Submit Comment**.
6. **Track your comments** — The **Comments** panel shows all your comments with their current status. You can approve, dismiss, reopen, or delete comments from here.

That's really it. Open the sidebar, click through your commits, and comment on whatever catches your eye.

---

## The Sidebar

The Quibble sidebar has two main panels:

### Comments Panel

Shows all comments on the current branch. Each comment displays:
- The file and line number
- A preview of the comment text
- The current status (with a color-coded icon)

**Header actions:**
| Action | Description |
|--------|-------------|
| **Show/Hide Closed** | Toggle visibility of closed (approved/dismissed) comments |
| **Remap Orphans** | Remap orphaned comments to new commit hashes (shows when commits have been rebased/squashed) |
| **Dismiss Orphans** | Dismiss all orphaned comments at once (shows alongside Remap Orphans) |

**Per-comment actions (inline):**
| Action | Description |
|--------|-------------|
| **Approve** | Marks the comment as resolved |
| **Dismiss** | Closes without resolving |
| **Reopen** | Bring a closed comment back |
| **Delete** | Delete the comment |
| **View Fix** | Jump to the commit where the comment was addressed |

### Changes Panel

Shows the files changed on your branch. Has two viewing modes you can toggle between:

| View Mode | Description |
|-----------|-------------|
| **Commits view** | Files grouped under each commit |
| **Files view** | Flat list of all changed files |

**Other header actions:**
| Action | Description |
|--------|-------------|
| **Search** | Toggle file search to filter the file list |
| **Refresh** | Refresh commits and changed files |
| **Open All Changes** | Open all changed files as diffs |
| **Collapse All** | Collapse all groups |
| **Repository Settings** | Select repo, set base branch |

**File change indicators:**
| Indicator | Meaning |
|-----------|---------|
| **A** (added) | File added |
| **D** (deleted) | File deleted |
| **R** (renamed) | File renamed |
| **M** (modified) | File modified |

---

## Comment Statuses

Comments flow through different statuses. When you're using Quibble on its own (no agent), you'll mainly interact with these three:

| Status | Color | Meaning |
|--------|-------|---------|
| **Open** | Blue | Active comment, needs attention |
| **Approved** | Green | You're happy with how it was addressed |
| **Dismissed** | Grey | Closed — not relevant anymore |

There are additional agent-related statuses covered in the [Working with AI Agents](#working-with-ai-agents--keeping-the-herd-in-line) section below.

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `quibble.commentsPath` | `.vscode/quibbles.json` | Path (relative to repo root) for the working review JSON file. This is the file that external tools and agents read/write. The persistent database lives in VS Code's `globalStorage`. |

### Command Palette

These commands are available from the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| **Quibble: Select Repository** | Switch between repos in a multi-root workspace |
| **Quibble: Set Base Branch** | Change the base branch for comparison |
| **Quibble: Open Quibbles** | Open the `.vscode/quibbles.json` file directly |
| **Quibble: Copy Agent Prompt** | Copy a prompt to your clipboard that instructs an agent how to read and update the quibbles file |
| **Quibble: Refresh** | Manually refresh all views |
| **Quibble: Show Diagnostics** | Show debug info about the extension state |

---

## Working with AI Agents — Keeping the Herd in Line

AI coding agents are powerful. They're also a little like ranch hands who work *really* fast but don't always check in before knocking down a fence. Left unsupervised, they'll refactor half your codebase, rename things you liked just fine, and commit 20 times before you've finished your coffee. Quibble gives you a way to watch the work as it happens and course-correct before you've lost a few head.

### The Idea

When an AI agent is making code changes for you, it's doing a lot — refactoring, adding features, fixing bugs. The agent commits as it goes, and each commit shows up in your Changes panel in real time. This means you can **review what the agent is doing as it works**, not just after it's done.

Think of it like pair programming where your partner commits frequently and you're reviewing the diffs live. Except your partner never gets tired and occasionally needs to be told *"no, put that back."*

### Why This Matters

Without something like this, the typical "vibe coding" flow is:
1. Ask the agent to do something
2. Wait for it to finish
3. Look at a giant diff and try to figure out what happened
4. If something's off, explain the problem and start over

That's basically letting the herd roam free and hoping they're all still there when you check the gate. With Quibble, the flow becomes:
1. Ask the agent to do something
2. **While it's working**, review the commits as they come in
3. See something going in the wrong direction? **Leave a comment directly on that line of code**
4. Prompt the agent to check your comments — it reads the `.vscode/quibbles.json` file and course-corrects

You're catching issues early — when they're small and easy to fix — instead of after the agent has gone down the wrong path for 20 commits. Your feedback is specific and contextual because it's attached to the exact line of code you're talking about.

### How the Agent Picks Up Your Comments

One important thing to understand: the extension itself doesn't tell the agent to go look at your comments. It's a passive bridge — it writes your comments to the `.vscode/quibbles.json` file, and it's up to you to get the agent to check that file. There are two main ways to do this:

1. **Prompt or skill** — You can directly ask the agent to check for review comments, or use a slash command / skill that reads the JSON file and addresses open comments. This is the most straightforward approach — you leave your comments, then tell the agent to go look.

2. **Workflow hook** — If you want it to be more automatic, you can set up a hook in your agent's execution flow that checks for open comments at certain points (e.g., before starting a new task, or after completing a set of changes). This way the agent naturally picks up your feedback as part of its workflow without you having to prompt it each time.

Either way, the comments are just sitting in a JSON file — the agent reads them, does its thing, and writes back status updates. The extension watches the file and syncs everything to the UI.

### Asking Questions

Comments aren't just for corrections. You can use them to **ask the agent what it's doing**:

- *"Why did you choose this approach over X?"*
- *"What does this function do? Can you add a comment explaining it?"*
- *"Is this temporary or part of the final design?"*

The agent can respond by updating the comment status to **Needs Input** (if it has a question back for you) or **Addressed (No Change)** (if it answered your question without needing to change code). You get a back-and-forth conversation anchored to the actual code.

### Agent Comment Statuses

When an agent is involved, comments can move through additional statuses beyond the basic open/approved/dismissed:

| Status | Color | Meaning |
|--------|-------|---------|
| **In Progress** | Purple | Agent is actively working on it |
| **Needs Input** | Coral | Agent has a question for you |
| **Addressed** | Green | Agent made code changes to address it |
| **Addressed (No Change)** | Purple | Agent responded but no code change was needed |
| **Outdated** | Grey | Comment references code that no longer exists |

### The Bottom Line

If you're letting AI agents write code, you want to keep an eye on the herd — not chase strays after the fact. Quibble lets you watch the commits roll in, nudge things back on track with a comment, and catch problems while they're still small. It's the difference between managing an agent and actually collaborating with one.

---

## Getting Started

1. Install the extension (`.vsix` or from the marketplace)
2. Open a repo with a feature branch
3. Click the Quibble icon in the activity bar
4. Start reviewing your commits and leaving comments

Now go find something to quibble about.
