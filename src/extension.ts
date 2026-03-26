import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './GitService';
import { CommentManager } from './CommentManager';
import { ReviewPanel } from './ReviewPanel';
import { CommentsView } from './CommentsView';
import { ChangesView } from './ChangesView';
import { DiffPanel } from './DiffPanel';
import { GitContentProvider } from './GitContentProvider';
import { ReviewCommentController } from './ReviewCommentController';

// ── Mutable active-repo state ────────────────────────────────────────────────

let activeGit: GitService | undefined;
let activeComments: CommentManager | undefined;
let activeReviewPanel: ReviewPanel | undefined;
let activeCommentsView: CommentsView | undefined;
let activeChangesView: ChangesView | undefined;
let activeCommentController: ReviewCommentController | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let commentChangeDisposable: vscode.Disposable | undefined;
/** Disposables for the .git/HEAD and .git/refs watchers of the active repo. */
let gitFsWatchers: vscode.Disposable[] = [];
/** The branch name last loaded — used to detect branch switches vs. same-branch commits. */
let activeBranch = '';

export function activate(context: vscode.ExtensionContext): void {
  const repos = discoverAllRepos();

  // ── Git content provider (serves file content at specific commits) ─────────
  const gitContentProvider = new GitContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      GitContentProvider.scheme,
      gitContentProvider,
    ),
  );

  // ── Native comment controller ─────────────────────────────────────────────
  activeCommentController = new ReviewCommentController(context, new CommentManager('', context.globalState));
  context.subscriptions.push(activeCommentController);

  // ── Commits sidebar WebviewView ───────────────────────────────────────────
  activeReviewPanel = ReviewPanel.register(context, new GitService(''));

  // When the user expands a commit: push its file list to the sidebar.
  activeReviewPanel.onExpandCommit = (hash) => {
    if (!activeGit) return;
    const files = activeGit.getChangedFilesWithStats(hash);
    activeReviewPanel?.sendCommitFiles(hash, files);
  };

  // When a commit is selected (clicked), also expand its files immediately.
  activeReviewPanel.onSelectionChanged = (hashes) => {
    if (!activeGit) return;
    for (const hash of hashes) {
      const files = activeGit.getChangedFilesWithStats(hash);
      activeReviewPanel?.sendCommitFiles(hash, files);
    }
  };

  // When the user clicks a file row in the sidebar: open the native VS Code diff.
  activeReviewPanel.onJumpToFile = (hash, file) => {
    if (!activeGit) return;
    openNativeDiff(activeGit, file, hash);
  };

  // When the user clicks the repo select button in the sidebar.
  activeReviewPanel.onSelectRepo = () => {
    vscode.commands.executeCommand('commitReview.selectRepo');
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ReviewPanel.viewType,
      activeReviewPanel,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

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
  activeCommentsView.onDeleteComment = (id) => {
    if (!activeComments) return;
    activeComments.deleteComment(id);
    refreshAll();
  };

  // When the user changes a comment's status from the tree.
  activeCommentsView.onUpdateStatus = (id, status) => {
    if (!activeComments) return;
    activeComments.updateStatus(id, status as import('./CommentManager').CommentStatus);
    refreshAll();
  };

  const commentsTreeView = activeCommentsView.createTreeView();
  context.subscriptions.push(commentsTreeView);

  // ── Changes sidebar WebviewView ───────────────────────────────────────────
  activeChangesView = ChangesView.register(context, new GitService(''), new CommentManager('', context.globalState));

  // File click → open accumulated branch diff (all files) in DiffPanel, anchored on file
  activeChangesView.onJumpToFile = (file) => {
    if (!activeGit || !activeComments) return;
    const branch = activeGit.getCurrentBranch();
    const base   = activeGit.getMergeBase(branch);
    const head   = activeGit.getHeadHash();
    if (!base || !head) return;
    const hashes = activeGit.getBranchCommitHashes(branch);
    const panel  = DiffPanel.createOrShow(context, activeGit, activeComments);
    panel.onCommentMutation = refreshAll;
    panel.showBranchDiff(base, head, hashes);
    panel.focusFile(file);
  };

  // Hash badge click → open single commit diff (all files) in DiffPanel, anchored on file
  activeChangesView.onJumpToCommitFile = (hash, file) => {
    if (!activeGit || !activeComments) return;
    const panel = DiffPanel.createOrShow(context, activeGit, activeComments);
    panel.onCommentMutation = refreshAll;
    panel.showSelection([hash]);
    panel.focusFile(file);
  };

  // Native diff: file click → cumulative single-file diff (branch base → HEAD)
  activeChangesView.onJumpToFileNative = async (file) => {
    if (!activeGit) return;
    const branch = activeGit.getCurrentBranch();
    const base   = activeGit.getMergeBase(branch);
    const head   = activeGit.getHeadHash();
    if (!base || !head) return;
    const repoPath = activeGit.getRepoPath();
    const oldUri = GitContentProvider.makeUri(repoPath, file, base, 'old');
    const newUri = GitContentProvider.makeUri(repoPath, file, head, 'new');
    await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, `${path.basename(file)} (branch changes)`);
  };

  // Native diff: hash badge click → single-file diff for that commit
  activeChangesView.onJumpToCommitFileNative = async (hash, file) => {
    if (!activeGit) return;
    await openNativeDiff(activeGit, file, hash);
  };

  // Jump-to-source arrow → open the file in the editor at the first changed line
  activeChangesView.onJumpToSource = async (file) => {
    if (!activeGit) return;
    const repoPath = activeGit.getRepoPath();
    const absPath  = path.join(repoPath, file);
    const line     = activeGit.getFirstChangedLine(file);
    try {
      const doc = await vscode.workspace.openTextDocument(absPath);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch { /* file may not exist */ }
  };

  // Comment badge click → open the diff at the first comment on that file
  activeChangesView.onJumpToComment = async (file) => {
    if (!activeGit || !activeComments) return;
    const all = activeComments.load();
    const comment = all.find(c => c.file === file);
    if (!comment) return;
    await openNativeDiff(activeGit, comment.file, comment.commitHash);
    setTimeout(() => {
      vscode.commands.executeCommand('revealLine', { lineNumber: comment.line - 1, at: 'center' });
    }, 300);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChangesView.viewType,
      activeChangesView,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ── COMMENTS panel → open proper diff when a gitFile:// doc is activated standalone ──
  // When the user clicks a comment in the native COMMENTS panel, VS Code opens the
  // gitFile:// URI directly (not in a diff editor). Intercept that and redirect to
  // the proper side-by-side diff view.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (!editor) return;
      const uri = editor.document.uri;
      if (uri.scheme !== GitContentProvider.scheme) return;

      // Skip if already inside a diff editor (the active tab is a TextDiff).
      const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
      if (activeTab?.input instanceof vscode.TabInputTextDiff) return;

      const params = new URLSearchParams(uri.query);
      const commitHash = params.get('ref') ?? '';
      const side       = params.get('side');
      if (!commitHash || side !== 'new') return;
      if (!activeGit) return;

      const file = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;

      // Replace the standalone file view with a proper side-by-side diff.
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await openNativeDiff(activeGit, file, commitHash);

      // Scroll to the first matching comment in the newly opened diff.
      if (activeComments) {
        const comment = activeComments.load().find(
          c => c.commitHash === commitHash && c.file === file,
        );
        if (comment) {
          setTimeout(() => {
            vscode.commands.executeCommand('revealLine', {
              lineNumber: comment.line - 1,
              at: 'center',
            });
          }, 400);
        }
      }
    }),
  );

  // ── Status bar ────────────────────────────────────────────────────────────
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = 'commitReview.selectRepo';
  statusBar.tooltip = 'Select repo for Commit Review';
  context.subscriptions.push(statusBar);

  // ── Shared refresh (called after any comment mutation) ────────────────────
  function refreshAll(): void {
    try { activeReviewPanel?.sendCommits(); }   catch { /* ignore git errors */ }
    try { activeCommentsView?.refresh(); }      catch { /* ignore */ }
    try { activeChangesView?.refresh(); }       catch { /* ignore */ }
    try { activeCommentController?.refresh(); } catch { /* ignore */ }
    updateStatusBar();
  }

  // Wire the comment controller's mutation callback.
  if (activeCommentController) activeCommentController.onCommentMutation = refreshAll;

  // ── Git change handler ─────────────────────────────────────────────────────
  // Called when .git/HEAD changes (branch switch) or .git/refs/heads/** changes
  // (new commit on current branch, or any branch update).
  function onGitChange(): void {
    if (!activeGit || !activeComments) return;
    const branch = activeGit.getCurrentBranch();
    const hashes = activeGit.getBranchCommitHashes(branch);

    if (branch !== activeBranch) {
      // Branch switched — re-populate the working JSON from the DB.
      activeBranch = branch;
      activeComments.switchBranch(branch, hashes);
    } else {
      // Same branch, new commit — re-populate (new hash is now in the set)
      // and refresh the commits list.
      activeComments.switchBranch(branch, hashes);
    }

    refreshAll();
  }

  // ── Switch to a repo ──────────────────────────────────────────────────────
  function switchToRepo(repoPath: string): void {
    // Tear down previous watchers
    for (const d of gitFsWatchers) d.dispose();
    gitFsWatchers = [];
    activeBranch = '';
    commentChangeDisposable?.dispose();
    activeComments?.dispose();

    activeGit = new GitService(repoPath);
    activeComments = new CommentManager(repoPath, context.globalState);

    // Migrate old per-branch JSON files and old flat DB into globalState.
    activeComments.migrateOldFiles(context.globalStorageUri);

    // Start watching the working JSON for external (agent) edits.
    activeComments.startWatching();

    // Keep the content provider's git service up to date.
    gitContentProvider.setGit(activeGit);
    activeReviewPanel?.updateServices(activeGit);
    activeCommentsView?.updateServices(activeComments);
    activeChangesView?.updateServices(activeGit, activeComments);
    activeCommentController?.updateRepo(repoPath, activeComments, activeGit);
    if (activeCommentController) activeCommentController.onCommentMutation = refreshAll;

    // Auto-refresh when the working JSON changes externally (agent updates).
    commentChangeDisposable = activeComments.onDidChange(refreshAll);

    // Initialise the working JSON for the current branch.
    const branch = activeGit.getCurrentBranch();
    const hashes = activeGit.getBranchCommitHashes(branch);
    activeBranch = branch;
    activeComments.switchBranch(branch, hashes);

    // Watch .git/HEAD for branch switches and .git/refs/heads/** for new commits.
    const headWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repoPath, '.git/HEAD'),
    );
    const refsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repoPath, '.git/refs/heads/**'),
    );
    headWatcher.onDidChange(onGitChange);
    refsWatcher.onDidChange(onGitChange);
    refsWatcher.onDidCreate(onGitChange);
    gitFsWatchers.push(headWatcher, refsWatcher);

    refreshAll();

    const repoName = path.basename(repoPath);
    vscode.window.showInformationMessage(`Commit Review: switched to ${repoName}`);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.selectRepo', async () => {
      const allRepos = discoverAllRepos();
      if (allRepos.length === 0) {
        vscode.window.showWarningMessage('No git repositories found in workspace.');
        return;
      }
      if (allRepos.length === 1) { switchToRepo(allRepos[0]); return; }
      const items = allRepos.map(r => ({ label: path.basename(r), description: r, repoPath: r }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a repository to review' });
      if (picked) switchToRepo(picked.repoPath);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.openPanel', () => {
      if (!activeGit || !activeComments) {
        vscode.commands.executeCommand('commitReview.selectRepo');
        return;
      }
      vscode.commands.executeCommand(`${ReviewPanel.viewType}.focus`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.copyAgentPrompt', () => {
      if (!activeComments || !activeGit) return;
      copyAgentPrompt(activeGit, activeComments);
    }),
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
        label: `$(git-commit) ${c.shortHash}`,
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
        vscode.window.showInformationMessage(
          `Remapped ${count} comment(s) to ${picked.label.replace('$(git-commit) ', '')}.`,
        );
      }
    }),
  );

  // ── Orphan dismiss command ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('commitReview.dismissOrphans', () => {
      if (!activeComments) return;
      activeComments.dismissOrphans();
      refreshAll();
    }),
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
  const repoPath   = git.getRepoPath();
  const parentHash = git.getParentHash(commitHash) || '__empty__';

  const oldUri = GitContentProvider.makeUri(repoPath, file, parentHash, 'old');
  const newUri = GitContentProvider.makeUri(repoPath, file, commitHash, 'new');
  const title  = `${path.basename(file)} @ ${commitHash.slice(0, 7)}`;

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

  const commits   = git.getLog(100);
  const hashToMsg = new Map(commits.map(c => [c.hash, c.message]));

  let prompt = '## Code Review Comments to Address\n\n';
  prompt += 'Please address the following review comments. After fixing each issue, ';
  prompt += 'update `.vscode/commit-reviews.json` — set `"status": "resolved"` and ';
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
    vscode.window.showInformationMessage(
      `Agent prompt copied (${open.length} comment${open.length !== 1 ? 's' : ''}).`,
    );
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
    statusBar.text = '$(git-pull-request) Select Repo';
    statusBar.show();
    return;
  }
  const repoName = path.basename(activeGit.getRepoPath());
  const open = activeComments?.getOpenComments() ?? [];
  statusBar.text = open.length > 0
    ? `$(comment) ${repoName}: ${open.length} comment${open.length !== 1 ? 's' : ''}`
    : `$(git-pull-request) ${repoName}`;
  statusBar.show();
}
