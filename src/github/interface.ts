/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export enum PRType {
	RequestReview = 0,
	AssignedToMe = 1,
	Mine = 2,
	Mention = 3,
	All = 4,
	LocalPullRequest = 5
}

export enum ReviewEvent {
	Approve = 'APPROVE',
	RequestChanges = 'REQUEST_CHANGES',
	Comment = 'COMMENT'
}

export enum PullRequestStateEnum {
	Open,
	Merged,
	Closed,
}

export interface ReviewState {
	reviewer: IAccount;
	state: 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING' | 'REQUESTED';
}

export interface IAccount {
	login: string;
	name?: string;
	avatarUrl: string;
	url: string;
}

export interface MergePullRequest {
	sha: string;
	merged: boolean;
	message: string;
	documentation_url: string;
}

export interface IRepository {
	cloneUrl: string;
}

export interface IGitHubRef {
	label: string;
	ref: string;
	sha: string;
	repo: IRepository;
}

export interface ILabel {
	name: string;
	color: string;
}

export interface PullRequest {
	url: string;
	number: number;
	state: string;
	body: string;
	bodyHTML?: string;
	title: string;
	assignee?: IAccount;
	createdAt: string;
	updatedAt: string;
	head?: IGitHubRef;
	base?: IGitHubRef;
	user: IAccount;
	labels?: ILabel[];
	reviewRequests: IAccount[];
	merged: boolean;
	mergeable?: boolean;
	nodeId: string;
}

export interface IRawFileChange {
	filename: string;
	previous_filename?: string;
	additions: number;
	deletions: number;
	changes: number;
	status: string;
	raw_url: string;
	blob_url: string;
	patch: string;
}

export interface IPullRequestsPagingOptions {
	fetchNextPage: boolean;
}

export interface IGitHubRepository {
	authenticate(): Promise<boolean>;
}

export interface IPullRequestEditData {
	body?: string;
	title?: string;
}

export interface ITelemetry {
	on(action: 'startup'): Promise<void>;
	on(action: 'authSuccess'): Promise<void>;
	on(action: 'commentsFromEditor'): Promise<void>;
	on(action: 'commentsFromDescription'): Promise<void>;
	on(action: 'prListExpandLocalPullRequest'): Promise<void>;
	on(action: 'prListExpandRequestReview'): Promise<void>;
	on(action: 'prListExpandAssignedToMe'): Promise<void>;
	on(action: 'prListExpandMine'): Promise<void>;
	on(action: 'prListExpandAll'): Promise<void>;
	on(action: 'prCheckoutFromContext'): Promise<void>;
	on(action: 'prCheckoutFromDescription'): Promise<void>;
	on(action: string): Promise<void>;

	shutdown(): Promise<void>;
}
