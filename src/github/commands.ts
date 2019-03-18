/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PRNode } from '../view/treeNodes/pullRequestNode';
import { ReviewDocumentCommentProvider } from '../view/reviewDocumentCommentProvider';
import { CommentHandler } from './utils';

export function getAcceptInputCommands(thread: vscode.CommentThread, inDraftMode: boolean, handler: CommentHandler, supportGraphQL: boolean): { acceptInputCommand: vscode.Command, additionalCommands: vscode.Command[] } {
	let commands: vscode.Command[] = [];
	let acceptInputCommand = {
		title: inDraftMode ? 'Add Review Comment' : 'Add Comment',
		command: 'pr.replyComment',
		arguments: [
			handler,
			thread
		]
	};

	if (supportGraphQL) {
		if (inDraftMode) {
			commands.push({
				title: 'Delete Review',
				command: 'pr.deleteReview',
				arguments: [
					handler
				]
			});

			commands.push({
				title: 'Finish Review',
				command: 'pr.finishReview',
				arguments: [
					handler,
					thread
				]
			});
		} else {
			commands.push({
				title: 'Start Review',
				command: 'pr.startReview',
				arguments: [
					handler,
					thread
				]
			});
		}
	}

	return {
		acceptInputCommand: acceptInputCommand,
		additionalCommands: commands
	};
}

export function getEditCommand(thread: vscode.CommentThread, vscodeComment: vscode.Comment, handler: PRNode | ReviewDocumentCommentProvider): vscode.Command {
	return {
		title: 'Edit Comment',
		command: 'pr.editComment',
		arguments: [
			handler,
			thread,
			vscodeComment
		]
	};
}

export function getDeleteCommand(thread: vscode.CommentThread, vscodeComment: vscode.Comment, handler: PRNode | ReviewDocumentCommentProvider): vscode.Command {
	return {
		title: 'Delete Comment',
		command: 'pr.deleteComment',
		arguments: [
			handler,
			thread,
			vscodeComment
		]
	};
}

export function getDeleteThreadCommand(thread: vscode.CommentThread): vscode.Command {
	return {
		title: 'Delete Thread',
		command: 'pr.deleteThread',
		arguments: [
			thread
		]
	};
}