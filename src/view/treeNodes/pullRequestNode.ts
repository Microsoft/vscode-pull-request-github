/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { parseDiff, getModifiedContentFromDiffHunk, DiffChangeType, DiffHunk } from '../../common/diffHunk';
import { getZeroBased, getAbsolutePosition, getPositionInDiff, mapHeadLineToDiffHunkPosition } from '../../common/diffPositionMapping';
import { SlimFileChange, GitChangeType } from '../../common/file';
import Logger from '../../common/logger';
import { Resource } from '../../common/resources';
import { fromPRUri, toPRUri } from '../../common/uri';
import { groupBy, uniqBy } from '../../common/utils';
import { DescriptionNode } from './descriptionNode';
import { RemoteFileChangeNode, InMemFileChangeNode, GitFileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';
import { getInMemPRContentProvider } from '../inMemPRContentProvider';
import { Comment } from '../../common/comment';
import { PullRequestManager } from '../../github/pullRequestManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { CommentHandler, convertToVSCodeComment, createVSCodeCommentThread, getReactionGroup, parseGraphQLReaction, updateCommentThreadLabel, updateCommentCommands, updateCommentReviewState, updateCommentReactions } from '../../github/utils';
import { getAcceptInputCommands, getDeleteThreadCommand } from '../../github/commands';

export function provideDocumentComments(
	uri: vscode.Uri,
	isBase: boolean,
	fileChange: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode),
	matchingComments: Comment[]) {

	if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
		return;
	}

	// Partial file change indicates that the file content is only the diff, so the entire
	// document can be commented on.
	const commentingRanges = fileChange.isPartial
		? [new vscode.Range(0, 0, 0, 0)]
		: getCommentingRanges(fileChange.diffHunks, isBase);

	if (!matchingComments || !matchingComments.length) {
		return {
			threads: [],
			commentingRanges
		};
	}

	let sections = groupBy(matchingComments, comment => String(comment.position));
	let threads: vscode.CommentThread[] = [];

	for (let i in sections) {
		let comments = sections[i];

		const firstComment = comments[0];
		let commentAbsolutePosition = fileChange.isPartial
			? getPositionInDiff(firstComment, fileChange.diffHunks, isBase)
			: getAbsolutePosition(firstComment, fileChange.diffHunks, isBase);

		if (commentAbsolutePosition < 0) {
			continue;
		}

		const pos = new vscode.Position(getZeroBased(commentAbsolutePosition), 0);
		const range = new vscode.Range(pos, pos);

		threads.push({
			threadId: firstComment.id.toString(),
			resource: uri,
			range,
			comments: comments.map(comment => convertToVSCodeComment(comment, undefined)),
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
		});
	}

	return {
		threads,
		commentingRanges
	};
}

export function getCommentingRanges(diffHunks: DiffHunk[], isBase: boolean): vscode.Range[] {
	const ranges: vscode.Range[] = [];

	for (let i = 0; i < diffHunks.length; i++) {
		let diffHunk = diffHunks[i];
		let startingLine: number;
		let length: number;
		if (isBase) {
			startingLine = getZeroBased(diffHunk.oldLineNumber);
			length = getZeroBased(diffHunk.oldLength);

		} else {
			startingLine = getZeroBased(diffHunk.newLineNumber);
			length = getZeroBased(diffHunk.newLength);
		}

		ranges.push(new vscode.Range(startingLine, 0, startingLine + length, 0));
	}

	return ranges;
}

function commentsEditedInThread(oldComments: vscode.Comment[], newComments: vscode.Comment[]): boolean {
	return oldComments.some(oldComment => {
		const matchingComment = newComments.filter(newComment => newComment.commentId === oldComment.commentId);
		if (matchingComment.length !== 1) {
			return true;
		}

		if (matchingComment[0].body.value !== oldComment.body.value) {
			return true;
		}

		if (!matchingComment[0].commentReactions && !oldComment.commentReactions) {
			// no comment reactions
			return false;
		}

		if (!matchingComment[0].commentReactions || !oldComment.commentReactions) {
			return true;
		}

		if (matchingComment[0].commentReactions!.length !== oldComment.commentReactions!.length) {
			return true;
		}

		for (let i = 0; i < matchingComment[0].commentReactions!.length; i++) {
			if (matchingComment[0].commentReactions![i].label !== oldComment.commentReactions![i].label ||
				matchingComment[0].commentReactions![i].hasReacted !== oldComment.commentReactions![i].hasReacted) {
				return true;
			}
		}

		return false;
	});
}

export class PRNode extends TreeNode implements CommentHandler, vscode.CommentingRangeProvider, vscode.EmptyCommentThreadFactory, vscode.CommentReactionProvider {
	static ID = 'PRNode';
	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[];
	private _commentController?: vscode.CommentController;
	public get commentController(): vscode.CommentController | undefined {
		return this._commentController;
	}

	private _prDocumentCommentProvider?: vscode.Disposable & { commentThreadCache: { [key: string]: vscode.CommentThread[] } };
	private _disposables: vscode.Disposable[] = [];

	private _inMemPRContentProvider?: vscode.Disposable;

	private _command: vscode.Command;

	public get command():vscode.Command {
		return this._command;
	}

	public set command(newCommand: vscode.Command) {
		this._command = newCommand;
	}

	public availableReactions: vscode.CommentReaction[] = getReactionGroup();

	constructor(
		public parent: TreeNode | vscode.TreeView<TreeNode>,
		private _prManager: PullRequestManager,
		public pullRequestModel: PullRequestModel,
		private _isLocal: boolean
	) {
		super();
		this._fileChanges = [];
	}

	// #region Tree
	async getChildren(): Promise<TreeNode[]> {
		Logger.debug(`Fetch children of PRNode #${this.pullRequestModel.prNumber}`, PRNode.ID);
		try {
			if (this.childrenDisposables && this.childrenDisposables.length) {
				this.childrenDisposables.forEach(dp => dp.dispose());
			}

			const comments = await this._prManager.getPullRequestComments(this.pullRequestModel);
			const data = await this._prManager.getPullRequestFileChangesInfo(this.pullRequestModel);
			const mergeBase = this.pullRequestModel.mergeBase;
			if (!mergeBase) {
				return [];
			}

			const rawChanges = await parseDiff(data, this._prManager.repository, mergeBase);
			let fileChanges = rawChanges.map(change => {
				if (change instanceof SlimFileChange) {
					return new RemoteFileChangeNode(
						this,
						this.pullRequestModel,
						change.status,
						change.fileName,
						change.blobUrl
					);
				}

				const headCommit = this.pullRequestModel.head.sha;
				let changedItem = new InMemFileChangeNode(
					this,
					this.pullRequestModel,
					change.status,
					change.fileName,
					change.previousFileName,
					change.blobUrl,
					toPRUri(vscode.Uri.file(path.resolve(this._prManager.repository.rootUri.fsPath, change.fileName)), this.pullRequestModel, change.baseCommit, headCommit, change.fileName, false, change.status),
					toPRUri(vscode.Uri.file(path.resolve(this._prManager.repository.rootUri.fsPath, change.fileName)), this.pullRequestModel, change.baseCommit, headCommit, change.fileName, true, change.status),
					change.isPartial,
					change.patch,
					change.diffHunks,
					comments.filter(comment => comment.path === change.fileName && comment.position !== null),
				);

				return changedItem;
			});

			if (!this._inMemPRContentProvider) {
				this._inMemPRContentProvider = getInMemPRContentProvider().registerTextDocumentContentProvider(this.pullRequestModel.prNumber, this.provideDocumentContent.bind(this));
			}

			// The review manager will register a document comment's provider, so the node does not need to
			if (!this.pullRequestModel.equals(this._prManager.activePullRequest)) {
				if (!this._prDocumentCommentProvider || !this._commentController) {
					await this.pullRequestModel.githubRepository.ensureCommentsProvider();
					this._commentController = this.pullRequestModel.githubRepository.commentsController!;
					this._prDocumentCommentProvider = this.pullRequestModel.githubRepository.commentsProvider!.registerDocumentCommentProvider(this.pullRequestModel.prNumber, this);

					this._disposables.push(this.pullRequestModel.onDidChangeDraftMode(newDraftMode => {
						if (!newDraftMode) {
							this._fileChanges.forEach(fileChange => {
								if (fileChange instanceof InMemFileChangeNode) {
									fileChange.comments.forEach(c => c.isDraft = newDraftMode);
								}
							});
						}

						for (let fileName in this._prDocumentCommentProvider!.commentThreadCache) {
							this._prDocumentCommentProvider!.commentThreadCache[fileName].forEach(thread => {
								let commands = getAcceptInputCommands(thread, newDraftMode, this, this.pullRequestModel.githubRepository.supportsGraphQl);
								thread.acceptInputCommand = commands.acceptInputCommand;
								thread.additionalCommands = commands.additionalCommands;
								updateCommentReviewState(thread, newDraftMode);
							});
						}
					}));
				}

				this._fileChanges = fileChanges;
				await this.refreshExistingPREditors(vscode.window.visibleTextEditors, true);

				this._disposables.push(vscode.window.onDidChangeVisibleTextEditors(async e => {
					// Create Comment Threads when the editor is visible
					// Dispose when the editor is invisible and remove them from the cache map
					// Comment Threads in cache map is updated only when users trigger refresh
					await this.refreshExistingPREditors(e, false);
				}));
			} else {
				await this.pullRequestModel.githubRepository.ensureCommentsProvider();
				this.pullRequestModel.githubRepository.commentsProvider!.clearCommentThreadCache(this.pullRequestModel.prNumber);
				this._fileChanges = fileChanges;
			}

			let result = [new DescriptionNode(this, 'Description', {
				light: Resource.icons.light.Description,
				dark: Resource.icons.dark.Description
			}, this.pullRequestModel), ...this._fileChanges];

			this.childrenDisposables = result;
			return result;
		} catch (e) {
			Logger.appendLine(e);
			return [];
		}
	}

	async refreshExistingPREditors(editors: vscode.TextEditor[], incremental: boolean): Promise<void> {
		let currentPRDocuments = editors.filter(editor => {
			if (editor.document.uri.scheme !== 'pr') {
				return false;
			}

			const params = fromPRUri(editor.document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.prNumber) {
				return false;
			}

			return true;
		}).map(editor => {
			return {
				fileName: fromPRUri(editor.document.uri)!.fileName,
				document: editor.document
			};
		});

		for (let fileName in this._prDocumentCommentProvider!.commentThreadCache) {
			let commentThreads = this._prDocumentCommentProvider!.commentThreadCache[fileName];

			let matchedEditor = currentPRDocuments.find(editor => editor.fileName === fileName);

			if (!matchedEditor) {
				commentThreads.forEach(thread => thread.dispose!());
				delete this._prDocumentCommentProvider!.commentThreadCache[fileName];
			}
		}

		if (!incremental) {
			// it's tiggerred by file opening, so we only take care newly opened documents.
			currentPRDocuments = currentPRDocuments.filter(editor => this._prDocumentCommentProvider!.commentThreadCache[editor.fileName] === undefined);
		}

		currentPRDocuments = uniqBy(currentPRDocuments, editor => editor.fileName);

		if (currentPRDocuments.length) {
			// initialize before await
			currentPRDocuments.forEach(editor => {
				if (!this._prDocumentCommentProvider!.commentThreadCache[editor.fileName]) {
					this._prDocumentCommentProvider!.commentThreadCache[editor.fileName] = [];
				}
			});

			const inDraftMode = await this._prManager.inDraftMode(this.pullRequestModel);
			currentPRDocuments.forEach(editor => {
				let fileChange = this._fileChanges.find(fc => fc.fileName === editor.fileName);

				if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
					return;
				}

				const parentFilePath = fileChange.parentFilePath;
				const filePath = fileChange.filePath;

				let newLeftCommentThreads = provideDocumentComments(parentFilePath, true, fileChange, fileChange.comments);
				let newRightSideCommentThreads = provideDocumentComments(filePath, false, fileChange, fileChange.comments);

				let oldCommentThreads: vscode.CommentThread[] = [];

				if (incremental) {
					let oldLeftSideCommentThreads = this._prDocumentCommentProvider!.commentThreadCache[editor.fileName].filter(thread => thread.resource.toString() === parentFilePath.toString());
					let oldRightSideCommentThreads = this._prDocumentCommentProvider!.commentThreadCache[editor.fileName].filter(thread => thread.resource.toString() === filePath.toString());

					oldCommentThreads = [...oldLeftSideCommentThreads, ...oldRightSideCommentThreads];
				}

				this.updateFileChangeCommentThreads(oldCommentThreads, [...(newLeftCommentThreads ? newLeftCommentThreads.threads : []), ...(newRightSideCommentThreads ? newRightSideCommentThreads.threads : [])], fileChange, inDraftMode);
			});

		}
	}

	async revealComment(comment: Comment) {
		let fileChange = this._fileChanges.find(fc => {
			if (fc.fileName !== comment.path) {
				return false;
			}

			if (fc.pullRequest.head.sha !== comment.commitId) {
				return false;
			}

			return true;
		});

		if (fileChange) {
			await this.reveal(fileChange, { focus: true });
			if (!fileChange.command.arguments) {
				return;
			}
			if (fileChange instanceof InMemFileChangeNode) {
				let lineNumber = fileChange.getCommentPosition(comment);
				const opts = fileChange.opts;
				opts.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				fileChange.opts = opts;
				await vscode.commands.executeCommand(fileChange.command.command, fileChange);
			} else {
				await vscode.commands.executeCommand(fileChange.command.command, ...fileChange.command.arguments!);
			}
		}
	}

	getTreeItem(): vscode.TreeItem {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this._prManager.activePullRequest);

		const {
			title,
			prNumber,
			author,
			mergeable
		} = this.pullRequestModel;

		const {
			login,
		} = author;

		const labelPrefix = (currentBranchIsForThisPR ? '✓ ' : '');
		const tooltipPrefix = (currentBranchIsForThisPR ? 'Current Branch * ' : '');
		const formattedPRNumber = prNumber.toString();
		const label = `${labelPrefix}${title}`;
		const tooltip = `${tooltipPrefix}${title} (#${formattedPRNumber}) by @${login}`;
		const description = `#${formattedPRNumber} by @${login}`;

		const iconPath = {
			light: mergeable ? 'resources/icons/light/check.svg' : 'resources/icons/delete.svg',
			dark: mergeable ? 'resources/icons/light/check.svg' : 'resources/icons/delete.svg'}
		;

		return {
			label,
			tooltip,
			description,
			collapsibleState: 1,
			contextValue: 'pullrequest' + (this._isLocal ? ':local' : '') + (currentBranchIsForThisPR ? ':active' : ':nonactive'),
			iconPath
		};
	}

	// #endregion

	// #region Helper
	private createCommentThread(fileName: string, commentThreads: vscode.CommentThread[], inDraftMode: boolean) {
		let threads: vscode.CommentThread[] = [];
		commentThreads.forEach(thread => {
			threads.push(createVSCodeCommentThread(thread, this._commentController! , this.pullRequestModel, inDraftMode, this));
		});

		this._prDocumentCommentProvider!.commentThreadCache[fileName] = threads;
	}

	private updateCommentThreadComments(thread: vscode.CommentThread, newComments: vscode.Comment[]) {
		thread.comments = newComments;
		updateCommentThreadLabel(thread);
	}

	private findMatchingFileNode(uri: vscode.Uri): InMemFileChangeNode {
		const params = fromPRUri(uri);

		if (!params) {
			throw new Error(`${uri.toString()} is not valid PR document`);
		}

		const fileChange = this._fileChanges.find(change => change.fileName === params.fileName);

		if (!fileChange) {
			throw new Error('No matching file found');
		}

		if (fileChange instanceof RemoteFileChangeNode) {
			throw new Error('Comments not supported on remote file changes');
		}

		return fileChange;
	}

		// #endregion

	// #region New Comment Thread
	async createEmptyCommentThread(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
		if (await this._prManager.authenticate()) {
			const inDraftMode = await this._prManager.inDraftMode(this.pullRequestModel);
			// threadIds must be unique, otherwise they will collide when vscode saves pending comment text. Assumes
			// that only one empty thread can be created per line.
			const threadId = document.uri.toString() + range.start.line;
			const thread = this._commentController!.createCommentThread(threadId, document.uri, range, []);
			updateCommentThreadLabel(thread);
			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
			let commands = getAcceptInputCommands(thread, inDraftMode, this, this.pullRequestModel.githubRepository.supportsGraphQl);
			thread.acceptInputCommand = commands.acceptInputCommand;
			thread.additionalCommands = commands.additionalCommands;
			thread.deleteCommand = getDeleteThreadCommand(thread);
		}
	}

	private async updateCommentThreadRoot(thread: vscode.CommentThread, text: string): Promise<void> {
		try {
			const uri = thread.resource;
			const params = fromPRUri(uri);

			if (!params || params.prNumber !== this.pullRequestModel.prNumber) {
				return;
			}

			const fileChange = this._fileChanges.find(change => change.fileName === params!.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return;
			}

			const isBase = !!(params && params.isBase);
			const position = mapHeadLineToDiffHunkPosition(fileChange.diffHunks, '', thread.range.start.line + 1, isBase);

			if (position < 0) {
				throw new Error('Comment position cannot be negative');
			}

			// there is no thread Id, which means it's a new thread
			const rawComment = await this._prManager.createComment(this.pullRequestModel, text, params!.fileName, position);
			fileChange.comments.push(rawComment!);
			const vscodeComment = convertToVSCodeComment(rawComment!, undefined);
			updateCommentCommands(vscodeComment, this.commentController!, thread, this.pullRequestModel, this);
			this.updateCommentThreadComments(thread, [vscodeComment]);

			const inDraftMode = await this._prManager.inDraftMode(this.pullRequestModel);
			const commands = getAcceptInputCommands(thread, inDraftMode, this, this.pullRequestModel.githubRepository.supportsGraphQl);

			thread.acceptInputCommand = commands.acceptInputCommand;
			thread.additionalCommands = commands.additionalCommands;

			let existingThreads = this._prDocumentCommentProvider!.commentThreadCache[params.fileName];
			if (existingThreads) {
				this._prDocumentCommentProvider!.commentThreadCache[params.fileName] = [...existingThreads, thread];
			} else {
				this._prDocumentCommentProvider!.commentThreadCache[params.fileName] = [thread];
			}
		} catch (e) {
			Logger.appendLine(e);
		}
	}

	async provideCommentingRanges(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.Range[] | undefined> {
		if (document.uri.scheme === 'pr') {
			const params = fromPRUri(document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.prNumber) {
				return;
			}

			const fileChange = this._fileChanges.find(change => change.fileName === params.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return;
			}

			const commentingRanges = fileChange.isPartial ? [new vscode.Range(0, 0, 0, 0)] : getCommentingRanges(fileChange.diffHunks, params.isBase);

			return commentingRanges;
		}
	}

	// #endregion

	// #region Incremental updates
	private updateFileChangeCommentThreads(oldCommentThreads: vscode.CommentThread[], newCommentThreads: vscode.CommentThread[], newFileChange: InMemFileChangeNode, inDraftMode: boolean) {
		// remove
		oldCommentThreads.forEach(thread => {
			// No current threads match old thread, it has been removed
			const matchingThreads = newCommentThreads && newCommentThreads.filter(newThread => newThread.threadId === thread.threadId);
			if (!matchingThreads.length) {
				thread.dispose!();
			}
		});

		if (newCommentThreads && newCommentThreads.length) {
			let added: vscode.CommentThread[] = [];
			newCommentThreads.forEach(thread => {
				const matchingCommentThread = oldCommentThreads.filter(oldComment => oldComment.threadId === thread.threadId);

				if (matchingCommentThread.length === 0) {
					added.push(thread);
					if (thread.resource.scheme === 'file') {
						thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
					}
				}

				matchingCommentThread.forEach(match => {
					if (match.comments.length !== thread.comments.length || commentsEditedInThread(matchingCommentThread[0].comments, thread.comments)) {
						this.updateCommentThreadComments(match, thread.comments);
					}
				});
			});

			if (added.length) {
				this.createCommentThread(newFileChange.fileName, added, inDraftMode);
			}
		}
	}

	// #endregion

	// #region Document Content Provider
	private async provideDocumentContent(uri: vscode.Uri): Promise<string> {
		let params = fromPRUri(uri);
		if (!params) {
			return '';
		}

		let fileChanges = this._fileChanges.filter(contentChange => (contentChange instanceof InMemFileChangeNode) && contentChange.fileName === params!.fileName);
		if (fileChanges.length) {
			let fileChange = fileChanges[0] as InMemFileChangeNode;
			let readContentFromDiffHunk = fileChange.isPartial || fileChange.status === GitChangeType.ADD || fileChange.status === GitChangeType.DELETE;

			if (readContentFromDiffHunk) {
				if (params.isBase) {
					// left
					let left = [];
					for (let i = 0; i < fileChange.diffHunks.length; i++) {
						for (let j = 0; j < fileChange.diffHunks[i].diffLines.length; j++) {
							let diffLine = fileChange.diffHunks[i].diffLines[j];
							if (diffLine.type === DiffChangeType.Add) {
								// nothing
							} else if (diffLine.type === DiffChangeType.Delete) {
								left.push(diffLine.text);
							} else if (diffLine.type === DiffChangeType.Control) {
								// nothing
							} else {
								left.push(diffLine.text);
							}
						}
					}

					return left.join('\n');
				} else {
					let right = [];
					for (let i = 0; i < fileChange.diffHunks.length; i++) {
						for (let j = 0; j < fileChange.diffHunks[i].diffLines.length; j++) {
							let diffLine = fileChange.diffHunks[i].diffLines[j];
							if (diffLine.type === DiffChangeType.Add) {
								right.push(diffLine.text);
							} else if (diffLine.type === DiffChangeType.Delete) {
								// nothing
							} else if (diffLine.type === DiffChangeType.Control) {
								// nothing
							} else {
								right.push(diffLine.text);
							}
						}
					}

					return right.join('\n');
				}
			} else {
				const originalFileName = fileChange.status === GitChangeType.RENAME ? fileChange.previousFileName : fileChange.fileName;
				const originalFilePath = path.join(this._prManager.repository.rootUri.fsPath, originalFileName!);
				const originalContent = await this._prManager.repository.show(params.baseCommit, originalFilePath);

				if (params.isBase) {
					return originalContent;
				} else {
					return getModifiedContentFromDiffHunk(originalContent, fileChange.patch);
				}
			}
		}
		Logger.appendLine(`PR> can not find content for document ${uri.toString()}`);
		return '';
	}

	// #endregion

	// #region comment
	public async createOrReplyComment(thread: vscode.CommentThread) {
		if (await this._prManager.authenticate() && this.commentController!.inputBox !== undefined) {
			if (thread.comments.length) {
				let comment = thread.comments[0] as (vscode.Comment & { _rawComment: Comment });
				const rawComment = await this._prManager.createCommentReply(this.pullRequestModel, this.commentController!.inputBox!.value, comment._rawComment);

				const fileChange = this.findMatchingFileNode(thread.resource);
				fileChange.comments.push(rawComment!);

				const vscodeComment = convertToVSCodeComment(rawComment!, undefined);
				updateCommentCommands(vscodeComment, this.commentController!, thread, this.pullRequestModel, this);
				this.updateCommentThreadComments(thread, [...thread.comments, vscodeComment]);
				this.commentController!.inputBox!.value = '';
			} else {
				// create new comment thread
				let input = this.commentController!.inputBox!.value;
				await this.updateCommentThreadRoot(thread, input);
				this.commentController!.inputBox!.value = '';
			}
		}
	}

	public async editComment(thread: vscode.CommentThread, comment: vscode.Comment): Promise<void> {
		if (await this._prManager.authenticate() && this._commentController!.inputBox) {
			const fileChange = this.findMatchingFileNode(thread.resource);
			const existingComment = (comment as (vscode.Comment & { _rawComment: Comment }))._rawComment;
			if (!existingComment) {
				throw new Error('Unable to find comment');
			}

			const rawComment = await this._prManager.editReviewComment(this.pullRequestModel, existingComment, this._commentController!.inputBox!.value);

			const index = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
			if (index > -1) {
				fileChange.comments.splice(index, 1, rawComment);
			}

			const vscodeComment = convertToVSCodeComment(rawComment, undefined);
			updateCommentCommands(vscodeComment, this.commentController!, thread, this.pullRequestModel, this);
			const vscodeCommentIndex = thread.comments.findIndex(c => c.commentId === vscodeComment.commentId);
			thread.comments.splice(vscodeCommentIndex, 1, vscodeComment);
			this.updateCommentThreadComments(thread, thread.comments);
		}
	}

	public async deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): Promise<void> {
		await this._prManager.deleteReviewComment(this.pullRequestModel, comment.commentId);
		const fileChange = this.findMatchingFileNode(thread.resource);
		let index = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
		if (index > -1) {
			fileChange.comments.splice(index, 1);
		}

		index = thread.comments.findIndex(c => c.commentId === comment.commentId);
		if (index > -1) {
			if (thread.comments.length === 1) {
				let rawComment = (comment as vscode.Comment & { _rawComment: Comment })._rawComment;

				if (rawComment.path) {
					let threadIndex = this._prDocumentCommentProvider!.commentThreadCache[rawComment.path].findIndex(cachedThread => cachedThread.threadId === thread.threadId);
					this._prDocumentCommentProvider!.commentThreadCache[rawComment.path].splice(threadIndex, 1);
				}

				thread.dispose!();
			} else {
				thread.comments.splice(index, 1);
				this.updateCommentThreadComments(thread, thread.comments);
			}
		}

		let inDraftMode = await this._prManager.inDraftMode(this.pullRequestModel);
		if (inDraftMode !== this.pullRequestModel.inDraftMode) {
			this.pullRequestModel.inDraftMode = inDraftMode;
		}
	}
	// #endregion

	// #region Review
	public async startReview(thread: vscode.CommentThread): Promise<void> {
		await this._prManager.startReview(this.pullRequestModel);

		if (thread.comments.length) {
			let comment = thread.comments[0] as (vscode.Comment & { _rawComment: Comment });
			const rawComment = await this._prManager.createCommentReply(this.pullRequestModel, this.commentController!.inputBox ? this.commentController!.inputBox!.value : '', comment._rawComment);

			const fileChange = this.findMatchingFileNode(thread.resource);
			const index = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
			if (index > -1) {
				fileChange.comments.push(rawComment!);
			}

			const vscodeComment = convertToVSCodeComment(rawComment!, undefined);
			updateCommentCommands(vscodeComment, this.commentController!, thread, this.pullRequestModel, this);
			this.updateCommentThreadComments(thread, [...thread.comments, vscodeComment]);
		} else {
			// create new comment thread

			if (this.commentController!.inputBox && this.commentController!.inputBox!.value) {
				await this.updateCommentThreadRoot(thread, this.commentController!.inputBox!.value);
			}
		}

		if (this.commentController!.inputBox) {
			this.commentController!.inputBox!.value = '';
		}
	}

	public async finishReview(thread: vscode.CommentThread): Promise<void> {
		try {
			if (this.commentController && this.commentController.inputBox && this.commentController.inputBox && this.commentController.inputBox.value) {
				let comment = thread.comments[0] as (vscode.Comment & { _rawComment: Comment });
				const rawComment = await this._prManager.createCommentReply(this.pullRequestModel, this.commentController!.inputBox!.value, comment._rawComment);

				const fileChange = this.findMatchingFileNode(thread.resource);
				const index = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
				if (index > -1) {
					fileChange.comments.push(rawComment!);
				}

				const vscodeComment = convertToVSCodeComment(rawComment!, undefined);
				updateCommentCommands(vscodeComment, this.commentController!, thread, this.pullRequestModel, this);
				this.updateCommentThreadComments(thread, [...thread.comments, vscodeComment]);
				this.commentController!.inputBox!.value = '';
			}

			await this._prManager.submitReview(this.pullRequestModel);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to submit the review: ${e}`);
		}
	}

	public async deleteReview(): Promise<void> {
		const { deletedReviewId, deletedReviewComments } = await this._prManager.deleteReview(this.pullRequestModel);

		// Group comments by file and then position to create threads.
		const commentsByPath = groupBy(deletedReviewComments, comment => comment.path || '');

		for (let filePath in commentsByPath) {
			const matchingFileChange = this._fileChanges.find(fileChange => fileChange.fileName === filePath);

			if (matchingFileChange && matchingFileChange instanceof InMemFileChangeNode) {
				matchingFileChange.comments = matchingFileChange.comments.filter(comment => comment.pullRequestReviewId !== deletedReviewId);
				if (this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName]) {
					let threads: vscode.CommentThread[] = [];

					this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName].forEach(thread => {
						this.updateCommentThreadComments(thread, thread.comments.filter(comment => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId)));
						if (!thread.comments.length) {
							thread.dispose!();
						} else {
							threads.push(thread);
						}
					});

					if (threads.length) {
						this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName] = threads;
					} else {
						delete this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName];
					}
				}
			}
		}
	}

	// #endregion

	// #region Reaction
	async toggleReaction(document: vscode.TextDocument, comment: vscode.Comment, reaction: vscode.CommentReaction): Promise<void> {
		if (document.uri.scheme !== 'pr') {
			return;
		}

		const params = fromPRUri(document.uri);

		if (!params) {
			return;
		}

		const fileChange = this.findMatchingFileNode(document.uri);
		const commentIndex = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);

		if (commentIndex < 0) {
			return;
		}

		if (comment.commentReactions && !comment.commentReactions.find(ret => ret.label === reaction.label && !!ret.hasReacted)) {
			// add reaction
			const matchedRawComment = (comment as (vscode.Comment & { _rawComment: Comment }))._rawComment;
			let result = await this._prManager.addCommentReaction(this.pullRequestModel, matchedRawComment.graphNodeId, reaction);
			let reactionGroups = result.addReaction.subject.reactionGroups;
			fileChange.comments[commentIndex].reactions = parseGraphQLReaction(reactionGroups);
			updateCommentReactions(comment, fileChange.comments[commentIndex].reactions!);
		} else {
			const matchedRawComment = (comment as (vscode.Comment & { _rawComment: Comment }))._rawComment;
			let result = await this._prManager.deleteCommentReaction(this.pullRequestModel, matchedRawComment.graphNodeId, reaction);
			let reactionGroups = result.removeReaction.subject.reactionGroups;
			fileChange.comments[commentIndex].reactions = parseGraphQLReaction(reactionGroups);
			updateCommentReactions(comment, fileChange.comments[commentIndex].reactions!);
		}

		if (this._prDocumentCommentProvider!.commentThreadCache[params.fileName]) {
			this._prDocumentCommentProvider!.commentThreadCache[params.fileName].forEach(thread => {
				if (!thread.comments) {
					return;
				}

				if (thread.comments.find(cmt => cmt.commentId === comment.commentId)) {
					this.updateCommentThreadComments(thread, thread.comments);
				}
			});
		}
	}

	// #endregion

	dispose(): void {
		super.dispose();

		if (this._inMemPRContentProvider) {
			this._inMemPRContentProvider.dispose();
		}

		if (this._prDocumentCommentProvider) {
			this._prDocumentCommentProvider.dispose();
		}

		this._commentController = undefined;

		this._disposables.forEach(d => d.dispose());
	}
}
