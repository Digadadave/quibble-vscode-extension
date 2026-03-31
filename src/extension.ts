import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './GitService';
import { CommentManager } from './CommentManager';
import { CommentsView } from './CommentsView';
import { ChangesView } from './ChangesView';
import { GitContentProvider } from './GitContentProvider';
import { ReviewCommentController } from './ReviewCommentController';
import { ICONS } from './icons';

// ── Mutable active-repo state ────────────────────────────────────────────────
// These module-level vars hold everything scoped to the currently active repo.
// They are replaced wholesale when the user switches repos (see switchToRepo()).

let activeGit: GitService | undefined;
let activeComments: CommentManager | undefined;
let activeCommentsView: CommentsView | undefined;
let activeChangesView: ChangesView | undefined;
let activeCommentController: ReviewCommentController | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let commentChangeDisposable: vscode.Disposable | undefined;
/** Disposables for the .git/HEAD and .git/refs watchers of the active repo. */
let gitFsWatchers: vscode.Disposable[] = [];

/**
 * VS Code calls activate() exactly once — when the extension first activates.
 * `context.subscriptions` is an array of Disposable objects; VS Code calls
 * .dispose() on every item when the extension is deactivated (window close, etc.).
 * Push commands, event listeners, watchers, and status-bar items here so they
 * are automatically cleaned up.
 */
export function activate(context: vscode.ExtensionContext): void {
    const repos = discoverAllRepos();

    // ── Git content provider (serves file content at specific commits) ─────────
    // Registers the custom 'commit-review-git://' URI scheme. VS Code calls
    // provideTextDocumentContent() whenever it needs to open a file at that scheme,
    // which is how vscode.diff shows historical file versions side-by-side.
    const gitContentProvider = new GitContentProvider();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(GitContentProvider.scheme, gitContentProvider));

    // ── Native comment controller ─────────────────────────────────────────────
    activeCommentController = new ReviewCommentController(context, new CommentManager('', context.globalState));
    context.subscriptions.push(activeCommentController);

    // ── Comments sidebar TreeView ────────────────────────────────────────────
    activeCommentsView = CommentsView.register(context, new CommentManager('', context.globalState));

    // When the user clicks a comment: open the diff and navigate to that line.
    activeCommentsView.onFocusComment = async (file, line, commitHash) => {
        if (!activeGit) return;
        await openNativeDiff(activeGit, file, commitHash);
        // Give the editor a moment to open before revealing the line.
        setTimeout(() => {
            vscode.commands.executeCommand('revealLine', { lineNumber: line - 1, at: 'center' });
        }, 300);
    };

    // When the user deletes a comment from the tree.
    activeCommentsView.onDeleteComment = id => {
        if (!activeComments) return;
        activeComments.deleteComment(id);
        refreshOnMutation();
    };

    // When the user changes a comment's status from the tree.
    activeCommentsView.onUpdateStatus = (id, status) => {
        if (!activeComments) return;
        activeComments.updateStatus(id, status as import('./CommentManager').CommentStatus);
        refreshOnMutation();
    };

    const commentsTreeView = activeCommentsView.createTreeView();
    context.subscriptions.push(commentsTreeView);

    // ── Changes sidebar WebviewView ───────────────────────────────────────────
    activeChangesView = ChangesView.register(context, new GitService(''), new CommentManager('', context.globalState));
    activeChangesView.registerCommands(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('commitReview.changes.openAllChanges', () => {
            if (!activeGit) return;
            const branch = activeGit.getCurrentBranch();
            const base = activeGit.getMergeBase(branch);
            const head = activeGit.getHeadHash();
            if (!base || !head) return;
            const repoPath = activeGit.getRepoPath();
            const files = activeGit.getDirectChangedFiles(base, head);
            const resources = files.map(f => {
                const oldRef = f.status === 'A' ? '__empty__' : base;
                const newRef = f.status === 'D' ? '__empty__' : head;
                const reviewRef = newRef !== '__empty__' ? head : oldRef;
            return [GitContentProvider.makeUri(repoPath, f.path, oldRef, 'old', reviewRef), GitContentProvider.makeUri(repoPath, f.path, newRef, 'new')];
            });
            vscode.commands.executeCommand('vscode.changes', `Changes: ${branch}`, resources);
        })
    );

    // Native diff: file click → cumulative single-file diff (branch base → HEAD)
    activeChangesView.onJumpToFileNative = async file => {
        if (!activeGit) return;
        const branch = activeGit.getCurrentBranch();
        const base = activeGit.getMergeBase(branch);
        const head = activeGit.getHeadHash();
        if (!base || !head) return;
        const repoPath = activeGit.getRepoPath();
        const changedFiles = activeGit.getDirectChangedFiles(base, head);
        const fileStatus = changedFiles.find(f => f.path === file)?.status ?? 'M';
        // For added files (A), the old side is empty. For deleted files (D), the new side is empty.
        const oldRef = fileStatus === 'A' ? '__empty__' : base;
        const newRef = fileStatus === 'D' ? '__empty__' : head;
        const reviewHash = fileStatus === 'D' ? oldRef : newRef;
        const oldUri = GitContentProvider.makeUri(repoPath, file, oldRef, 'old', reviewHash);
        const newUri = GitContentProvider.makeUri(repoPath, file, newRef, 'new');
        await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, `${path.basename(file)} (branch changes)`);
    };

    // Native diff: hash badge click → single-file diff for that commit
    activeChangesView.onJumpToCommitFileNative = async (hash, file) => {
        if (!activeGit) return;
        await openNativeDiff(activeGit, file, hash);
    };

    // Jump-to-source arrow → open the file in the editor at the first changed line
    activeChangesView.onJumpToSource = async file => {
        if (!activeGit) return;
        const repoPath = activeGit.getRepoPath();
        const absPath = path.join(repoPath, file);
        const line = activeGit.getFirstChangedLine(file);
        try {
            const doc = await vscode.workspace.openTextDocument(absPath);
            const editor = await vscode.window.showTextDocument(doc, { preview: true });
            const pos = new vscode.Position(Math.max(0, line - 1), 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        } catch {
            /* file may not exist */
        }
    };

    // "Open all changes" button on a commit row → multi-diff for that commit
    activeChangesView.onOpenCommitChanges = async hash => {
        if (!activeGit) return;
        const repoPath = activeGit.getRepoPath();
        const parentHash = activeGit.getParentHash(hash) || '__empty__';
        const files = activeGit.getChangedFilesWithStats(hash);
        const resources = files.map(f => {
            const oldRef = f.status === 'A' ? '__empty__' : parentHash;
            const newRef = f.status === 'D' ? '__empty__' : hash;
            const label = vscode.Uri.file(path.join(repoPath, f.path));
            const original = f.status === 'A' ? undefined : GitContentProvider.makeUri(repoPath, f.path, oldRef, 'old', hash);
            const modified = f.status === 'D' ? undefined : GitContentProvider.makeUri(repoPath, f.path, newRef, 'new');
            return [label, original, modified] as [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];
        });
        await vscode.commands.executeCommand('vscode.changes', `Commit ${hash.slice(0, 7)}`, resources);
    };

    // Comment badge click → open the diff at the first comment on that file
    activeChangesView.onJumpToComment = async file => {
        if (!activeGit || !activeComments) return;
        const all = activeComments.load();
        const comment = all.find(c => c.file === file);
        if (!comment) return;
        await openNativeDiff(activeGit, comment.file, comment.commitHash);
        setTimeout(() => {
            vscode.commands.executeCommand('revealLine', { lineNumber: comment.line - 1, at: 'center' });
        }, 300);
    };

    // retainContextWhenHidden keeps the webview iframe alive when the panel is
    // collapsed/hidden, preserving JS state. Without it VS Code destroys and
    // recreates the webview each time the panel becomes visible.
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChangesView.viewType, activeChangesView, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    // ── COMMENTS panel → open proper diff when a gitFile:// doc is activated standalone ──
    // When the user clicks a comment in the native COMMENTS panel, VS Code opens the
    // gitFile:// URI directly (not in a diff editor). Intercept that and redirect to
    // the proper side-by-side diff view.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async editor => {
            if (!editor) return;
            const uri = editor.document.uri;
            if (uri.scheme !== GitContentProvider.scheme) return;

            // Skip if already inside a diff or multi-diff editor.
            const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
            if (activeTab?.input instanceof vscode.TabInputTextDiff) return;
            if (!(activeTab?.input instanceof vscode.TabInputText)) return;

            const params = new URLSearchParams(uri.query);
            const side = params.get('side');
            if (side !== 'new' && side !== 'old') return;
            if (!activeGit) return;

            // For the old side, reviewHash is the actual commit being reviewed.
            const commitHash = side === 'old'
                ? (params.get('reviewHash') ?? params.get('ref') ?? '')
                : (params.get('ref') ?? '');
            if (!commitHash) return;

            const file = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;

            // Replace the standalone file view with a proper side-by-side diff.
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await openNativeDiff(activeGit, file, commitHash);

            // Scroll to the matching comment in the newly opened diff.
            if (activeComments) {
                const comment = activeComments.load().find(c => c.commitHash === commitHash && c.file === file && c.side === (side === 'old' ? 'left' : 'right'))
                    ?? activeComments.load().find(c => c.commitHash === commitHash && c.file === file);
                if (comment) {
                    setTimeout(() => {
                        vscode.commands.executeCommand('revealLine', {
                            lineNumber: comment.line - 1,
                            at: 'center',
                        });
                    }, 400);
                }
            }
        })
    );

    // ── Status bar ────────────────────────────────────────────────────────────
    // StatusBarItem is the clickable text/icon in the bottom-left status bar.
    // Setting .command means clicking it runs that registered command.
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    statusBar.command = 'commitReview.selectRepo';
    statusBar.tooltip = 'Select repo for Commit Review';
    context.subscriptions.push(statusBar);

    // ── Shared refresh ────────────────────────────────────────────────────────

    /** Full refresh: re-fetches git data. Use on repo/branch switch or new commits. */
    function refreshAll(): void {
        try {
            activeCommentsView?.refresh();
        } catch {
            /* ignore */
        }
        try {
            activeChangesView?.refresh();
        } catch {
            /* ignore */
        }
        try {
            activeCommentController?.refresh();
        } catch {
            /* ignore */
        }
        updateStatusBar();
    }

    /** Light refresh: comment counts + tree only, no git exec. Used on comment-only mutations. */
    let mutationPending = false;
    function refreshOnMutation(_id?: string): void {
        if (mutationPending) return;
        mutationPending = true;
        queueMicrotask(() => {
            mutationPending = false;
            try {
                activeCommentsView?.refresh();
            } catch {
                /* ignore */
            }
            try {
                activeChangesView?.refreshCommentCounts();
            } catch {
                /* ignore */
            }
            updateStatusBar();
        });
    }

    // Wire the comment controller's mutation callback.
    if (activeCommentController) activeCommentController.onCommentMutation = refreshOnMutation;

    // ── Git change handler ─────────────────────────────────────────────────────
    // Called when .git/HEAD changes (branch switch) or .git/refs/heads/** changes
    // (new commit on current branch, or any branch update).
    function onGitChange(): void {
        if (!activeGit || !activeComments) return;
        const branch = activeGit.getCurrentBranch();
        const hashes = activeGit.getBranchCommitHashes(branch);

        activeComments.switchBranch(branch, hashes);
        refreshAll();
    }

    // ── Switch to a repo ──────────────────────────────────────────────────────
    function switchToRepo(repoPath: string): void {
        // Show loading state in all panels immediately
        activeChangesView?.showLoading();
        activeCommentsView?.showLoading();

        // Tear down previous watchers
        for (const d of gitFsWatchers) d.dispose();
        gitFsWatchers = [];
        commentChangeDisposable?.dispose();
        activeComments?.dispose();

        activeGit = new GitService(repoPath);
        activeComments = new CommentManager(repoPath, context.globalState);

        // Restore stored base branch so commit range is correct on reload.
        activeGit.defaultBranch = activeComments.getBaseBranch() ?? '';

        // Migrate old per-branch JSON files and old flat DB into globalState.
        activeComments.migrateOldFiles(context.globalStorageUri);

        // Start watching the working JSON for external (agent) edits.
        activeComments.startWatching();

        // Keep the content provider's git service up to date.
        gitContentProvider.setGit(activeGit);
        activeCommentsView?.updateServices(activeComments);
        activeChangesView?.updateServices(activeGit, activeComments);
        activeCommentController?.updateRepo(repoPath, activeComments, activeGit);
        if (activeCommentController) activeCommentController.onCommentMutation = refreshOnMutation;

        // Auto-refresh when the working JSON changes externally (agent updates).
        commentChangeDisposable = activeComments.onDidChange(refreshAll);

        // Initialise the working JSON for the current branch.
        const branch = activeGit.getCurrentBranch();
        const hashes = activeGit.getBranchCommitHashes(branch);
        activeComments.switchBranch(branch, hashes);

        // FileSystemWatcher fires onChange/onCreate events when matching paths change on disk.
        // RelativePattern(repoPath, glob) scopes the watcher to that specific directory.
        // .git/HEAD changes on every branch switch; .git/refs/heads/** changes on every commit.
        const headWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '.git/HEAD'));
        const refsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '.git/refs/heads/**'));
        headWatcher.onDidChange(onGitChange);
        refsWatcher.onDidChange(onGitChange);
        refsWatcher.onDidCreate(onGitChange);
        gitFsWatchers.push(headWatcher, refsWatcher);

        refreshAll();

        const repoName = path.basename(repoPath);
        vscode.window.showInformationMessage(`Commit Review: switched to ${repoName}`);
    }

    // ── Commands ──────────────────────────────────────────────────────────────
    // Commands are named actions invoked from menus, keyboard shortcuts, or code.
    // IDs must match `contributes.commands` entries in package.json.
    // Push each registration to context.subscriptions so it is unregistered on deactivate.

    context.subscriptions.push(
        vscode.commands.registerCommand('commitReview.selectRepo', async () => {
            const allRepos = discoverAllRepos();
            if (allRepos.length === 0) {
                vscode.window.showWarningMessage('No git repositories found in workspace.');
                return;
            }
            if (allRepos.length === 1) {
                switchToRepo(allRepos[0]);
                return;
            }
            const items = allRepos.map(r => ({ label: path.basename(r), description: r, repoPath: r }));
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a repository to review',
            });
            if (picked) switchToRepo(picked.repoPath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('commitReview.repoMenu', async () => {
            const picked = await vscode.window.showQuickPick([
                { label: `$(repo) Select Repository`, id: 'repo' },
                { label: `$(git-branch) Set Base Branch`, id: 'branch' },
            ], { placeHolder: 'Commit Review' });
            if (picked?.id === 'repo') vscode.commands.executeCommand('commitReview.selectRepo');
            if (picked?.id === 'branch') vscode.commands.executeCommand('commitReview.setBaseBranch');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('commitReview.setBaseBranch', async () => {
            if (!activeGit || !activeComments) return;
            const branches = activeGit.getBranches();
            const current = activeComments.getBaseBranch();

            const autoItem: vscode.QuickPickItem = {
                label: '$(circle-slash) Auto-detect',
                description: 'Scan for origin/HEAD, origin/main, origin/master, main, master',
                detail: !current ? '$(check) Currently active' : undefined,
            };
            const separator: vscode.QuickPickItem = { label: '', kind: vscode.QuickPickItemKind.Separator };
            const branchItems: vscode.QuickPickItem[] = branches.map(b => ({
                label: b.name,
                description: b.remote ? 'remote' : 'local',
                detail: b.name === current ? '$(check) Currently active' : undefined,
            }));

            const picked = await vscode.window.showQuickPick([autoItem, separator, ...branchItems], {
                placeHolder: 'Select the base branch used to determine your commit range',
                title: 'Set Base Branch',
            });

            if (!picked) return;

            const branch = picked.label.startsWith('$(circle-slash)') ? undefined : picked.label;
            activeComments.setBaseBranch(branch);
            activeGit.defaultBranch = branch ?? '';
            refreshAll();

            const msg = branch ? `Base branch set to "${branch}"` : 'Base branch reset to auto-detect';
            vscode.window.showInformationMessage(`Commit Review: ${msg}`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('commitReview.copyAgentPrompt', () => {
            if (!activeComments || !activeGit) return;
            copyAgentPrompt(activeGit, activeComments);
        })
    );

    // ── Orphan remap command ────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('commitReview.remapOrphans', async () => {
            if (!activeComments || !activeGit) return;
            if (!activeComments.hasOrphans) {
                vscode.window.showInformationMessage('No orphaned comments to remap.');
                return;
            }

            const count = activeComments.orphanedComments.length;
            const branch = activeGit.getCurrentBranch();
            const commits = activeGit.getCommitsForBranch(branch, 50);

            const items = commits.map(c => ({
                label: `$(${ICONS.GIT_COMMIT}) ${c.shortHash}`,
                description: c.message,
                detail: c.date,
                hash: c.hash,
            }));

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: `Select a commit to receive ${count} orphaned comment(s) (squash/rebase)`,
                title: 'Remap Orphaned Comments',
            });

            if (picked) {
                activeComments.remapOrphans(picked.hash);
                refreshAll();
                vscode.window.showInformationMessage(`Remapped ${count} comment(s) to ${picked.label.replace(`$(${ICONS.GIT_COMMIT}) `, '')}.`);
            }
        })
    );

    // ── Orphan dismiss command ──────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('commitReview.dismissOrphans', () => {
            if (!activeComments) return;
            activeComments.dismissOrphans();
            refreshAll();
        })
    );

    // ── View fix / go to code ──────────────────────────────────────────────────
    // viewFix: open the multi-file diff for the commit where the agent made the fix.
    context.subscriptions.push(
        vscode.commands.registerCommand('commitReview.viewFix', async (hash: string) => {
            if (!activeGit) return;
            const repoPath = activeGit.getRepoPath();
            const parentHash = activeGit.getParentHash(hash) || '__empty__';
            const files = activeGit.getChangedFilesWithStats(hash);
            const resources = files.map(f => {
                const oldRef = f.status === 'A' ? '__empty__' : parentHash;
                const newRef = f.status === 'D' ? '__empty__' : hash;
                const label = vscode.Uri.file(path.join(repoPath, f.path));
                const original = f.status === 'A' ? undefined : GitContentProvider.makeUri(repoPath, f.path, oldRef, 'old', hash);
                const modified = f.status === 'D' ? undefined : GitContentProvider.makeUri(repoPath, f.path, newRef, 'new');
                return [label, original, modified] as [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];
            });
            await vscode.commands.executeCommand('vscode.changes', `Fix: ${hash.slice(0, 7)}`, resources);
        })
    );

    // goToCode: open the current file on disk at the commented line (fallback when no fix commit).
    context.subscriptions.push(
        vscode.commands.registerCommand('commitReview.goToCode', async (file: string, line: number) => {
            if (!activeGit) return;
            const repoPath = activeGit.getRepoPath();
            const absPath = path.join(repoPath, file);
            try {
                const doc = await vscode.workspace.openTextDocument(absPath);
                const editor = await vscode.window.showTextDocument(doc, { preview: true });
                const pos = new vscode.Position(Math.max(0, line - 1), 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } catch {
                vscode.window.showWarningMessage(`Could not open file: ${file}`);
            }
        })
    );

    // ── Auto-select repo ──────────────────────────────────────────────────────
    if (repos.length === 1) {
        switchToRepo(repos[0]);
    } else if (repos.length > 1) {
        updateStatusBar();
        vscode.commands.executeCommand('commitReview.selectRepo');
    } else {
        updateStatusBar();
    }
}

export function deactivate(): void {
    for (const d of gitFsWatchers) d.dispose();
    gitFsWatchers = [];
    commentChangeDisposable?.dispose();
    activeComments?.dispose();
}

// ── Open native diff ──────────────────────────────────────────────────────────

async function openNativeDiff(git: GitService, file: string, commitHash: string): Promise<void> {
    const repoPath = git.getRepoPath();
    const parentHash = git.getParentHash(commitHash) || '__empty__';

    const oldUri = GitContentProvider.makeUri(repoPath, file, parentHash, 'old', commitHash);
    const newUri = GitContentProvider.makeUri(repoPath, file, commitHash, 'new');
    const title = `${path.basename(file)} @ ${commitHash.slice(0, 7)}`;

    await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
}

// ── Agent prompt ──────────────────────────────────────────────────────────────

function copyAgentPrompt(git: GitService, comments: CommentManager): void {
    const open = comments.getOpenComments();
    if (open.length === 0) {
        vscode.window.showInformationMessage('No open comments to address.');
        return;
    }

    const byCommit = new Map<string, typeof open>();
    for (const c of open) {
        if (!byCommit.has(c.commitHash)) byCommit.set(c.commitHash, []);
        byCommit.get(c.commitHash)!.push(c);
    }

    const commits = git.getLog(100);
    const hashToMsg = new Map(commits.map(c => [c.hash, c.message]));

    let prompt = '## Code Review Comments to Address\n\n';
    prompt += 'Please address the following review comments. After fixing each issue, ';
    prompt += 'update `.vscode/commit-reviews.json` — set `"status": "addressed"` and ';
    prompt += '`"addressedByCommit"` to the new commit hash.\n\n---\n\n';

    for (const [hash, cs] of byCommit) {
        const msg = hashToMsg.get(hash) ?? hash;
        prompt += `### Commit \`${hash.slice(0, 8)}\` — ${msg}\n\n`;
        for (const c of cs) {
            prompt += `**${c.file}** line ${c.line} (id: \`${c.id}\`, status: \`${c.status}\`)\n`;
            if (c.codeSnippet) prompt += `\`\`\`\n${c.codeSnippet}\n\`\`\`\n`;
            prompt += `> ${c.body}\n`;
            for (const t of c.thread) prompt += `> — **${t.author}**: ${t.body}\n`;
            prompt += '\n';
        }
    }

    vscode.env.clipboard.writeText(prompt).then(() => {
        vscode.window.showInformationMessage(`Agent prompt copied (${open.length} comment${open.length !== 1 ? 's' : ''}).`);
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function discoverAllRepos(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];
    const all: string[] = [];
    for (const folder of folders) {
        for (const r of GitService.discoverRepos(folder.uri.fsPath)) {
            if (!all.includes(r)) all.push(r);
        }
    }
    return all;
}

function updateStatusBar(): void {
    if (!statusBar) return;
    if (!activeGit) {
        statusBar.text = `$(${ICONS.GIT_PULL_REQUEST}) Select Repo`;
        statusBar.show();
        return;
    }
    const repoName = path.basename(activeGit.getRepoPath());
    const open = activeComments?.getOpenComments() ?? [];
    statusBar.text =
        open.length > 0
            ? `$(${ICONS.COMMENT}) ${repoName}: ${open.length} comment${open.length !== 1 ? 's' : ''}`
            : `$(${ICONS.GIT_PULL_REQUEST}) ${repoName}`;
    statusBar.show();
}
