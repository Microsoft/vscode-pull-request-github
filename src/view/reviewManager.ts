/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import * as vscode from 'vscode';
import type { Branch, Repository } from '../api/api';
import { GitErrorCodes } from '../api/api1';
import { openDescription } from '../commands';
import { IComment } from '../common/comment';
import { DiffChangeType, DiffHunk, parseDiff, parsePatch } from '../common/diffHunk';
import { GitChangeType, InMemFileChange, SlimFileChange } from '../common/file';
import Logger from '../common/logger';
import { parseRepositoryRemotes, Remote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { fromReviewUri, toReviewUri } from '../common/uri';
import { formatError, groupBy } from '../common/utils';
import { FOCUS_REVIEW_MODE } from '../constants';
import { PullRequestViewProvider } from '../github/activityBarViewProvider';
import { GitHubCreatePullRequestLinkProvider } from '../github/createPRLinkProvider';
import { FolderRepositoryManager, SETTINGS_NAMESPACE } from '../github/folderRepositoryManager';
import { GitHubRepository, ViewerPermission } from '../github/githubRepository';
import { PullRequestGitHelper } from '../github/pullRequestGitHelper';
import { IResolvedPullRequestModel, PullRequestModel } from '../github/pullRequestModel';
import { CreatePullRequestHelper } from './createPullRequestHelper';
import { PullRequestChangesTreeDataProvider } from './prChangesTreeDataProvider';
import { RemoteQuickPickItem } from './quickpick';
import { ReviewCommentController } from './reviewCommentController';
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';

export class ReviewManager {
	public static ID = 'Review';
	private _localToDispose: vscode.Disposable[] = [];
	private _disposables: vscode.Disposable[];

	private _comments: IComment[] = [];
	private _localFileChanges: GitFileChangeNode[] = [];
	private _obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];
	private _lastCommitSha?: string;
	private _updateMessageShown: boolean = false;
	private _validateStatusInProgress?: Promise<void>;
	private _reviewCommentController: ReviewCommentController;

	private _statusBarItem: vscode.StatusBarItem;
	private _prNumber?: number;
	private _previousRepositoryState: {
		HEAD: Branch | undefined;
		remotes: Remote[];
	};

	private _webviewViewProvider: PullRequestViewProvider | undefined;
	private _createPullRequestHelper: CreatePullRequestHelper | undefined;

	private _switchingToReviewMode: boolean;

	/**
	 * Flag set when the "Checkout" action is used and cleared on the next git
	 * state update, once review mode has been entered. Used to disambiguate
	 * explicit user action from something like reloading on an existing PR branch.
	 */
	private justSwitchedToRevieMode: boolean = false;

	public get switchingToReviewMode(): boolean {
		return this._switchingToReviewMode;
	}

	public set switchingToReviewMode(newState: boolean) {
		this._switchingToReviewMode = newState;
		if (!newState) {
			this.updateState();
		}
	}

	private _isFirstLoad = true;

	constructor(
		private _context: vscode.ExtensionContext,
		private _repository: Repository,
		private _folderRepoManager: FolderRepositoryManager,
		private _telemetry: ITelemetry,
		public changesInPrDataProvider: PullRequestChangesTreeDataProvider,
	) {
		this._switchingToReviewMode = false;
		this._disposables = [];

		this._previousRepositoryState = {
			HEAD: _repository.state.HEAD,
			remotes: parseRepositoryRemotes(this._repository),
		};

		this.registerListeners();

		this.updateState();
		this.pollForStatusChange();
	}

	private registerListeners(): void {
		this._disposables.push(
			this._repository.state.onDidChange(_ => {
				const oldHead = this._previousRepositoryState.HEAD;
				const newHead = this._repository.state.HEAD;

				if (!oldHead && !newHead) {
					// both oldHead and newHead are undefined
					return;
				}

				let sameUpstream;

				if (!oldHead || !newHead) {
					sameUpstream = false;
				} else {
					sameUpstream = !!oldHead.upstream
						? newHead.upstream &&
						  oldHead.upstream.name === newHead.upstream.name &&
						  oldHead.upstream.remote === newHead.upstream.remote
						: !newHead.upstream;
				}

				const sameHead =
					sameUpstream && // falsy if oldHead or newHead is undefined.
					oldHead!.ahead === newHead!.ahead &&
					oldHead!.behind === newHead!.behind &&
					oldHead!.commit === newHead!.commit &&
					oldHead!.name === newHead!.name &&
					oldHead!.remote === newHead!.remote &&
					oldHead!.type === newHead!.type;

				const remotes = parseRepositoryRemotes(this._repository);
				const sameRemotes =
					this._previousRepositoryState.remotes.length === remotes.length &&
					this._previousRepositoryState.remotes.every(remote => remotes.some(r => remote.equals(r)));

				if (!sameHead || !sameRemotes) {
					this._previousRepositoryState = {
						HEAD: this._repository.state.HEAD,
						remotes: remotes,
					};

					// The first time this event occurs we do want to do visible updates.
					// The first time, oldHead will be undefined.
					// For subsequent changes, we don't want to make visible updates.
					// This occurs on branch changes.
					// Note that the visible changes will occur when checking out a PR.
					this.updateState(!!oldHead);
				}
			}),
		);

		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration(_ => {
				this.updateFocusedViewMode();
			}),
		);

		this._disposables.push(
			this._folderRepoManager.onDidChangeActivePullRequest(_ => {
				this.updateFocusedViewMode();
			}),
		);

		this._disposables.push(
			vscode.window.registerTerminalLinkProvider(
				new GitHubCreatePullRequestLinkProvider(this, this._folderRepoManager),
			),
		);
	}

	get statusBarItem() {
		if (!this._statusBarItem) {
			this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
		}

		return this._statusBarItem;
	}

	get repository(): Repository {
		return this._repository;
	}

	get localFileChanges(): GitFileChangeNode[] {
		return this._localFileChanges;
	}

	private pollForStatusChange() {
		setTimeout(async () => {
			if (!this._validateStatusInProgress) {
				await this.updateComments();
			}
			this.pollForStatusChange();
		}, 1000 * 60 * 5);
	}

	private async checkBranchUpToDate(pr: IResolvedPullRequestModel): Promise<void> {
		const branch = this._repository.state.HEAD;
		if (branch) {
			const remote = branch.upstream ? branch.upstream.remote : null;
			if (remote) {
				const configs = await this._repository.getConfigs();

				const readConfig = (searchKey: string): string | undefined =>
					configs.filter(({ key: k }) => searchKey === k).map(({ value }) => value)[0];

				const ref = readConfig(`branch.${this._repository.state.HEAD?.name}.merge`);
				await this._repository.fetch(remote, ref);
				if (
					(pr.head.sha !== this._lastCommitSha || (branch.behind !== undefined && branch.behind > 0)) &&
					!this._updateMessageShown
				) {
					this._updateMessageShown = true;
					const result = await vscode.window.showInformationMessage(
						'There are updates available for this pull request.',
						{},
						'Pull',
					);

					if (result === 'Pull') {
						await vscode.commands.executeCommand('git.pull');
						this._updateMessageShown = false;
					}
				}
			}
		}
	}

	public async updateState(silent: boolean = false) {
		if (this.switchingToReviewMode) {
			return;
		}
		if (!this._validateStatusInProgress) {
			Logger.appendLine('Review> Validate state in progress');
			this._validateStatusInProgress = this.validateState(silent);
			return this._validateStatusInProgress;
		} else {
			Logger.appendLine('Review> Queuing additional validate state');
			this._validateStatusInProgress = this._validateStatusInProgress.then(async _ => {
				return await this.validateState(silent);
			});

			return this._validateStatusInProgress;
		}
	}

	private async validateState(silent: boolean) {
		Logger.appendLine('Review> Validating state...');
		await this._folderRepoManager.updateRepositories(silent);

		if (!this._repository.state.HEAD) {
			this.clear(true);
			return;
		}

		const branch = this._repository.state.HEAD;
		let matchingPullRequestMetadata = await this._folderRepoManager.getMatchingPullRequestMetadataForBranch();

		if (!matchingPullRequestMetadata) {
			Logger.appendLine(`Review> no matching pull request metadata found for current branch ${branch.name}`);
			const metadataFromGithub = await this._folderRepoManager.getMatchingPullRequestMetadataFromGitHub();
			if (metadataFromGithub) {
				PullRequestGitHelper.associateBranchWithPullRequest(
					this._repository,
					metadataFromGithub.model,
					branch.name!,
				);
				matchingPullRequestMetadata = metadataFromGithub;
			}
		}

		if (!matchingPullRequestMetadata) {
			Logger.appendLine(
				`Review> no matching pull request metadata found on GitHub for current branch ${branch.name}`,
			);
			this.clear(true);
			return;
		}

		const hasPushedChanges = branch.commit !== this._lastCommitSha && branch.ahead === 0 && branch.behind === 0;
		if (this._prNumber === matchingPullRequestMetadata.prNumber && !hasPushedChanges) {
			vscode.commands.executeCommand('pr.refreshList');
			return;
		}

		const remote = branch.upstream ? branch.upstream.remote : null;
		if (!remote) {
			Logger.appendLine(`Review> current branch ${this._repository.state.HEAD.name} hasn't setup remote yet`);
			this.clear(true);
			return;
		}

		// we switch to another PR, let's clean up first.
		Logger.appendLine(
			`Review> current branch ${this._repository.state.HEAD.name} is associated with pull request #${matchingPullRequestMetadata.prNumber}`,
		);
		this.clear(false);
		this._prNumber = matchingPullRequestMetadata.prNumber;
		this._lastCommitSha = undefined;

		const { owner, repositoryName } = matchingPullRequestMetadata;
		Logger.appendLine('Review> Resolving pull request');
		const pr = await this._folderRepoManager.resolvePullRequest(
			owner,
			repositoryName,
			matchingPullRequestMetadata.prNumber,
		);
		if (!pr || !pr.isResolved()) {
			this._prNumber = undefined;
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}

		this._folderRepoManager.activePullRequest = pr;
		this._lastCommitSha = pr.head.sha;

		if (this._isFirstLoad) {
			this._isFirstLoad = false;
			this.checkBranchUpToDate(pr);
		}

		Logger.appendLine('Review> Fetching pull request data');
		await this.getPullRequestData(pr);
		await this.changesInPrDataProvider.addPrToView(
			this._folderRepoManager,
			pr,
			this._localFileChanges,
			this._comments,
			this.justSwitchedToRevieMode,
		);
		this.justSwitchedToRevieMode = false;

		Logger.appendLine(`Review> register comments provider`);
		await this.registerCommentController();

		if (!this._webviewViewProvider) {
			this._webviewViewProvider = new PullRequestViewProvider(
				this._context.extensionUri,
				this._folderRepoManager,
				pr,
			);
			this._context.subscriptions.push(
				vscode.window.registerWebviewViewProvider(
					this._webviewViewProvider.viewType,
					this._webviewViewProvider,
				),
			);
			this._context.subscriptions.push(
				vscode.commands.registerCommand('pr.refreshActivePullRequest', _ => {
					this._webviewViewProvider?.refresh();
				}),
			);

			if (
				!silent &&
				this._context.workspaceState.get(FOCUS_REVIEW_MODE) &&
				vscode.env.remoteName === 'codespaces'
			) {
				this._webviewViewProvider.show();
			}
		} else {
			this._webviewViewProvider.updatePullRequest(pr);
		}

		this.statusBarItem.text = `$(git-branch) Pull Request #${this._prNumber}`;
		this.statusBarItem.command = {
			command: 'pr.openDescription',
			title: 'View Pull Request Description',
			arguments: [pr],
		};
		Logger.appendLine(`Review> display pull request status bar indicator and refresh pull request tree view.`);
		this.statusBarItem.show();
		vscode.commands.executeCommand('pr.refreshList');
		if (!silent && this._context.workspaceState.get(FOCUS_REVIEW_MODE) && vscode.env.remoteName === 'codespaces') {
			if (this.localFileChanges.length > 0) {
				let fileChangeToShow: GitFileChangeNode | undefined;
				for (const fileChange of this.localFileChanges) {
					if (fileChange.status === GitChangeType.MODIFY) {
						fileChangeToShow = fileChange;
						break;
					}
				}
				fileChangeToShow = fileChangeToShow ?? this.localFileChanges[0];
				fileChangeToShow.openDiff(this._folderRepoManager);
			}
		}
		this._validateStatusInProgress = undefined;
	}

	public async updateComments(): Promise<void> {
		const branch = this._repository.state.HEAD;
		if (!branch) {
			return;
		}

		const matchingPullRequestMetadata = await this._folderRepoManager.getMatchingPullRequestMetadataForBranch();
		if (!matchingPullRequestMetadata) {
			return;
		}

		const remote = branch.upstream ? branch.upstream.remote : null;
		if (!remote) {
			return;
		}

		if (this._prNumber === undefined || !this._folderRepoManager.activePullRequest) {
			return;
		}

		const pr = await this._folderRepoManager.resolvePullRequest(
			matchingPullRequestMetadata.owner,
			matchingPullRequestMetadata.repositoryName,
			this._prNumber,
		);

		if (!pr || !pr.isResolved()) {
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}

		await this.checkBranchUpToDate(pr);

		await this.getPullRequestData(pr);
		await this._reviewCommentController.update(this._localFileChanges);

		return Promise.resolve(void 0);
	}

	private async getLocalChangeNodes(
		pr: PullRequestModel & IResolvedPullRequestModel,
		contentChanges: (InMemFileChange | SlimFileChange)[],
		activeComments: IComment[],
	): Promise<GitFileChangeNode[]> {
		const nodes: GitFileChangeNode[] = [];
		const mergeBase = pr.mergeBase || pr.base.sha;
		const headSha = pr.head.sha;

		for (let i = 0; i < contentChanges.length; i++) {
			const change = contentChanges[i];
			let diffHunks: DiffHunk[] = [];

			if (change instanceof InMemFileChange) {
				diffHunks = change.diffHunks;
			} else if (change.status !== GitChangeType.RENAME) {
				try {
					const patch = await this._repository.diffBetween(pr.base.sha, pr.head.sha, change.fileName);
					diffHunks = parsePatch(patch);
				} catch (e) {
					Logger.appendLine(`Failed to parse patch for outdated comments: ${e}`);
				}
			}

			const filePath = nodePath.join(this._repository.rootUri.path, change.fileName).replace(/\\/g, '/');
			const uri = this._repository.rootUri.with({ path: filePath });

			const modifiedFileUri =
				change.status === GitChangeType.DELETE
					? toReviewUri(uri, undefined, undefined, '', false, { base: false }, this._repository.rootUri)
					: uri;

			const originalFileUri = toReviewUri(
				uri,
				change.status === GitChangeType.RENAME ? change.previousFileName : change.fileName,
				undefined,
				change.status === GitChangeType.ADD ? '' : mergeBase,
				false,
				{ base: true },
				this._repository.rootUri,
			);

			const changedItem = new GitFileChangeNode(
				this.changesInPrDataProvider,
				this._folderRepoManager,
				pr,
				change.status,
				change.fileName,
				change.blobUrl,
				modifiedFileUri,
				originalFileUri,
				diffHunks,
				activeComments.filter(comment => comment.path === change.fileName),
				headSha,
			);
			nodes.push(changedItem);
		}

		return nodes;
	}

	private async getPullRequestData(pr: PullRequestModel & IResolvedPullRequestModel): Promise<void> {
		try {
			this._comments = await pr.getReviewComments();
			await pr.initializeReviewThreadCache();
			await pr.getPullRequestFileViewState();
			const activeComments = this._comments.filter(comment => comment.position);
			const outdatedComments = this._comments.filter(comment => !comment.position);

			const data = await pr.getFileChangesInfo();
			const mergeBase = pr.mergeBase || pr.base.sha;

			const contentChanges = await parseDiff(data, this._repository, mergeBase!);
			this._localFileChanges = await this.getLocalChangeNodes(pr, contentChanges, activeComments);

			const commitsGroup = groupBy(outdatedComments, comment => comment.originalCommitId!);
			this._obsoleteFileChanges = [];
			for (const commit in commitsGroup) {
				const commentsForCommit = commitsGroup[commit];
				const commentsForFile = groupBy(commentsForCommit, comment => comment.path!);

				for (const fileName in commentsForFile) {
					let diffHunks: DiffHunk[] = [];
					try {
						const patch = await this._repository.diffBetween(pr.base.sha, commit, fileName);
						diffHunks = parsePatch(patch);
					} catch (e) {
						Logger.appendLine(`Failed to parse patch for outdated comments: ${e}`);
					}

					const oldComments = commentsForFile[fileName];
					const uri = vscode.Uri.file(nodePath.join(`commit~${commit.substr(0, 8)}`, fileName));
					const obsoleteFileChange = new GitFileChangeNode(
						this.changesInPrDataProvider,
						this._folderRepoManager,
						pr,
						GitChangeType.MODIFY,
						fileName,
						undefined,
						toReviewUri(
							uri,
							fileName,
							undefined,
							oldComments[0].originalCommitId!,
							true,
							{ base: false },
							this._repository.rootUri,
						),
						toReviewUri(
							uri,
							fileName,
							undefined,
							oldComments[0].originalCommitId!,
							true,
							{ base: true },
							this._repository.rootUri,
						),
						diffHunks,
						oldComments,
						commit,
					);

					this._obsoleteFileChanges.push(obsoleteFileChange);
				}
			}

			return Promise.resolve(void 0);
		} catch (e) {
			Logger.appendLine(`Review> ${e}`);
		}
	}

	private async registerCommentController() {
		this._reviewCommentController = new ReviewCommentController(
			this,
			this._folderRepoManager,
			this._repository,
			this._localFileChanges,
		);

		await this._reviewCommentController.initialize();

		this._localToDispose.push(this._reviewCommentController);
		this._localToDispose.push(
			this._reviewCommentController.onDidChangeComments(comments => {
				this._comments = comments;
			}),
		);
	}

	public async switch(pr: PullRequestModel): Promise<void> {
		Logger.appendLine(`Review> switch to Pull Request #${pr.number} - start`);
		this.statusBarItem.text = '$(sync~spin) Switching to Review Mode';
		this.statusBarItem.command = undefined;
		this.statusBarItem.show();
		this.switchingToReviewMode = true;

		try {
			const didLocalCheckout = await this._folderRepoManager.checkoutExistingPullRequestBranch(pr);

			if (!didLocalCheckout) {
				await this._folderRepoManager.fetchAndCheckout(pr);
			}
		} catch (e) {
			Logger.appendLine(`Review> checkout failed #${JSON.stringify(e)}`);
			this.switchingToReviewMode = false;

			if (e.gitErrorCode) {
				// for known git errors, we should provide actions for users to continue.
				if (
					e.gitErrorCode === GitErrorCodes.LocalChangesOverwritten ||
					e.gitErrorCode === GitErrorCodes.DirtyWorkTree
				) {
					vscode.window.showErrorMessage(
						'Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches',
					);
					return;
				}
			}

			vscode.window.showErrorMessage(formatError(e));
			// todo, we should try to recover, for example, git checkout succeeds but set config fails.
			return;
		}

		try {
			this.statusBarItem.text = `$(sync~spin) Fetching additional data: pr/${pr.number}`;
			this.statusBarItem.command = undefined;
			this.statusBarItem.show();

			await this._folderRepoManager.fulfillPullRequestMissingInfo(pr);

			/* __GDPR__
				"pr.checkout" : {}
			*/
			this._telemetry.sendTelemetryEvent('pr.checkout');
			Logger.appendLine(`Review> switch to Pull Request #${pr.number} - done`, ReviewManager.ID);
		} finally {
			this.switchingToReviewMode = false;
			this.justSwitchedToRevieMode = true;
			this.statusBarItem.text = `Pull Request #${pr.number}`;
			this.statusBarItem.command = undefined;
			this.statusBarItem.show();
			await this._repository.status();
		}
	}

	public async publishBranch(branch: Branch): Promise<Branch | undefined> {
		const potentialTargetRemotes = await this._folderRepoManager.getAllGitHubRemotes();
		let selectedRemote = (await this.getRemote(
			potentialTargetRemotes,
			`Pick a remote to publish the branch '${branch.name}' to:`,
		))!.remote;

		if (!selectedRemote || branch.name === undefined) {
			return;
		}

		const githubRepo = this._folderRepoManager.createGitHubRepository(
			selectedRemote,
			this._folderRepoManager.credentialStore,
		);
		const permission = await githubRepo.getViewerPermission();
		if (
			permission === ViewerPermission.Read ||
			permission === ViewerPermission.Triage ||
			permission === ViewerPermission.Unknown
		) {
			// No permission to publish the branch to the chosen remote. Offer to fork.
			const fork = await this._folderRepoManager.tryOfferToFork(githubRepo);
			if (!fork) {
				return;
			}
			selectedRemote = this._folderRepoManager.getGitHubRemotes().find(element => element.remoteName === fork);
		}

		if (!selectedRemote) {
			return;
		}
		const remote: Remote = selectedRemote;

		return new Promise<Branch | undefined>(async resolve => {
			const inputBox = vscode.window.createInputBox();
			inputBox.value = branch.name!;
			inputBox.ignoreFocusOut = true;
			inputBox.prompt =
				potentialTargetRemotes.length === 1
					? `The branch '${branch.name}' is not published yet, pick a name for the upstream branch`
					: 'Pick a name for the upstream branch';
			const validate = async function (value: string) {
				try {
					inputBox.busy = true;
					const remoteBranch = await this._reposManager.getBranch(remote, value);
					if (remoteBranch) {
						inputBox.validationMessage = `Branch ${value} already exists in ${remote.owner}/${remote.repositoryName}`;
					} else {
						inputBox.validationMessage = undefined;
					}
				} catch (e) {
					inputBox.validationMessage = undefined;
				}

				inputBox.busy = false;
			};
			await validate(branch.name!);
			inputBox.onDidChangeValue(validate.bind(this));
			inputBox.onDidAccept(async () => {
				inputBox.validationMessage = undefined;
				inputBox.hide();
				try {
					// since we are probably pushing a remote branch with a different name, we use the complete syntax
					// git push -u origin local_branch:remote_branch
					await this._repository.push(remote.remoteName, `${branch.name}:${inputBox.value}`, true);
				} catch (err) {
					if (err.gitErrorCode === GitErrorCodes.PushRejected) {
						vscode.window.showWarningMessage(
							`Can't push refs to remote, try running 'git pull' first to integrate with your change`,
							{
								modal: true,
							},
						);

						resolve(undefined);
					}

					if (err.gitErrorCode === GitErrorCodes.RemoteConnectionError) {
						vscode.window.showWarningMessage(
							`Could not read from remote repository '${remote.remoteName}'. Please make sure you have the correct access rights and the repository exists.`,
							{
								modal: true,
							},
						);

						resolve(undefined);
					}

					// we can't handle the error
					throw err;
				}

				// we don't want to wait for repository status update
				const latestBranch = await this._repository.getBranch(branch.name!);
				if (!latestBranch || !latestBranch.upstream) {
					resolve(undefined);
				}

				resolve(latestBranch);
			});

			inputBox.show();
		});
	}

	private async getRemote(
		potentialTargetRemotes: Remote[],
		placeHolder: string,
		defaultUpstream?: RemoteQuickPickItem,
	): Promise<RemoteQuickPickItem | undefined> {
		if (!potentialTargetRemotes.length) {
			vscode.window.showWarningMessage(`No GitHub remotes found. Add a remote and try again.`);
			return;
		}

		if (potentialTargetRemotes.length === 1 && !defaultUpstream) {
			return RemoteQuickPickItem.fromRemote(potentialTargetRemotes[0]);
		}

		if (
			potentialTargetRemotes.length === 1 &&
			defaultUpstream &&
			defaultUpstream.owner === potentialTargetRemotes[0].owner &&
			defaultUpstream.name === potentialTargetRemotes[0].repositoryName
		) {
			return defaultUpstream;
		}

		let defaultUpstreamWasARemote = false;
		const picks: RemoteQuickPickItem[] = potentialTargetRemotes.map(remote => {
			const remoteQuickPick = RemoteQuickPickItem.fromRemote(remote);
			if (defaultUpstream) {
				const { owner, name } = defaultUpstream;
				remoteQuickPick.picked = remoteQuickPick.owner === owner && remoteQuickPick.name === name;
				if (remoteQuickPick.picked) {
					defaultUpstreamWasARemote = true;
				}
			}
			return remoteQuickPick;
		});
		if (!defaultUpstreamWasARemote && defaultUpstream) {
			picks.unshift(defaultUpstream);
		}

		const selected: RemoteQuickPickItem | undefined = await vscode.window.showQuickPick<RemoteQuickPickItem>(
			picks,
			{
				ignoreFocusOut: true,
				placeHolder: placeHolder,
			},
		);

		if (!selected) {
			return;
		}

		return selected;
	}

	public async createPullRequest(compareBranch?: string): Promise<void> {
		if (!this._createPullRequestHelper) {
			this._createPullRequestHelper = new CreatePullRequestHelper(this.repository);
			this._createPullRequestHelper.onDidCreate(async createdPR => {
				await this.updateState();
				const descriptionNode = this.changesInPrDataProvider.getDescriptionNode(this._folderRepoManager);
				await openDescription(
					this._context,
					this._telemetry,
					createdPR,
					descriptionNode,
					this._folderRepoManager,
				);
			});
		}

		this._createPullRequestHelper.create(this._context.extensionUri, this._folderRepoManager, compareBranch);
	}

	public async openDescription(): Promise<void> {
		const pullRequest = this._folderRepoManager.activePullRequest;
		if (!pullRequest) {
			return;
		}

		const descriptionNode = this.changesInPrDataProvider.getDescriptionNode(this._folderRepoManager);
		await openDescription(
			this._context,
			this._telemetry,
			pullRequest,
			descriptionNode,
			this._folderRepoManager,
		);
	}

	get isCreatingPullRequest() {
		return this._createPullRequestHelper?.isCreatingPullRequest ?? false;
	}

	private async updateFocusedViewMode(): Promise<void> {
		const focusedSetting = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get('focusedMode');
		if (focusedSetting && this._folderRepoManager.activePullRequest) {
			vscode.commands.executeCommand('setContext', FOCUS_REVIEW_MODE, true);
			await this._context.workspaceState.update(FOCUS_REVIEW_MODE, true);
		} else {
			vscode.commands.executeCommand('setContext', FOCUS_REVIEW_MODE, false);
			this._context.workspaceState.update(FOCUS_REVIEW_MODE, false);
		}
	}

	private clear(quitReviewMode: boolean) {
		this._updateMessageShown = false;

		this._localToDispose.forEach(disposable => disposable.dispose());

		if (quitReviewMode) {
			this._prNumber = undefined;
			this._folderRepoManager.activePullRequest = undefined;

			if (this._statusBarItem) {
				this._statusBarItem.hide();
			}

			if (this.changesInPrDataProvider) {
				this.changesInPrDataProvider.removePrFromView(this._folderRepoManager);
			}

			// Ensure file explorer decorations are removed. When switching to a different PR branch,
			// comments are recalculated when getting the data and the change decoration fired then,
			// so comments only needs to be emptied in this case.
			this._comments = [];

			vscode.commands.executeCommand('pr.refreshList');
		}
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string | undefined> {
		const { path, commit } = fromReviewUri(uri);
		let changedItems = gitFileChangeNodeFilter(this._localFileChanges)
			.filter(change => change.fileName === path)
			.filter(
				fileChange =>
					fileChange.sha === commit ||
					(fileChange.parentSha ? fileChange.parentSha : `${fileChange.sha}^`) === commit,
			);

		if (changedItems.length) {
			const changedItem = changedItems[0];
			const diffChangeTypeFilter = commit === changedItem.sha ? DiffChangeType.Delete : DiffChangeType.Add;
			const ret = changedItem.diffHunks.map(diffHunk =>
				diffHunk.diffLines
					.filter(diffLine => diffLine.type !== diffChangeTypeFilter)
					.map(diffLine => diffLine.text),
			);
			return ret.reduce((prev, curr) => prev.concat(...curr), []).join('\n');
		}

		changedItems = gitFileChangeNodeFilter(this._obsoleteFileChanges)
			.filter(change => change.fileName === path)
			.filter(
				fileChange =>
					fileChange.sha === commit ||
					(fileChange.parentSha ? fileChange.parentSha : `${fileChange.sha}^`) === commit,
			);

		if (changedItems.length) {
			// it's from obsolete file changes, which means the content is in complete.
			const changedItem = changedItems[0];
			const diffChangeTypeFilter = commit === changedItem.sha ? DiffChangeType.Delete : DiffChangeType.Add;
			const ret: string[] = [];
			const commentGroups = groupBy(changedItem.comments, comment => String(comment.originalPosition));

			for (const comment_position in commentGroups) {
				if (!commentGroups[comment_position][0].diffHunks) {
					continue;
				}

				const lines = commentGroups[comment_position][0]
					.diffHunks!.map(diffHunk =>
						diffHunk.diffLines
							.filter(diffLine => diffLine.type !== diffChangeTypeFilter)
							.map(diffLine => diffLine.text),
					)
					.reduce((prev, curr) => prev.concat(...curr), []);
				ret.push(...lines);
			}

			return ret.join('\n');
		}
	}

	dispose() {
		this.clear(true);
		this._disposables.forEach(d => {
			d.dispose();
		});
	}

	static getReviewManagerForRepository(
		reviewManagers: ReviewManager[],
		repository: GitHubRepository,
	): ReviewManager | undefined {
		return reviewManagers.find(reviewManager =>
			reviewManager._folderRepoManager.gitHubRepositories.some(repo => repo.equals(repository)),
		);
	}

	static getReviewManagerForFolderManager(
		reviewManagers: ReviewManager[],
		folderManager: FolderRepositoryManager,
	): ReviewManager | undefined {
		return reviewManagers.find(reviewManager => reviewManager._folderRepoManager === folderManager);
	}
}
