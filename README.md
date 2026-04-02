# 💬 Commit Review

**Review local git commits with inline comments — right inside VS Code.**

Ever wished you could do a proper code review on your own branch before pushing? Commit Review brings GitHub-style inline commenting to your local commits. Browse your branch's changes, leave comments on specific lines in a diff, and track them as you go. It's a code review — just for your local work.

---

## What It Does

Commit Review adds a dedicated sidebar to VS Code where you can see all the commits on your current branch (compared to a base branch like `main` or `master`). Click any commit to open a native VS Code diff view, and from there you can leave comments on specific lines — just like you would in a pull request.

Comments are stored locally (in VS Code's `globalState`) and optionally mirrored to a `.vscode/commit-reviews.json` file for external tools to read and write (more on that later).

### How to Use It

1. **Open the sidebar** — Look for the Commit Review icon in the activity bar (left side of VS Code). Click it to open the panel.
2. **Pick a repo** — If you have multiple repos in your workspace, use the 📦 repo icon in the Changes panel header to select which one you're reviewing.
3. **Set your base branch** — The extension compares your current branch against a base branch (defaults to `main` or `master`). You can change this via **Repository Settings** → **Set Base Branch**.
4. **Browse commits and files** — The **Changes** panel shows all the commits and changed files on your branch. Click a file to open a diff view.
5. **Leave comments** — In the diff view, hover over the gutter and click the `+` icon to start a comment thread on any line. Write your comment and hit **Submit Comment**.
6. **Track your comments** — The **Comments** panel shows all your comments with their current status. You can approve ✅, dismiss 🚫, reopen 🔄, or delete 🗑️ comments from here.

That's really it. Open the sidebar, click through your commits, and comment on whatever catches your eye.

---

## The Sidebar

The Commit Review sidebar has two main panels:

### 📝 Comments Panel

Shows all comments on the current branch. Each comment displays:
- The file and line number
- A preview of the comment text
- The current status (with a color-coded icon)

**Header actions:**
| Icon | Action |
|------|--------|
| 👁️ `$(eye)` / `$(eye-closed)` | Toggle visibility of closed comments |
| ⚠️ `$(warning)` | Remap orphaned comments (shows when commits have been rebased/squashed) |

**Per-comment actions (inline):**
| Icon | Action |
|------|--------|
| ✅ `$(check-all)` | Approve — marks the comment as resolved |
| 🚫 `$(sync-ignored)` | Dismiss — closes without resolving |
| 🔄 `$(debug-restart)` | Reopen — bring a closed comment back |
| 🗑️ `$(trash)` | Delete the comment |
| 📄 `$(go-to-file)` | View Fix — jump to the commit where the comment was addressed |

### 📂 Changes Panel

Shows the files changed on your branch. Has two viewing modes you can toggle between:

| Icon | View Mode |
|------|-----------|
| `$(list-tree)` | **Commits view** — files grouped under each commit |
| `$(three-bars)` | **Files view** — flat list of all changed files |

**Other header actions:**
| Icon | Action |
|------|--------|
| `$(diff-multiple)` | Open all changed files as diffs |
| `$(collapse-all)` | Collapse all groups |
| `$(repo)` | Repository settings (select repo, set base branch) |

**File status icons in the changes list:**
| Icon | Meaning |
|------|---------|
| `$(diff-added)` | File added |
| `$(diff-removed)` | File deleted |
| `$(diff-renamed)` | File renamed |
| `$(diff-modified)` | File modified |

---

## Comment Statuses

Comments flow through different statuses. Some are set by you, others by an agent (if you're using one).

### Statuses You Set

| Status | Icon | Color | Meaning |
|--------|------|-------|---------|
| 🔵 **Open** | `$(comment-unresolved)` | Blue | Active comment, needs attention |
| ✅ **Approved** | `$(check-all)` | Green | You're happy with how it was addressed |
| 🚫 **Dismissed** | `$(sync-ignored)` | Grey | Closed — not relevant anymore |

### Statuses Set by an Agent

| Status | Icon | Color | Meaning |
|--------|------|-------|---------|
| 🟣 **In Progress** | `$(edit-sparkle)` | Purple | Agent is actively working on it |
| 🟠 **Needs Input** | `$(feedback)` | Coral | Agent has a question for you |
| 🟢 **Addressed** | `$(check)` | Green | Agent made code changes to address it |
| 🟣 **Addressed (No Change)** | `$(comment-discussion-quote)` | Purple | Agent responded but no code change was needed |
| ⚪ **Outdated** | `$(sync-ignored)` | Grey | Comment references code that no longer exists |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `commitReview.reviewsPath` | `.vscode/commit-reviews.json` | Path (relative to repo root) for the working review JSON file. This is the file that external tools and agents read/write. The persistent database lives in VS Code's `globalStorage`. |

---

## 🤖 Working with AI Agents — The Real Superpower

Alright, here's where things get really interesting.

Commit Review was built with AI-assisted development in mind. If you're working with a coding agent like Claude Code, this extension turns your workflow into something much more interactive and collaborative.

### The Idea

When an AI agent is making code changes for you, it's doing a lot — refactoring, adding features, fixing bugs. The agent commits as it goes, and each commit shows up in your Changes panel in real time. This means you can **review what the agent is doing as it works**, not just after it's done.

Think of it like pair programming where your partner commits frequently and you're reviewing the diffs live.

### Why This Matters

Without something like this, the typical flow is:
1. Ask the agent to do something
2. Wait for it to finish
3. Look at a giant diff and try to figure out what happened
4. If something's off, explain the problem and start over

With Commit Review, the flow becomes:
1. Ask the agent to do something
2. **While it's working**, review the commits as they come in
3. See something going in the wrong direction? **Leave a comment directly on that line of code**
4. The agent picks up your comment (via the `.vscode/commit-reviews.json` file) and course-corrects

This is a huge deal. You're catching issues early — when they're small and easy to fix — instead of after the agent has gone down the wrong path for 20 commits. Your feedback is specific and contextual because it's attached to the exact line of code you're talking about.

### Asking Questions

Comments aren't just for corrections. You can use them to **ask the agent what it's doing**:

- *"Why did you choose this approach over X?"*
- *"What does this function do? Can you add a comment explaining it?"*
- *"Is this temporary or part of the final design?"*

The agent can respond by updating the comment status to **Needs Input** (if it has a question back for you) or **Addressed** (if it made a change based on your feedback). You get a back-and-forth conversation anchored to the actual code.

### How It Works Under the Hood

The extension mirrors your comments to a `.vscode/commit-reviews.json` file in your repo. This is the bridge between you and the agent:

- **You** leave comments through the VS Code UI → they get written to the JSON file
- **The agent** reads the JSON file, sees your comments, and can update statuses or add responses
- **The extension** watches the file for changes and syncs everything back to the UI

It's a simple handshake — you both read and write the same file, and the extension keeps everything in sync.

### The Bottom Line

If you're using AI agents to write code, Commit Review gives you a way to stay in the loop without slowing down. You review commits as they land, redirect early when something's off, and ask questions when you want to understand a decision. It's the difference between managing an agent and collaborating with one.

---

## Getting Started

1. Install the extension (`.vsix` or from the marketplace)
2. Open a repo with a feature branch
3. Click the Commit Review icon in the activity bar
4. Start reviewing your commits and leaving comments

Happy reviewing! 🎉
