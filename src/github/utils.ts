/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as Octokit from '@octokit/rest';
import { IAccount, PullRequest } from './interface';
import { Comment } from '../common/comment';
import { parseDiffHunk, DiffHunk } from '../common/diffHunk';
import { EventType, TimelineEvent } from '../common/timelineEvent';

export function convertRESTUserToAccount(user: Octokit.PullRequestsGetAllResponseItemUser): IAccount {
	return {
		login: user.login,
		url: user.html_url,
		avatarUrl: user.avatar_url,
		type: user.type,
		isUser: user.type === 'User',
		isEnterprise: user.type === 'Enterprise'
	};
}

export function convertRESTHeadToIGitHubRef(head: Octokit.PullRequestsGetResponseHead) {
	return {
		label: head.label,
		ref: head.ref,
		sha: head.sha,
		repo: { cloneUrl: head.repo.clone_url }
	};
}

export function convertRESTPullRequestToRawPullRequest(pullRequest: Octokit.PullRequestsCreateResponse | Octokit.PullRequestsGetResponse | Octokit.PullRequestsGetAllResponseItem): PullRequest {
	let {
		number,
		body,
		title,
		html_url,
		user,
		state,
		assignee,
		created_at,
		updated_at,
		head,
		base,
		labels,
		node_id
	} = pullRequest;

	const item: PullRequest = {
			number,
			body,
			title,
			url: html_url,
			user: convertRESTUserToAccount(user),
			state,
			merged: (pullRequest as Octokit.PullRequestsGetResponse).merged || false,
			assignee: assignee ? convertRESTUserToAccount(assignee) : null,
			createdAt: created_at,
			updatedAt: updated_at,
			head: convertRESTHeadToIGitHubRef(head),
			base: convertRESTHeadToIGitHubRef(base),
			labels,
			mergeable: (pullRequest as Octokit.PullRequestsGetResponse).mergeable,
			nodeId: node_id
	};

	return item;
}

export function parseCommentDiffHunk(comment: Comment): DiffHunk[] {
	let diffHunks = [];
	let diffHunkReader = parseDiffHunk(comment.diffHunk);
	let diffHunkIter = diffHunkReader.next();

	while (!diffHunkIter.done) {
		let diffHunk = diffHunkIter.value;
		diffHunks.push(diffHunk);
		diffHunkIter = diffHunkReader.next();
	}

	return diffHunks;
}

export function convertIssuesCreateCommentResponseToComment(comment: Octokit.IssuesCreateCommentResponse | Octokit.IssuesEditCommentResponse): Comment {
	return {
		url: comment.url,
		id: comment.id,
		diffHunk: '',
		diffHunks: [],
		path: null,
		position: null,
		commitId: null,
		originalPosition: null,
		originalCommitId: null,
		user: convertRESTUserToAccount(comment.user),
		body: comment.body,
		createdAt: comment.created_at,
		htmlUrl: comment.html_url
	};
}

export function convertPullRequestsGetCommentsResponseItemToComment(comment: Octokit.PullRequestsGetCommentsResponseItem | Octokit.PullRequestsEditCommentResponse): Comment {
	let ret: Comment = {
		url: comment.url,
		id: comment.id,
		pullRequestReviewId: comment.pull_request_review_id,
		diffHunk: comment.diff_hunk,
		path: comment.path,
		position: comment.position,
		commitId: comment.commit_id,
		originalPosition: comment.original_position,
		originalCommitId: comment.original_commit_id,
		user: convertRESTUserToAccount(comment.user),
		body: comment.body,
		createdAt: comment.created_at,
		htmlUrl: comment.html_url,
		nodeId: comment.node_id
	};

	let diffHunks = parseCommentDiffHunk(ret);
	ret.diffHunks = diffHunks;
	return ret;
}

export function convertGraphQLEventType(text: string) {
	switch (text) {
		case 'Commit':
			return EventType.Committed;
		case 'LabeledEvent':
			return EventType.Labeled;
		case 'MilestonedEvent':
			return EventType.Milestoned;
		case 'AssignedEvent':
			return EventType.Assigned;
		case 'IssueComment':
			return EventType.Commented;
		case 'PullRequestReview':
			return EventType.Reviewed;
		case 'MergedEvent':
			return EventType.Merged;

		default:
			return EventType.Other;
	}
}

export function parseGraphQLComment(comment: any): Comment {
	comment.canEdit = comment.viewerCanUpdate;
	comment.canDelete = comment.viewerCanDelete;
	comment.user = comment.author;
	comment.id = comment.databaseId;
	comment.htmlUrl = comment.url;
	comment.commitId = comment.commit && comment.commit.oid;
	comment.pullRequestReviewId = comment.pullRequestReview && comment.pullRequestReview.databaseId;
	comment.isDraft = comment.state === 'PENDING';

	let diffHunks = parseCommentDiffHunk(comment);
	comment.diffHunks = diffHunks;

	return comment;
}

export function parseGraphQLTimelineEvents(events: any[]): TimelineEvent[] {
	events.forEach(event => {
		let type = convertGraphQLEventType(event.__typename);
		event.event = type;

		if (event.event === EventType.Commented) {
			event.canEdit = event.viewerCanUpdate;
			event.canDelete = event.viewerCanDelete;
			event.user = event.author;
			event.id = event.databaseId;
			event.htmlUrl = event.url;
		}

		if (event.event === EventType.Reviewed) {
			event.user = event.author;
			event.canEdit = event.viewerCanUpdate;
			event.canDelete = event.viewerCanDelete;
			event.id = event.databaseId;
			event.htmlUrl = event.url;
			event.submittedAt = event.submittedAt;
		}

		if (event.event === EventType.Committed) {
			event.sha = event.oid;
			event.author = event.author.user || { login: event.committer.name, avatarUrl: event.committer.avatarUrl };
			event.htmlUrl = event.url;
		}
	});

	return events;
}

export function convertRESTTimelineEvents(events: any[]): TimelineEvent[] {
	events.forEach(event => {
		if (event.event === EventType.Commented) {

		}

		if (event.event === EventType.Reviewed) {
			event.submittedAt = event.submitted_at;
			event.htmlUrl = event.html_url;
		}

		if (event.event === EventType.Committed) {
			event.htmlUrl = event.html_url;
		}
	});

	return events;
}