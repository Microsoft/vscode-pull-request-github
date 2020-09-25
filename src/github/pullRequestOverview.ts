/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { GithubItemStateEnum, ReviewEvent, ReviewState, IAccount, MergeMethodsAvailability, MergeMethod, ISuggestedReviewer } from './interface';
import { formatError } from '../common/utils';
import { GitErrorCodes } from '../api/api';
import { IComment } from '../common/comment';
import Logger from '../common/logger';
import { DescriptionNode } from '../view/treeNodes/descriptionNode';
import { TreeNode, Revealable } from '../view/treeNodes/treeNode';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { PullRequestModel } from './pullRequestModel';
import { TimelineEvent, ReviewEvent as CommonReviewEvent, isReviewEvent } from '../common/timelineEvent';
import { IssueOverviewPanel, IRequestMessage } from './issueOverview';
import { onDidUpdatePR } from '../commands';

export class PullRequestOverviewPanel extends IssueOverviewPanel {
	public static ID: string = 'PullRequestOverviewPanel';
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel?: PullRequestOverviewPanel;

	protected static readonly _viewType: string = 'PullRequestOverview';

	protected _item: PullRequestModel;
	private _repositoryDefaultBranch: string;
	private _existingReviewers: ReviewState[];

	private _changeActivePullRequestListener: vscode.Disposable | undefined;

	public static async createOrShow(extensionPath: string, folderRepositoryManager: FolderRepositoryManager, issue: PullRequestModel, descriptionNode: DescriptionNode, toTheSide: Boolean = false) {
		const activeColumn = toTheSide ?
			vscode.ViewColumn.Beside :
			vscode.window.activeTextEditor ?
				vscode.window.activeTextEditor.viewColumn :
				vscode.ViewColumn.One;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.currentPanel._panel.reveal(activeColumn, true);
		} else {
			const title = `Pull Request #${issue.number.toString()}`;
			PullRequestOverviewPanel.currentPanel = new PullRequestOverviewPanel(extensionPath, activeColumn || vscode.ViewColumn.Active, title, folderRepositoryManager, descriptionNode);
		}

		await PullRequestOverviewPanel.currentPanel!.update(folderRepositoryManager, issue, descriptionNode);
	}

	protected set _currentPanel(panel: PullRequestOverviewPanel | undefined) {
		PullRequestOverviewPanel.currentPanel = panel;
	}

	public static refresh(): void {
		if (this.currentPanel) {
			this.currentPanel.refreshPanel();
		}
	}

	protected constructor(extensionPath: string, column: vscode.ViewColumn, title: string, folderRepositoryManager: FolderRepositoryManager, descriptionNode: DescriptionNode) {
		super(extensionPath, column, title, folderRepositoryManager, descriptionNode, PullRequestOverviewPanel._viewType);

		this.registerFolderRepositoryListener();

		onDidUpdatePR(pr => {
			if (pr) {
				this._item.update(pr);
			}

			this._postMessage({
				command: 'update-state',
				state: this._item.state,
			});
		}, null, this._disposables);
	}

	registerFolderRepositoryListener() {
		this._changeActivePullRequestListener = this._folderRepositoryManager.onDidChangeActivePullRequest(_ => {
			if (this._folderRepositoryManager && this._item) {
				const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activePullRequest);
				this._postMessage({
					command: 'pr.update-checkout-status',
					isCurrentlyCheckedOut
				});
			}
		});
	}

	/**
	 * Create a list of reviewers composed of people who have already left reviews on the PR, and
	 * those that have had a review requested of them. If a reviewer has left multiple reviews, the
	 * state should be the state of their most recent review, or 'REQUESTED' if they have an outstanding
	 * review request.
	 * @param requestedReviewers The list of reviewers that are requested for this pull request
	 * @param timelineEvents All timeline events for the pull request
	 * @param author The author of the pull request
	 */
	private parseReviewers(requestedReviewers: IAccount[], timelineEvents: TimelineEvent[], author: IAccount): ReviewState[] {
		const reviewEvents = timelineEvents.filter(isReviewEvent).filter(event => event.state !== 'PENDING');
		let reviewers: ReviewState[] = [];
		const seen = new Map<string, boolean>();

		// Do not show the author in the reviewer list
		seen.set(author.login, true);

		for (let i = reviewEvents.length - 1; i >= 0; i--) {
			const reviewer = reviewEvents[i].user;
			if (!seen.get(reviewer.login)) {
				seen.set(reviewer.login, true);
				reviewers.push({
					reviewer: reviewer,
					state: reviewEvents[i].state
				});
			}
		}

		requestedReviewers.forEach(request => {
			if (!seen.get(request.login)) {
				reviewers.push({
					reviewer: request,
					state: 'REQUESTED'
				});
			} else {
				const reviewer = reviewers.find(r => r.reviewer.login === request.login);
				reviewer!.state = 'REQUESTED';
			}
		});

		// Put completed reviews before review requests and alphabetize each section
		reviewers = reviewers.sort((a, b) => {
			if (a.state === 'REQUESTED' && b.state !== 'REQUESTED') {
				return 1;
			}

			if (b.state === 'REQUESTED' && a.state !== 'REQUESTED') {
				return -1;
			}

			return a.reviewer.login.toLowerCase() < b.reviewer.login.toLowerCase() ? -1 : 1;
		});

		this._existingReviewers = reviewers;
		return reviewers;
	}

	/**
	 * Find curently configured user's review status for the current PR
	 * @param reviewers All the reviewers who have been requested to review the current PR
	 * @param pullRequestModel Model of the PR
	 */
	private parseReviewsAndGetState(reviewers:ReviewState[],pullRequestModel:PullRequestModel): String | undefined {
		const user = this._pullRequestManager.getCurrentUser(pullRequestModel);
		const review = reviewers.find(r => r.reviewer.login === user.login);
		// There will always be a review. If not then the PR shouldn't have been or fetched/shown for the current user
		return review?.state;
	}

	public async updatePullRequest(pullRequestModel: PullRequestModel, descriptionNode: DescriptionNode): Promise<void> {
		return Promise.all([
			this._folderRepositoryManager.resolvePullRequest(
				pullRequestModel.remote.owner,
				pullRequestModel.remote.repositoryName,
				pullRequestModel.number
			),
			pullRequestModel.getTimelineEvents(),
			this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(pullRequestModel),
			pullRequestModel.getStatusChecks(),
			pullRequestModel.getReviewRequests(),
			this._folderRepositoryManager.getPullRequestRepositoryAccessAndMergeMethods(pullRequestModel),
		]).then(result => {
			const [pullRequest, timelineEvents, defaultBranch, status, requestedReviewers, repositoryAccess] = result;
			if (!pullRequest) {
				throw new Error(`Fail to resolve Pull Request #${pullRequestModel.number} in ${pullRequestModel.remote.owner}/${pullRequestModel.remote.repositoryName}`);
			}

			this._item = pullRequest;
			this._repositoryDefaultBranch = defaultBranch!;
			this._panel.title = `Pull Request #${pullRequestModel.number.toString()}`;

			const isCurrentlyCheckedOut = pullRequestModel.equals(this._folderRepositoryManager.activePullRequest);
			const hasWritePermission = repositoryAccess!.hasWritePermission;
			const mergeMethodsAvailability = repositoryAccess!.mergeMethodsAvailability;
			const canEdit = hasWritePermission || this._item.canEdit();
			const preferredMergeMethod = vscode.workspace.getConfiguration('githubPullRequests').get<MergeMethod>('defaultMergeMethod');
			const defaultMergeMethod = getDefaultMergeMethod(mergeMethodsAvailability, preferredMergeMethod);
			const parsedReviewers = this.parseReviewers(requestedReviewers!, timelineEvents!, pullRequest.author);

			Logger.debug('pr.initialize', PullRequestOverviewPanel.ID);
			this._postMessage({
				command: 'pr.initialize',
				pullrequest: {
					number: pullRequest.number,
					title: pullRequest.title,
					url: pullRequest.html_url,
					createdAt: pullRequest.createdAt,
					body: pullRequest.body,
					bodyHTML: pullRequest.bodyHTML,
					labels: pullRequest.item.labels,
					author: {
						login: pullRequest.author.login,
						name: pullRequest.author.name,
						avatarUrl: pullRequest.userAvatar,
						url: pullRequest.author.url
					},
					state: pullRequest.state,
					events: timelineEvents,
					isCurrentlyCheckedOut: isCurrentlyCheckedOut,
					base: pullRequest.base && pullRequest.base.label || 'UNKNOWN',
					head: pullRequest.head && pullRequest.head.label || 'UNKNOWN',
					repositoryDefaultBranch: defaultBranch,
					canEdit: canEdit,
					hasWritePermission,
					status: status ? status : { statuses: [] },
					mergeable: pullRequest.item.mergeable,
					reviewers: parsedReviewers,
					isDraft: pullRequest.isDraft,
					mergeMethodsAvailability,
					defaultMergeMethod,
					isIssue: false,
					reviewState: this.parseReviewsAndGetState(parsedReviewers,pullRequestModel)
				}
			});
		}).catch(e => {
			vscode.window.showErrorMessage(formatError(e));
		});
	}

	public async update(folderRepositoryManager: FolderRepositoryManager, pullRequestModel: PullRequestModel, descriptionNode: DescriptionNode): Promise<void> {
		if (this._folderRepositoryManager !== folderRepositoryManager) {
			this._folderRepositoryManager = folderRepositoryManager;
			if (this._changeActivePullRequestListener) {
				this._changeActivePullRequestListener.dispose();
				this._changeActivePullRequestListener = undefined;
				this.registerFolderRepositoryListener();
			}
		}

		this._descriptionNode = descriptionNode;
		this._postMessage({
			command: 'set-scroll',
			scrollPosition: this._scrollPosition,
		});

		this._panel.webview.html = this.getHtmlForWebview(pullRequestModel.number.toString());

		return this.updatePullRequest(pullRequestModel, descriptionNode);
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}
		switch (message.command) {
			case 'pr.checkout':
				return this.checkoutPullRequest(message);
			case 'pr.merge':
				return this.mergePullRequest(message);
			case 'pr.deleteBranch':
				return this.deleteBranch(message);
			case 'pr.readyForReview':
				return this.setReadyForReview(message);
			case 'pr.approve':
				return this.approvePullRequest(message);
			case 'pr.request-changes':
				return this.requestChanges(message);
			case 'pr.submit':
				return this.submitReview(message);
			case 'pr.checkout-default-branch':
				return this.checkoutDefaultBranch(message);
			case 'pr.apply-patch':
				return this.applyPatch(message);
			case 'pr.open-diff':
				return this.openDiff(message);
			case 'pr.checkMergeability':
				return this._replyMessage(message, await this._item.getMergability());
			case 'pr.add-reviewers':
				return this.addReviewers(message);
			case 'pr.remove-reviewer':
				return this.removeReviewer(message);
		}
	}

	private getReviewersQuickPickItems(assignableUsers: IAccount[], suggestedReviewers: ISuggestedReviewer[] | undefined): vscode.QuickPickItem[] {
		if (!suggestedReviewers) {
			return [];
		}
		// used to track logins that shouldn't be added to pick list
		// e.g. author, existing and already added reviewers
		const skipList: Set<string> = new Set([
			this._item.author.login,
			...this._existingReviewers.map(reviewer => reviewer.reviewer.login)
		]);

		const reviewers: vscode.QuickPickItem[] = [];
		for (const { login, name, isAuthor, isCommenter } of suggestedReviewers) {
			if (skipList.has(login)) {
				continue;
			}

			const suggestionReason: string =
				isAuthor && isCommenter
					? 'Recently edited and reviewed changes to these files'
					: isAuthor
						? 'Recently edited these files'
						: isCommenter
							? 'Recently reviewed changes to these files'
							: 'Suggested reviewer';

			reviewers.push({
				label: login,
				description: name,
				detail: suggestionReason
			});
			// this user shouldn't be added later from assignable users list
			skipList.add(login);
		}

		for (const { login, name } of assignableUsers) {
			if (skipList.has(login)) {
				continue;
			}

			reviewers.push({
				label: login,
				description: name
			});
		}

		return reviewers;
	}

	private async addReviewers(message: IRequestMessage<void>): Promise<void> {
		try {
			const allAssignableUsers = await this._folderRepositoryManager.getAssignableUsers();
			const assignableUsers = allAssignableUsers[this._item.remote.remoteName];

			const reviewersToAdd = await vscode.window.showQuickPick(
				this.getReviewersQuickPickItems(assignableUsers, this._item.suggestedReviewers),
				{
					canPickMany: true,
					matchOnDescription: true
				}
			);

			if (reviewersToAdd) {
				await this._item.requestReview(reviewersToAdd.map(r => r.label));
				const addedReviewers: ReviewState[] = reviewersToAdd.map(reviewer => {
					return {
						// assumes that suggested reviewers will be a subset of assignable users
						reviewer: assignableUsers.find(r => r.login === reviewer.label)!,
						state: 'REQUESTED'
					};
				});

				this._existingReviewers = this._existingReviewers.concat(addedReviewers);
				this._replyMessage(message, {
					added: addedReviewers
				});
			}
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async removeReviewer(message: IRequestMessage<string>): Promise<void> {
		try {
			await this._item.deleteReviewRequest(message.args);

			const index = this._existingReviewers.findIndex(reviewer => reviewer.reviewer.login === message.args);
			this._existingReviewers.splice(index, 1);

			this._replyMessage(message, {});
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async applyPatch(message: IRequestMessage<{ comment: IComment }>): Promise<void> {
		try {
			const comment = message.args.comment;
			const regex = /```diff\n([\s\S]*)\n```/g;
			const matches = regex.exec(comment.body);

			const tempFilePath = path.join(this._folderRepositoryManager.repository.rootUri.path, '.git', `${comment.id}.diff`);

			const encoder = new TextEncoder();
			const tempUri = vscode.Uri.parse(tempFilePath);

			await vscode.workspace.fs.writeFile(tempUri, encoder.encode(matches![1]));
			await this._folderRepositoryManager.repository.apply(tempFilePath, true);
			await vscode.workspace.fs.delete(tempUri);
		} catch (e) {
			Logger.appendLine(`Applying patch failed: ${e}`);
			vscode.window.showErrorMessage(`Applying patch failed: ${formatError(e)}`);
		}
	}

	private openDiff(message: IRequestMessage<{ comment: IComment }>): void {
		try {
			const comment = message.args.comment;
			const prContainer = this._descriptionNode.parent;

			if ((prContainer as TreeNode | Revealable<TreeNode>).revealComment) {
				(prContainer as TreeNode | Revealable<TreeNode>).revealComment!(comment);
			}
		} catch (e) {
			Logger.appendLine(`Open diff view failed: ${formatError(e)}`, PullRequestOverviewPanel.ID);
		}
	}

	private checkoutPullRequest(message: IRequestMessage<any>): void {
		vscode.commands.executeCommand('pr.pick', this._item).then(() => {
			const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activePullRequest);
			this._replyMessage(message, { isCurrentlyCheckedOut: isCurrentlyCheckedOut });
		}, () => {
			const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activePullRequest);
			this._replyMessage(message, { isCurrentlyCheckedOut: isCurrentlyCheckedOut });
		});
	}

	private mergePullRequest(message: IRequestMessage<{ title: string, description: string, method: 'merge' | 'squash' | 'rebase' }>): void {
		const { title, description, method } = message.args;
		this._folderRepositoryManager.mergePullRequest(this._item, title, description, method).then(result => {
			vscode.commands.executeCommand('pr.refreshList');

			if (!result.merged) {
				vscode.window.showErrorMessage(`Merging PR failed: ${result.message}`);
			}

			this._replyMessage(message, {
				state: result.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Open
			});
		}).catch(e => {
			vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
			this._throwError(message, {});
		});
	}

	private async deleteBranch(message: IRequestMessage<any>) {
		const branchInfo = await this._folderRepositoryManager.getBranchNameForPullRequest(this._item);
		const actions: (vscode.QuickPickItem & { type: 'upstream' | 'local' | 'remote' })[] = [];

		if (this._item.isResolved()) {
			const branchHeadRef = this._item.head.ref;

			actions.push({
				label: `Delete remote branch ${this._item.remote.remoteName}/${branchHeadRef}`,
				description: `${this._item.remote.normalizedHost}/${this._item.remote.owner}/${this._item.remote.repositoryName}`,
				type: 'upstream',
				picked: true
			});
		}

		if (branchInfo) {
			const preferredLocalBranchDeletionMethod = vscode.workspace.getConfiguration('githubPullRequests').get<boolean>('defaultDeletionMethod.selectLocalBranch');
			actions.push({
				label: `Delete local branch ${branchInfo.branch}`,
				type: 'local',
				picked: !!preferredLocalBranchDeletionMethod
			});

			const preferredRemoteDeletionMethod = vscode.workspace.getConfiguration('githubPullRequests').get<boolean>('defaultDeletionMethod.selectRemote');

			if (branchInfo.remote && branchInfo.createdForPullRequest && !branchInfo.remoteInUse) {
				actions.push({
					label: `Delete remote ${branchInfo.remote}, which is no longer used by any other branch`,
					type: 'remote',
					picked: !!preferredRemoteDeletionMethod
				});
			}
		}

		if (!actions.length) {
			vscode.window.showWarningMessage(`There is no longer an upstream or local branch for Pull Request #${this._item.number}`);
			this._replyMessage(message, {
				cancelled: true
			});

			return;
		}

		const selectedActions = await vscode.window.showQuickPick(actions, {
			canPickMany: true,
			ignoreFocusOut: true
		});

		if (selectedActions) {
			const isBranchActive = this._item.equals(this._folderRepositoryManager.activePullRequest);

			const promises = selectedActions.map(async (action) => {
				switch (action.type) {
					case 'upstream':
						return this._folderRepositoryManager.deleteBranch(this._item);
					case 'local':
						if (isBranchActive) {
							if (this._folderRepositoryManager.repository.state.workingTreeChanges.length) {
								const response = await vscode.window.showWarningMessage(`Your local changes will be lost, do you want to continue?`, { modal: true }, 'Yes');
								if (response === 'Yes') {
									await vscode.commands.executeCommand('git.cleanAll');
								} else {
									return;
								}
							}
							await this._folderRepositoryManager.repository.checkout(this._repositoryDefaultBranch);
						}
						return await this._folderRepositoryManager.repository.deleteBranch(branchInfo!.branch, true);
					case 'remote':
						return this._folderRepositoryManager.repository.removeRemote(branchInfo!.remote!);
				}
			});

			await Promise.all(promises);

			this.refreshPanel();
			vscode.commands.executeCommand('pr.refreshList');

			this._postMessage({
				command: 'pr.deleteBranch'
			});
		} else {
			this._replyMessage(message, {
				cancelled: true
			});
		}
	}

	private setReadyForReview(message: IRequestMessage<{}>): void {
		this._item.setReadyForReview().then(isDraft => {
			vscode.commands.executeCommand('pr.refreshList');

			this._replyMessage(message, { isDraft });
		}).catch(e => {
			vscode.window.showErrorMessage(`Unable to set PR ready for review. ${formatError(e)}`);
			this._throwError(message, {});
		});
	}

	private async checkoutDefaultBranch(message: IRequestMessage<string>): Promise<void> {
		try {
			const branch = message.args;
			// This should be updated for multi-root support and consume the git extension API if possible
			const branchObj = await this._folderRepositoryManager.repository.getBranch(branch);

			if (branchObj.upstream && branch === branchObj.upstream.name) {
				await this._folderRepositoryManager.repository.checkout(branch);
			} else {
				await vscode.commands.executeCommand('git.checkout');
			}
		} catch (e) {
			if (e.gitErrorCode) {
				// for known git errors, we should provide actions for users to continue.
				if (e.gitErrorCode === GitErrorCodes.DirtyWorkTree) {
					vscode.window.showErrorMessage('Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches');
					return;
				}
			}

			vscode.window.showErrorMessage(`Exiting failed: ${e}`);
		} finally {
			// Complete webview promise so that button becomes enabled again
			this._replyMessage(message, {});
		}
	}

	private updateReviewers(review?: CommonReviewEvent): void {
		if (review) {
			const existingReviewer = this._existingReviewers.find(reviewer => review.user.login === reviewer.reviewer.login);
			if (existingReviewer) {
				existingReviewer.state = review.state;
			} else {
				this._existingReviewers.push({
					reviewer: review.user,
					state: review.state
				});
			}
		}
	}

	private approvePullRequest(message: IRequestMessage<string>): void {
		this._item.approve(message.args).then(review => {
			this.updateReviewers(review);
			this._replyMessage(message, {
				review: review,
				reviewers: this._existingReviewers
			});
			//refresh the pr list as this one is approved
			vscode.commands.executeCommand('pr.refreshList');
		}, (e) => {
			vscode.window.showErrorMessage(`Approving pull request failed. ${formatError(e)}`);

			this._throwError(message, `${formatError(e)}`);
		});
	}

	private requestChanges(message: IRequestMessage<string>): void {
		this._item.requestChanges(message.args).then(review => {
			this.updateReviewers(review);
			this._replyMessage(message, {
				review: review,
				reviewers: this._existingReviewers
			});
		}, (e) => {
			vscode.window.showErrorMessage(`Requesting changes failed. ${formatError(e)}`);
			this._throwError(message, `${formatError(e)}`);
		});
	}

	private submitReview(message: IRequestMessage<string>): void {
		this._item.submitReview(ReviewEvent.Comment, message.args).then(review => {
			this.updateReviewers(review);
			this._replyMessage(message, {
				review: review,
				reviewers: this._existingReviewers
			});
		}, (e) => {
			vscode.window.showErrorMessage(`Submitting review failed. ${formatError(e)}`);
			this._throwError(message, `${formatError(e)}`);
		});
	}

	protected editCommentPromise(comment: IComment, text: string): Promise<IComment> {
		return this._item.editReviewComment(comment, text);
	}

	protected deleteCommentPromise(comment: IComment): Promise<void> {
		return this._item.deleteReviewComment(comment.id.toString());
	}

	dispose() {
		super.dispose();

		if (this._changeActivePullRequestListener) {
			this._changeActivePullRequestListener.dispose();
		}
	}
}

function getDefaultMergeMethod(methodsAvailability: MergeMethodsAvailability, userPreferred: MergeMethod | undefined): MergeMethod {
	// Use default merge method specified by user if it is available
	if (userPreferred && methodsAvailability.hasOwnProperty(userPreferred) && methodsAvailability[userPreferred]) {
		return userPreferred;
	}
	const methods: MergeMethod[] = ['merge', 'squash', 'rebase'];
	// GitHub requires to have at leas one merge method to be enabled; use first available as default
	return methods.find(method => methodsAvailability[method])!;
}
