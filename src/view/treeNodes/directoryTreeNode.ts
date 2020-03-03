/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TreeNode } from './treeNode';
import { RemoteFileChangeNode, InMemFileChangeNode, GitFileChangeNode } from './fileChangeNode';

export class DirectoryTreeNode extends TreeNode implements vscode.TreeItem {
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public children: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode | DirectoryTreeNode)[] =  new Array();
	private pathToChild: Map<string, DirectoryTreeNode> = new Map();
	public contextValue?: string;

	constructor(
		public parent: TreeNode | vscode.TreeView<TreeNode>,
		public label: string,
	) {
		super();
		this.contextValue = 'directory';
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
	}

	async getChildren(): Promise<TreeNode[]> {
		return this.children;
	}

	public finalize(): void {
		this.trimTree();
		this.sort();
	}

	private trimTree(): void {
		if (this.children.length === 0) {
			return;
		}

		this.children.forEach(n => {
			if (n instanceof DirectoryTreeNode) {
				n.trimTree(); // reccursive
			}
		});

		// merge if this only have single directory, eg:
		// - a
		//   - b
		//     - c
		// becomes:
		// - a/b
		//   - c
		if (this.children.length !== 1) {
			return;
		}
		const child = this.children[0];
		if (!(child instanceof DirectoryTreeNode)) {
			return;
		}

		// perform the merge
		this.label = this.label + '/' + child.label;
		if (this.label.startsWith('/')) {
			this.label = this.label.substr(1);
		}
		this.children = child.children;
	}

	private sort(): void {
		if (this.children.length <= 1) {
			return;
		}

		const dirs: DirectoryTreeNode[] = [];
		const files: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode)[] = [];

		// process directory
		this.children.forEach(node => {
			if (node instanceof DirectoryTreeNode) {
				node.sort(); // recc
				dirs.push(node);
			} else {
				// files
				files.push(node);
			}
		});

		// sort
		dirs.sort((a, b) => (a.label < b.label) ? -1 : 1);
		files.sort((a, b) => (a.label < b.label) ? -1 : 1);

		this.children = [...dirs, ...files];
	}

	public addFile(file: GitFileChangeNode | RemoteFileChangeNode | InMemFileChangeNode): void {
		const paths = file.fileName.split('/');
		file.description = '';

		this.addPathRecc(paths, file);
	}

	private addPathRecc(paths: string[], file: GitFileChangeNode | RemoteFileChangeNode | InMemFileChangeNode): void {
		if (paths.length <= 0) {
			return;
		}

		if (paths.length === 1) {
			this.children.push(file);
			return;
		}

		const dir = paths[0]; // top directory
		const tail = paths.slice(1); // rest

		let node = this.pathToChild.get(dir);
		if (!node) {
			node = new DirectoryTreeNode(this, dir);
			this.pathToChild.set(dir, node);
			this.children.push(node);
		}

		node.addPathRecc(tail, file);
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}
