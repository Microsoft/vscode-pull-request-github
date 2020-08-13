/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { StateManager, MilestoneItem, IssueItem } from './stateManager';
import { Resource } from '../common/resources';
import { issueMarkdown } from './util';
import { RepositoriesManager } from '../github/repositoriesManager';
import { ReposManagerState, FolderRepositoryManager } from '../github/folderRepositoryManager';
import { IssueModel } from '../github/issueModel';

class UriTreeItem extends vscode.TreeItem2 {
	constructor(public readonly uri: vscode.Uri | undefined, label: string, collapsibleState?: vscode.TreeItemCollapsibleState) {
		super({ label }, collapsibleState);
	}
}

export class IssuesTreeData implements vscode.TreeDataProvider<FolderRepositoryManager | IssueItem | MilestoneItem | UriTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<FolderRepositoryManager | IssueItem | MilestoneItem | null | undefined | void> = new vscode.EventEmitter();
	public onDidChangeTreeData: vscode.Event<FolderRepositoryManager | IssueItem | MilestoneItem | null | undefined | void> = this._onDidChangeTreeData.event;

	constructor(private stateManager: StateManager, private manager: RepositoriesManager, private context: vscode.ExtensionContext) {
		context.subscriptions.push(this.manager.onDidChangeState(() => {
			this._onDidChangeTreeData.fire();
		}));
		context.subscriptions.push(this.stateManager.onDidChangeIssueData(() => {
			this._onDidChangeTreeData.fire();
		}));

		context.subscriptions.push(this.stateManager.onDidChangeCurrentIssue(() => {
			this._onDidChangeTreeData.fire();
		}));
	}

	getTreeItem(element: FolderRepositoryManager | IssueItem | MilestoneItem | UriTreeItem): UriTreeItem {
		let treeItem: UriTreeItem;
		if (element instanceof UriTreeItem) {
			treeItem = element;
		} else if (element instanceof FolderRepositoryManager) {
			treeItem = new UriTreeItem(element.repository.rootUri, path.basename(element.repository.rootUri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
		} else if (!(element instanceof IssueModel)) {
			treeItem = new UriTreeItem(element.uri, element.milestone.title, element.issues.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		} else {
			treeItem = new UriTreeItem(undefined, `${element.number}: ${element.title}`, vscode.TreeItemCollapsibleState.None);
			treeItem.iconPath = {
				light: element.isOpen ? Resource.icons.light.Issues : Resource.icons.light.IssueClosed,
				dark: element.isOpen ? Resource.icons.dark.Issues : Resource.icons.dark.IssueClosed
			};
			if (this.stateManager.currentIssue(element.uri)?.issue.number === element.number) {
				treeItem.label = `✓ ${treeItem.label.label}`;
				treeItem.contextValue = 'currentissue';
			} else {
				const savedState = this.stateManager.getSavedIssueState(element.number);
				if (savedState.branch) {
					treeItem.contextValue = 'continueissue';
				} else {
					treeItem.contextValue = 'issue';
				}
			}
		}
		return treeItem;
	}

	getChildren(element: FolderRepositoryManager | IssueItem | MilestoneItem | UriTreeItem | undefined): FolderRepositoryManager[] | Promise<(IssueItem | MilestoneItem)[]> | IssueItem[] | UriTreeItem[] {
		if ((element === undefined) && (this.manager.state !== ReposManagerState.RepositoriesLoaded)) {
			return this.getStateChildren();
		} else {
			return this.getIssuesChildren(element);
		}
	}

	resolveTreeItem(element: FolderRepositoryManager | IssueItem | MilestoneItem | vscode.TreeItem, item: vscode.TreeItem2): vscode.TreeItem2 {
		if (element instanceof IssueItem) {
			item.tooltip = issueMarkdown(element, this.context);
		}
		return item;
	}

	getStateChildren(): UriTreeItem[] {
		if (this.manager.state === ReposManagerState.NeedsAuthentication) {
			return [];
		} else {
			return [new UriTreeItem(undefined, 'Loading...')];
		}
	}

	getQueryItems(folderManager: FolderRepositoryManager): Promise<(IssueItem | MilestoneItem)[]> | UriTreeItem[] {
		const issueCollection = this.stateManager.getIssueCollection(folderManager.repository.rootUri);
		if (issueCollection.size === 1) {
			return Array.from(issueCollection.values())[0];
		}
		const queryLabels = Array.from(issueCollection.keys());
		const firstLabel = queryLabels[0];
		return queryLabels.map(label => {
			const item = new UriTreeItem(folderManager.repository.rootUri, label);
			item.contextValue = 'query';
			item.collapsibleState = label === firstLabel ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
			return item;
		});
	}

	getIssuesChildren(element: FolderRepositoryManager | IssueItem | MilestoneItem | UriTreeItem | undefined): FolderRepositoryManager[] | Promise<(IssueItem | MilestoneItem)[]> | IssueItem[] | UriTreeItem[] {
		if (element === undefined) {
			// If there's only one query, don't display a title for it
			if (this.manager.folderManagers.length === 1) {
				return this.getQueryItems(this.manager.folderManagers[0]);
			} else if (this.manager.folderManagers.length > 1) {
				return this.manager.folderManagers;
			} else {
				return [];
			}
		} else if (element instanceof FolderRepositoryManager) {
			return this.getQueryItems(element);
		} else if (element instanceof UriTreeItem) {
			return element.uri ? this.stateManager.getIssueCollection(element.uri).get(element.label.label!) ?? [] : [];
		} else if (!(element instanceof IssueModel)) {
			return element.issues.map(item => {
				const issueItem: IssueItem = Object.assign(item);
				issueItem.uri = element.uri;
				return issueItem;
			});
		} else {
			return [];
		}
	}

}
