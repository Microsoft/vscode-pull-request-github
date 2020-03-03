/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitFileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';
import { DirectoryTreeNode } from './directoryTreeNode';

export class FilesCategoryNode extends TreeNode implements vscode.TreeItem {
	public label: string = 'Files';
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public contextValue?: string;
	public directories: TreeNode[] = [];

	constructor(public parent: TreeNode | vscode.TreeView<TreeNode>, private _fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[]) {
		super();
		this.contextValue = 'files';
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;

		// tree view
		const dirNode = new DirectoryTreeNode(this, '');
		this._fileChanges.forEach(f => dirNode.addFile(f));
		dirNode.finalize();
		if (dirNode.label === '') {
			// nothing on the root changed, pull children to parent
			this.directories = dirNode.children;
		} else {
			this.directories = [dirNode];
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		let nodes: TreeNode[];
		const layout = vscode.workspace.getConfiguration('githubPullRequests').get<string>('fileListLayout');
		if (layout === 'tree') {
			nodes = this.directories;
		} else {
			nodes = this._fileChanges;
		}
		return Promise.resolve(nodes);
	}
}
