/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitHubRef } from '../common/githubRef';
import { Remote } from '../common/remote';
import { GitHubRepository } from './githubRepository';
import { IAccount, ILabel, PullRequest, PullRequestStateEnum } from './interface';

export class PullRequestModel {
	public prNumber: number;
	public title: string;
	public html_url: string;
	public state: PullRequestStateEnum = PullRequestStateEnum.Open;
	public author: IAccount;
	public assignee: IAccount;
	public createdAt: string;
	public updatedAt: string;
	public localBranchName?: string;
	public labels: ILabel[];
	public mergeBase?: string;

	public get isOpen(): boolean {
		return this.state === PullRequestStateEnum.Open;
	}
	public get isMerged(): boolean {
		return this.state === PullRequestStateEnum.Merged;
	}

	public get userAvatar(): string {
		if (this.prItem) {
			return this.prItem.user.avatarUrl;
		}

		return '';
	}
	public get userAvatarUri(): vscode.Uri | undefined {
		if (this.prItem) {
			let key = this.userAvatar;
			let gravatar = vscode.Uri.parse(`${key}&s=${64}`);

			// hack, to ensure queries are not wrongly encoded.
			const originalToStringFn = gravatar.toString;
			gravatar.toString = function (skipEncoding?: boolean | undefined) {
				return originalToStringFn.call(gravatar, true);
			};

			return gravatar;
		}

		return undefined;
	}

	public get body(): string {
		if (this.prItem) {
			return this.prItem.body;
		}
		return '';
	}

	public bodyHTML?: string;

	public head: GitHubRef;
	public base: GitHubRef;

	constructor(public readonly githubRepository: GitHubRepository, public readonly remote: Remote, public prItem: PullRequest) {
		this.update(prItem);
	}

	update(prItem: PullRequest): void {
		this.prNumber = prItem.number;
		this.title = prItem.title;
		this.bodyHTML = prItem.bodyHTML;
		this.html_url = prItem.url;
		this.author = prItem.user;
		this.labels = (prItem.labels || []);

		if (prItem.state.toLowerCase() === 'open') {
			this.state = PullRequestStateEnum.Open;
		} else {
			this.state = prItem.merged ? PullRequestStateEnum.Merged : PullRequestStateEnum.Closed;
		}

		if (prItem.assignee) {
			this.assignee = prItem.assignee;
		}

		this.createdAt = prItem.createdAt;
		this.updatedAt = prItem.updatedAt ? prItem.updatedAt : this.createdAt;

		this.head = new GitHubRef(prItem.head!.ref, prItem.head!.label, prItem.head!.sha, prItem.head!.repo.cloneUrl);
		this.base = new GitHubRef(prItem.base!.ref, prItem.base!.label, prItem.base!.sha, prItem.base!.repo.cloneUrl);
	}

	equals(other: PullRequestModel | undefined): boolean {
		if (!other) {
			return false;
		}

		if (this.prNumber !== other.prNumber) {
			return false;
		}

		if (this.html_url !== other.html_url) {
			return false;
		}

		return true;
	}
}
