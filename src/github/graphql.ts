/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAccount } from './interface';

export interface MergedEvent {
	__typename: string;
	id: string;
	actor: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	createdAt: string;
	mergeRef: {
		name: string;
	};
	commit: {
		oid: string;
		commitUrl: string;
	};
	url: string;
}

export interface IssueComment {
	__typename: string;
	id: string;
	databaseId: number;
	authorAssocation: string;
	author: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	url: string;
	body: string;
	bodyHTML: string;
	updatedAt: string;
	createdAt: string;
	viewerCanUpdate: boolean;
	viewerCanReact: boolean;
	viewerCanDelete: boolean;
}

export interface ReactionGroup {
	content: string;
	viewerHasReacted: boolean;
	users: {
		totalCount: number;
	};
}

export interface ReviewComment {
	__typename: string;
	id: string;
	databaseId: number;
	url: string;
	author?: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	path: string;
	originalPosition: number;
	body: string;
	bodyHTML: string;
	diffHunk: string;
	position: number;
	state: string;
	pullRequestReview: {
		databaseId: number;
	};
	commit: {
		oid: string;
	};
	originalCommit: {
		oid: string;
	};
	createdAt: string;
	replyTo: {
		databaseId: number;
	};
	reactionGroups: ReactionGroup[];
	viewerCanUpdate: boolean;
	viewerCanDelete: boolean;
}

export interface Commit {
	__typename: string;
	id: string;
	author: {
		user: {
			login: string;
			avatarUrl: string;
			url: string;
		}
	};
	committer: {
		avatarUrl: string;
		name: string;
	};
	url: string;
	oid: string;
	message: string;
}

export interface AssignedEvent {
	__typename: string;
	actor: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	user: {
		login: string;
		avatarUrl: string;
		url: string;
	};
}

export interface Review {
	__typename: string;
	id: string;
	databaseId: number;
	authorAssociation: string;
	url: string;
	author: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	state: 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING';
	body: string;
	bodyHTML?: string;
	submittedAt: string;
	updatedAt: string;
	createdAt: string;
}

export interface TimelineEventsResponse {
	repository: {
		pullRequest: {
			timeline: {
				edges: [
					{
						node: (MergedEvent | Review | IssueComment | Commit | AssignedEvent)[];
					}
				]
			}
		}
	};
	rateLimit: RateLimit;
}

export interface PendingReviewIdResponse {
	node: {
		reviews: {
			nodes: Review[];
		}
	};
	rateLimit: RateLimit;
}

export interface PullRequestCommentsResponse {
	repository: {
		pullRequest: {
			reviews: {
				nodes: [
					{
						comments: {
							nodes: ReviewComment[];
						}
					}
				]
			}
		}
	};
	rateLimit: RateLimit;
}

export interface MentionableUsersResponse {
	repository: {
		mentionableUsers: {
			nodes: [
				{
					login: string;
					avatarUrl: string;
					name: string;
					url: string;
				}
			];
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string;
			};
		}
	};
	rateLimit: RateLimit;
}

export interface AddCommentResponse {
	addPullRequestReviewComment: {
		comment: ReviewComment;
	};
}

export interface EditCommentResponse {
	updatePullRequestReviewComment: {
		pullRequestReviewComment: ReviewComment;
	};
}

export interface SubmittedReview extends Review {
	comments: {
		nodes: ReviewComment[];
	};
}

export interface SubmitReviewResponse {
	submitPullRequestReview: {
		pullRequestReview: SubmittedReview;
	};
}

export interface DeleteReviewResponse {
	deletePullRequestReview: {
		pullRequestReview: {
			databaseId: number;
			comments: {
				nodes: ReviewComment[];
			}
		}
	};
}

export interface AddReactionResponse {
	addReaction: {
		reaction: {
			content: string;
		}
		subject: {
			reactionGroups: ReactionGroup[];
		}
	};
}

export interface DeleteReactionResponse {
	removeReaction: {
		reaction: {
			content: string;
		}
		subject: {
			reactionGroups: ReactionGroup[];
		}
	};
}

export interface Ref {
	name: string;
	repository: {
		owner: {
			login: string;
		}
		url: string;
	};
	target: {
		oid: string;
	};
}

export interface PullRequestResponse {
	repository: {
		pullRequest: {
			number: number;
			url: string;
			state: 'OPEN' | 'CLOSED' | 'MERGED';
			body: string;
			bodyHTML: string;
			title: string;
			author: {
				login: string;
				url: string;
				avatarUrl: string;
			}
			createdAt: string;
			updatedAt: string;
			headRef?: Ref;
			baseRef?: Ref;
			labels: {
				nodes: [
					{
						name: string;
					}
				]
			}
			merged: boolean;
			mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
			id: string;
		}
	};
	rateLimit: RateLimit;
}

export interface QueryWithRateLimit {
	rateLimit: RateLimit;
}
export interface RateLimit {
	limit: number;
	cost: number;
	remaining: number;
	resetAt: string;
}

export interface PullRequestListItem {
	nodeId: string;
	number: number;
	title: string;
	url: string;
	author: IAccount;
	state: string;
	assignees: {
		nodes: IAccount[];
	};
	createdAt: string;
	updatedAt: string;
	merged: boolean;
	headRef: Ref;
	baseRef: Ref;
}

export interface PullRequestListResponse {
	search: {
		nodes: PullRequestListItem[];
		pageInfo: {
			hasNextPage: boolean;
			endCursor: string;
		};
	};
}