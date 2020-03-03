/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import * as pathLib from 'path';
import { ReviewManager } from './view/reviewManager';
import { PullRequestOverviewPanel } from './github/pullRequestOverview';
import { fromReviewUri, ReviewUriParams, asImageDataURI, EMPTY_IMAGE_URI } from './common/uri';
import { GitFileChangeNode, InMemFileChangeNode } from './view/treeNodes/fileChangeNode';
import { CommitNode } from './view/treeNodes/commitNode';
import { DirectoryTreeNode } from './view/treeNodes/directoryTreeNode';
import { FilesCategoryNode } from './view/treeNodes/filesCategoryNode';
import { PRNode } from './view/treeNodes/pullRequestNode';
import { PullRequest } from './github/interface';
import { formatError } from './common/utils';
import { GitChangeType } from './common/file';
import { getDiffLineByPosition, getZeroBased } from './common/diffPositionMapping';
import { DiffChangeType } from './common/diffHunk';
import { DescriptionNode } from './view/treeNodes/descriptionNode';
import { listHosts, deleteToken } from './authentication/keychain';
import { writeFile, unlink } from 'fs';
import Logger from './common/logger';
import { GitErrorCodes } from './api/api';
import { IComment } from './common/comment';
import { GHPRComment, TemporaryComment } from './github/prComment';
import { PullRequestManager } from './github/pullRequestManager';
import { PullRequestModel } from './github/pullRequestModel';
import { resolveCommentHandler, CommentReply } from './commentHandlerResolver';
import { ITelemetry } from './common/telemetry';

const _onDidUpdatePR = new vscode.EventEmitter<PullRequest | undefined>();
export const onDidUpdatePR: vscode.Event<PullRequest | undefined> = _onDidUpdatePR.event;

function ensurePR(prManager: PullRequestManager, pr?: PRNode | PullRequestModel): PullRequestModel {
	// If the command is called from the command palette, no arguments are passed.
	if (!pr) {
		if (!prManager.activePullRequest) {
			vscode.window.showErrorMessage('Unable to find current pull request.');
			throw new Error('Unable to find current pull request.');
		}

		return prManager.activePullRequest;
	} else {
		return pr instanceof PRNode ? pr.pullRequestModel : pr;
	}
}

export function registerCommands(context: vscode.ExtensionContext, prManager: PullRequestManager,
	reviewManager: ReviewManager, telemetry: ITelemetry) {
	context.subscriptions.push(vscode.commands.registerCommand('auth.signout', async () => {
		const selection = await vscode.window.showQuickPick(await listHosts(), { canPickMany: true, ignoreFocusOut: true });
		if (!selection) { return; }
		await Promise.all(selection.map(host => deleteToken(host)));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openPullRequestInGitHub', (e: PRNode | DescriptionNode | PullRequestModel) => {
		if (!e) {
			if (prManager.activePullRequest) {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(prManager.activePullRequest.html_url));
			}
		} else if (e instanceof PRNode || e instanceof DescriptionNode) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.pullRequestModel.html_url));
		} else {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.html_url));
		}

		/* __GDPR__
			"pr.openInGitHub" : {}
		*/
		telemetry.sendTelemetryEvent('pr.openInGitHub');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('review.suggestDiff', async (e) => {
		try {
			if (!prManager.activePullRequest) {
				return;
			}

			const { indexChanges, workingTreeChanges } = prManager.repository.state;

			if (!indexChanges.length) {
				if (workingTreeChanges.length) {
					const stageAll = await vscode.window.showWarningMessage('There are no staged changes to suggest.\n\nWould you like to automatically stage all your of changes and suggest them?', { modal: true }, 'Yes');
					if (stageAll === 'Yes') {
						await vscode.commands.executeCommand('git.stageAll');
					} else {
						return;
					}
				} else {
					vscode.window.showInformationMessage('There are no changes to suggest.');
					return;
				}
			}

			const diff = await prManager.repository.diff(true);

			let suggestEditMessage = '';
			if (e && e.inputBox && e.inputBox.value) {
				suggestEditMessage = `${e.inputBox.value}\n`;
				e.inputBox.value = '';
			}

			const suggestEditText = `${suggestEditMessage}\`\`\`diff\n${diff}\n\`\`\``;
			await prManager.createIssueComment(prManager.activePullRequest, suggestEditText);

			// Reset HEAD and then apply reverse diff
			await vscode.commands.executeCommand('git.unstageAll');

			const tempFilePath = pathLib.join(prManager.repository.rootUri.path, '.git', `${prManager.activePullRequest.number}.diff`);
			writeFile(tempFilePath, diff, {}, async (writeError) => {
				if (writeError) {
					throw writeError;
				}

				try {
					await prManager.repository.apply(tempFilePath, true);

					unlink(tempFilePath, (err) => {
						if (err) {
							throw err;
						}
					});
				} catch (err) {
					Logger.appendLine(`Applying patch failed: ${err}`);
					vscode.window.showErrorMessage(`Applying patch failed: ${formatError(err)}`);
				}
			});
		} catch (err) {
			Logger.appendLine(`Applying patch failed: ${err}`);
			vscode.window.showErrorMessage(`Applying patch failed: ${formatError(err)}`);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openFileInGitHub', (e: GitFileChangeNode) => {
		vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.blobUrl!));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.copyCommitHash', (e: CommitNode) => {
		vscode.env.clipboard.writeText(e.sha);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openDiffView', async (fileChangeNode: GitFileChangeNode | InMemFileChangeNode) => {
		openDiffView(fileChangeNode);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openModifiedFile', (e: GitFileChangeNode) => {
		vscode.commands.executeCommand('vscode.open', e.filePath);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openOriginalFile', async (e: GitFileChangeNode) => {
		// if this is an image, encode it as a base64 data URI
		const imageDataURI = await asImageDataURI(e.parentFilePath, prManager.repository);
		vscode.commands.executeCommand('vscode.open', imageDataURI || e.parentFilePath);
	}));

	/**
	 * Retrieves all GitFileChangeNodes under given node.
	 * @param parentNode Files category or directory node
	 */
	async function getGitFileChangeNodes(parentNode: FilesCategoryNode | DirectoryTreeNode): Promise<GitFileChangeNode[]> {
		// Helper function to recursively populate provided array with GitFileChangeNodes
		function populateGitFileChangeNodesHelper(nodeArr: GitFileChangeNode[], node: FilesCategoryNode | DirectoryTreeNode | GitFileChangeNode) {
			if (node instanceof GitFileChangeNode) {
				nodeArr.push(node);
			} else if (node instanceof FilesCategoryNode) {
				node.directories.forEach(child => {
					if (child instanceof DirectoryTreeNode ||
						child instanceof GitFileChangeNode) {
						populateGitFileChangeNodesHelper(nodeArr, child);
					}
				});
			} else if (node instanceof DirectoryTreeNode) {
				node.children.forEach(child => {
					if (child instanceof DirectoryTreeNode ||
						child instanceof GitFileChangeNode) {
						populateGitFileChangeNodesHelper(nodeArr, child);
					}
				});
			}
		}

		const fileChangeNodes: GitFileChangeNode[] = [];
		populateGitFileChangeNodesHelper(fileChangeNodes, parentNode);

		return fileChangeNodes;
	}

	/**
	 * Executes provided command for all GitFileChangeNodes under the given node.
	 * @param e Parent node
	 * @param command Function to be executed on for each GitFileChangeNodes
	 */
	async function executeAll(e: DirectoryTreeNode | FilesCategoryNode, command: (node: GitFileChangeNode) => Promise<void>) {
		// Minimum number of files for warning message to be shown
		const MIN_FILES_FOR_WARNING = 10;
		const messageOptions: vscode.MessageOptions = {
			modal: true
		};

		const nodes: GitFileChangeNode[] = await getGitFileChangeNodes(e);

		// Ask user for confirmation when opening large number of files
		if (nodes.length >= MIN_FILES_FOR_WARNING) {
			vscode.window.showWarningMessage(`Are you sure you want to open ${nodes.length} files?`, messageOptions, 'Yes').then(async option => {
				if (option === 'Yes') {
					// Ensure files are processed in the same order
					for (const node of nodes) {
						await command(node);
					}
				}
			});
		} else {
			// Ensure files are processed in the same order
			for (const node of nodes) {
				await command(node);
			}
		}
	}

	/**
	 * Opens diff view for given file.
	 * @param fileChangeNode Node representing a file change
	 * @param openOptions Optional options to open the diff view
	 */
	async function openDiffView(fileChangeNode: GitFileChangeNode, openOptions?: vscode.TextDocumentShowOptions) {
		const parentFilePath = fileChangeNode.parentFilePath;
		const filePath = fileChangeNode.filePath;
		const fileName = fileChangeNode.fileName;
		const isPartial = fileChangeNode.isPartial;
		const opts = openOptions || fileChangeNode.opts;

		fileChangeNode.reveal(fileChangeNode, { select: true, focus: true });

		if (isPartial) {
			vscode.window.showInformationMessage('Your local repository is not up to date so only partial content is being displayed');
		}

		let parentURI = await asImageDataURI(parentFilePath, prManager.repository) || parentFilePath;
		let headURI = await asImageDataURI(filePath, prManager.repository) || filePath;
		if (parentURI.scheme === 'data' || headURI.scheme === 'data') {
			if (fileChangeNode.status === GitChangeType.ADD) {
				parentURI = EMPTY_IMAGE_URI;
			}
			if (fileChangeNode.status === GitChangeType.DELETE) {
				headURI = EMPTY_IMAGE_URI;
			}
		}

		await vscode.commands.executeCommand('vscode.diff', parentURI, headURI, fileName, opts);
	}

	context.subscriptions.push(vscode.commands.registerCommand('pr.openAllDiffViews', (e: DirectoryTreeNode | FilesCategoryNode) => {
		executeAll(e, async (fileChangeNode: GitFileChangeNode) => {
			const openOptions: vscode.TextDocumentShowOptions = {
				preserveFocus: true,
				preview: false
			};
			await openDiffView(fileChangeNode, openOptions);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openAllModifiedFiles', (e: DirectoryTreeNode | FilesCategoryNode) => {
		executeAll(e, async (node: GitFileChangeNode) => {
			const openOptions: vscode.TextDocumentShowOptions = {
				preserveFocus: true,
				preview: false
			};
			await vscode.commands.executeCommand('vscode.open', node.filePath, openOptions);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openAllOriginalFiles', (e: DirectoryTreeNode | FilesCategoryNode) => {
		executeAll(e, async (node: GitFileChangeNode) => {
			const openOptions: vscode.TextDocumentShowOptions = {
				preserveFocus: true,
				preview: false
			};

			// if this is an image, encode it as a base64 data URI
			const imageDataURI = await asImageDataURI(node.parentFilePath, prManager.repository);
			await vscode.commands.executeCommand('vscode.open', imageDataURI || node.parentFilePath, openOptions);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.deleteLocalBranch', async (e: PRNode) => {
		const pullRequestModel = ensurePR(prManager, e);
		const DELETE_BRANCH_FORCE = 'delete branch (even if not merged)';
		let error = null;

		try {
			await prManager.deleteLocalPullRequest(pullRequestModel);
		} catch (e) {
			if (e.gitErrorCode === GitErrorCodes.BranchNotFullyMerged) {
				const action = await vscode.window.showErrorMessage(`The branch '${pullRequestModel.localBranchName}' is not fully merged, are you sure you want to delete it? `, DELETE_BRANCH_FORCE);

				if (action !== DELETE_BRANCH_FORCE) {
					return;
				}

				try {
					await prManager.deleteLocalPullRequest(pullRequestModel, true);
				} catch (e) {
					error = e;
				}
			} else {
				error = e;
			}
		}

		if (error) {
			/* __GDPR__
				"pr.deleteLocalPullRequest.failure" : {
					"message" : { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" }
				}
			*/
			telemetry.sendTelemetryEvent('pr.deleteLocalPullRequest.failure', {
				message: error
			});
			await vscode.window.showErrorMessage(`Deleting local pull request branch failed: ${error}`);
		} else {
			/* __GDPR__
				"pr.deleteLocalPullRequest.success" : {}
			*/
			telemetry.sendTelemetryEvent('pr.deleteLocalPullRequest.success');
			// fire and forget
			vscode.commands.executeCommand('pr.refreshList');
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.create', async () => {
		reviewManager.createPullRequest();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.createDraft', async () => {
		reviewManager.createPullRequest(true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.pick', async (pr: PRNode | DescriptionNode | PullRequestModel) => {
		let pullRequestModel: PullRequestModel;

		if (pr instanceof PRNode || pr instanceof DescriptionNode) {
			pullRequestModel = pr.pullRequestModel;
		} else {
			pullRequestModel = pr;
		}

		const fromDescriptionPage = pr instanceof PullRequestModel;
		/* __GDPR__
			"pr.checkout" : {
				"fromDescriptionPage" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		telemetry.sendTelemetryEvent('pr.checkout', { fromDescription: fromDescriptionPage.toString() });

		return vscode.window.withProgress({
			location: vscode.ProgressLocation.SourceControl,
			title: `Switching to Pull Request #${pullRequestModel.number}`,
		}, async (progress, token) => {
			await reviewManager.switch(pullRequestModel);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.merge', async (pr?: PRNode) => {
		const pullRequest = ensurePR(prManager, pr);
		return vscode.window.showWarningMessage(`Are you sure you want to merge this pull request on GitHub?`, { modal: true }, 'Yes').then(async value => {
			let newPR;
			if (value === 'Yes') {
				try {
					newPR = await prManager.mergePullRequest(pullRequest);
					return newPR;
				} catch (e) {
					vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
					return newPR;
				}
			}

		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.readyForReview', async (pr?: PRNode) => {
		const pullRequest = ensurePR(prManager, pr);
		return vscode.window.showWarningMessage(`Are you sure you want to mark this pull request as ready to review on GitHub?`, { modal: true }, 'Yes').then(async value => {
			let isDraft;
			if (value === 'Yes') {
				try {
					isDraft = await prManager.setReadyForReview(pullRequest);
					vscode.commands.executeCommand('pr.refreshList');
					return isDraft;
				} catch (e) {
					vscode.window.showErrorMessage(`Unable to mark pull request as ready to review. ${formatError(e)}`);
					return isDraft;
				}
			}

		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.close', async (pr?: PRNode, message?: string) => {
		const pullRequest = ensurePR(prManager, pr);
		return vscode.window.showWarningMessage(`Are you sure you want to close this pull request on GitHub? This will close the pull request without merging.`, 'Yes', 'No').then(async value => {
			if (value === 'Yes') {
				try {
					let newComment: IComment | undefined = undefined;
					if (message) {
						newComment = await prManager.createIssueComment(pullRequest, message);
					}

					const newPR = await prManager.closePullRequest(pullRequest);
					vscode.commands.executeCommand('pr.refreshList');
					_onDidUpdatePR.fire(newPR);
					return newComment;
				} catch (e) {
					vscode.window.showErrorMessage(`Unable to close pull request. ${formatError(e)}`);
					_onDidUpdatePR.fire();
				}
			}

			_onDidUpdatePR.fire();
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.approve', async (pr: PullRequestModel, message?: string) => {
		return await prManager.approvePullRequest(pr, message);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.requestChanges', async (pr: PullRequestModel, message?: string) => {
		return await prManager.requestChanges(pr, message);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openDescription', async (descriptionNode: DescriptionNode) => {
		if (!descriptionNode) {
			// the command is triggerred from command palette or status bar, which means we are already in checkout mode.
			const rootNodes = await reviewManager.prFileChangesProvider.getChildren();
			descriptionNode = rootNodes[0] as DescriptionNode;
		}
		const pullRequest = ensurePR(prManager, descriptionNode.pullRequestModel);
		descriptionNode.reveal(descriptionNode, { select: true, focus: true });
		// Create and show a new webview
		PullRequestOverviewPanel.createOrShow(context.extensionPath, prManager, pullRequest, descriptionNode);

		/* __GDPR__
			"pr.openDescription" : {}
		*/
		telemetry.sendTelemetryEvent('pr.openDescription');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.refreshDescription', async () => {
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.refresh();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openDescriptionToTheSide', async (descriptionNode: DescriptionNode) => {
		const pr = descriptionNode.pullRequestModel;
		const pullRequest = ensurePR(prManager, pr);
		descriptionNode.reveal(descriptionNode, { select: true, focus: true });
		// Create and show a new webview
		PullRequestOverviewPanel.createOrShow(context.extensionPath, prManager, pullRequest, descriptionNode, true);

		/* __GDPR__
			"pr.openDescriptionToTheSide" : {}
		*/
		telemetry.sendTelemetryEvent('pr.openDescriptionToTheSide');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.viewChanges', async (fileChange: GitFileChangeNode) => {
		if (fileChange.status === GitChangeType.DELETE || fileChange.status === GitChangeType.ADD) {
			// create an empty `review` uri without any path/commit info.
			const emptyFileUri = fileChange.parentFilePath.with({
				query: JSON.stringify({
					path: null,
					commit: null,
				})
			});

			return fileChange.status === GitChangeType.DELETE
				? vscode.commands.executeCommand('vscode.diff', fileChange.parentFilePath, emptyFileUri, `${fileChange.fileName}`, { preserveFocus: true })
				: vscode.commands.executeCommand('vscode.diff', emptyFileUri, fileChange.parentFilePath, `${fileChange.fileName}`, { preserveFocus: true });
		}

		// Show the file change in a diff view.
		const { path, ref, commit } = fromReviewUri(fileChange.filePath);
		const previousCommit = `${commit}^`;
		const query: ReviewUriParams = {
			path: path,
			ref: ref,
			commit: previousCommit,
			base: true,
			isOutdated: true
		};
		const previousFileUri = fileChange.filePath.with({ query: JSON.stringify(query) });

		const options: vscode.TextDocumentShowOptions = {
			preserveFocus: true
		};

		if (fileChange.comments && fileChange.comments.length) {
			const sortedOutdatedComments = fileChange.comments.filter(comment => comment.position === undefined).sort((a, b) => {
				return a.originalPosition! - b.originalPosition!;
			});

			if (sortedOutdatedComments.length) {
				const diffLine = getDiffLineByPosition(fileChange.diffHunks, sortedOutdatedComments[0].originalPosition!);

				if (diffLine) {
					const lineNumber = Math.max(getZeroBased(diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber), 0);
					options.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				}
			}
		}

		return vscode.commands.executeCommand('vscode.diff', previousFileUri, fileChange.filePath, `${fileChange.fileName} from ${(commit || '').substr(0, 8)}`, options);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.signin', async () => {
		await prManager.authenticate();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.deleteLocalBranchesNRemotes', async () => {
		await prManager.deleteLocalBranchesNRemotes();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.signinAndRefreshList', async () => {
		if (await prManager.authenticate()) {
			vscode.commands.executeCommand('pr.refreshList');
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.configureRemotes', async () => {
		const { name, publisher } = require('../package.json') as { name: string, publisher: string };
		const extensionId = `${publisher}.${name}`;

		return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId} remotes`);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.startReview', async (reply: CommentReply) => {
		/* __GDPR__
			"pr.startReview" : {}
		*/
		telemetry.sendTelemetryEvent('pr.startReview');
		const handler = resolveCommentHandler(reply.thread);

		if (handler) {
			handler.startReview(reply.thread, reply.text);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.finishReview', async (reply: CommentReply) => {
		/* __GDPR__
			"pr.finishReview" : {}
		*/
		telemetry.sendTelemetryEvent('pr.finishReview');
		const handler = resolveCommentHandler(reply.thread);

		if (handler) {
			await handler.finishReview(reply.thread, reply.text);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.deleteReview', async (reply: CommentReply) => {
		/* __GDPR__
			"pr.deleteReview" : {}
		*/
		telemetry.sendTelemetryEvent('pr.deleteReview');
		const shouldDelete = await vscode.window.showWarningMessage('Delete this review and all associated comments?', { modal: true }, 'Delete');
		if (shouldDelete) {
			const handler = resolveCommentHandler(reply.thread);

			if (handler) {
				await handler.deleteReview();
			}

			if (!reply.thread.comments.length) {
				reply.thread.dispose();
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.createComment', async (reply: CommentReply) => {
		/* __GDPR__
			"pr.createComment" : {}
		*/
		telemetry.sendTelemetryEvent('pr.createComment');
		const handler = resolveCommentHandler(reply.thread);

		if (handler) {
			handler.createOrReplyComment(reply.thread, reply.text);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.editComment', async (comment: GHPRComment | TemporaryComment) => {
		/* __GDPR__
			"pr.editComment" : {}
		*/
		telemetry.sendTelemetryEvent('pr.editComment');
		comment.startEdit();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.cancelEditComment', async (comment: GHPRComment | TemporaryComment) => {
		/* __GDPR__
			"pr.cancelEditComment" : {}
		*/
		telemetry.sendTelemetryEvent('pr.cancelEditComment');
		comment.cancelEdit();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.saveComment', async (comment: GHPRComment | TemporaryComment) => {
		/* __GDPR__
			"pr.saveComment" : {}
		*/
		telemetry.sendTelemetryEvent('pr.saveComment');
		const handler = resolveCommentHandler(comment.parent);

		if (handler) {
			await handler.editComment(comment.parent, comment);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.deleteComment', async (comment: GHPRComment | TemporaryComment) => {
		/* __GDPR__
			"pr.deleteComment" : {}
		*/
		telemetry.sendTelemetryEvent('pr.deleteComment');

		const shouldDelete = await vscode.window.showWarningMessage('Delete comment?', { modal: true }, 'Delete');

		if (shouldDelete === 'Delete') {
			const handler = resolveCommentHandler(comment.parent);

			if (handler) {
				await handler.deleteComment(comment.parent, comment);
			}
		}
	}));
}
