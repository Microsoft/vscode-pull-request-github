/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PRType, ITelemetry } from '../../github/interface';
import { PRNode } from './pullRequestNode';
import { TreeNode } from './treeNode';
import { formatError } from '../../common/utils';
import { AuthenticationError } from '../../common/authentication';
import { PullRequestManager } from '../../github/pullRequestManager';
import { PullRequestModel } from '../../github/pullRequestModel';

export enum PRCategoryActionType {
	Empty,
	More,
	TryOtherRemotes,
	Login
}

export class PRCategoryActionNode extends TreeNode implements vscode.TreeItem {
	public readonly label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };
	public type: PRCategoryActionType;
	public command?: vscode.Command;

	constructor(parent: TreeNode | vscode.TreeView<TreeNode>, type: PRCategoryActionType, node?: CategoryTreeNode) {
		super();
		this.parent = parent;
		this.type = type;
		this.collapsibleState = vscode.TreeItemCollapsibleState.None;
		switch (type) {
			case PRCategoryActionType.Empty:
				this.label = '0 pull requests in this category';
				break;
			case PRCategoryActionType.More:
				this.label = 'Load more';
				this.command = {
					title: 'Load more',
					command: 'pr.loadMore',
					arguments: [
						node
					]
				};
				break;
			case PRCategoryActionType.TryOtherRemotes:
				this.label = 'Continue fetching from other remotes';
				this.command = {
					title: 'Load more',
					command: 'pr.loadMore',
					arguments: [
						node
					]
				};
				break;
			case PRCategoryActionType.Login:
				this.label = 'Sign in';
				this.command = {
					title: 'Sign in',
					command: 'pr.signinAndRefreshList',
					arguments: []
				};
				break;
			default:
				break;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}

export class CategoryTreeNode extends TreeNode implements vscode.TreeItem {
	public readonly label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public prs: PullRequestModel[];
	public fetchNextPage: boolean = false;

	constructor(
		public parent: TreeNode | vscode.TreeView<TreeNode>,
		private _prManager: PullRequestManager,
		private _telemetry: ITelemetry,
		private _type: PRType
	) {
		super();

		this.prs = [];
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		switch (_type) {
			case PRType.All:
				this.label = 'All';
				break;
			case PRType.RequestReview:
				this.label = 'Waiting For My Review';
				break;
			case PRType.AssignedToMe:
				this.label = 'Assigned To Me';
				break;
			case PRType.Mine:
				this.label = 'Created By Me';
				break;
			case PRType.LocalPullRequest:
				this.label = 'Local Pull Request Branches';
				break;
			default:
				break;
		}
	}

	async getChildren(): Promise<TreeNode[]> {
		let hasMorePages = false;
		let hasUnsearchedRepositories = false;
		let needLogin = false;
		if (this._type === PRType.LocalPullRequest) {
			try {
				this.prs = await this._prManager.getLocalPullRequests();
				this._telemetry.on('prList.expand.local');
			} catch (e) {
				vscode.window.showErrorMessage(`Fetching local pull requests failed: ${formatError(e)}`);
				needLogin = e instanceof AuthenticationError;
			}
		} else {
			if (!this.fetchNextPage) {
				try {
					const response = await this._prManager.getPullRequests(this._type, { fetchNextPage: false });
					this.prs = response.pullRequests;
					hasMorePages = response.hasMorePages;
					hasUnsearchedRepositories = response.hasUnsearchedRepositories;

					switch (this._type) {
						case PRType.All:
							this._telemetry.on('prList.expand.all');
							break;
						case PRType.AssignedToMe:
							this._telemetry.on('prList.expand.assignedToMe');
							break;
						case PRType.RequestReview:
							this._telemetry.on('prList.expand.requestReview');
							break;
						case PRType.Mine:
							this._telemetry.on('prList.expand.mine');
							break;
					}

				} catch (e) {
					vscode.window.showErrorMessage(`Fetching pull requests failed: ${formatError(e)}`);
					needLogin = e instanceof AuthenticationError;
				}
			} else {
				try {
					const response = await this._prManager.getPullRequests(this._type, { fetchNextPage: true });
					this.prs = this.prs.concat(response.pullRequests);
					hasMorePages = response.hasMorePages;
					hasUnsearchedRepositories = response.hasUnsearchedRepositories;
				} catch (e) {
					vscode.window.showErrorMessage(`Fetching pull requests failed: ${formatError(e)}`);
					needLogin = e instanceof AuthenticationError;
				}

				this.fetchNextPage = false;
			}
		}

		if (this.prs) {
			let nodes: TreeNode[] = this.prs.map(prItem => new PRNode(this, this._prManager, prItem, this._type === PRType.LocalPullRequest));
			if (hasMorePages) {
				nodes.push(new PRCategoryActionNode(this, PRCategoryActionType.More, this));
			} else if (hasUnsearchedRepositories) {
				nodes.push(new PRCategoryActionNode(this, PRCategoryActionType.TryOtherRemotes, this));
			} else if(this.prs.length === 0) {
				nodes.push(new PRCategoryActionNode(this, PRCategoryActionType.Empty, this));
			}

			this.childrenDisposables = nodes;
			return nodes;
		} else {
			let category = needLogin ? PRCategoryActionType.Login : PRCategoryActionType.Empty;
			let result = [new PRCategoryActionNode(this, category)];

			this.childrenDisposables = result;
			return result;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}
