import { Uri } from 'vscode';

import {
	Repository,
	RepositoryState,
	RepositoryUIState,
	Commit,
	Change,
	Branch,
	RefType,
	CommitOptions,
	InputBox,
	Ref,
	BranchQuery,
	FetchOptions,
	PullOptions,
} from '../../api/api';

type Mutable<T> = {
	-readonly [P in keyof T]: T[P];
};

export class MockRepository implements Repository {
	commit(message: string, opts?: CommitOptions): Promise<void> {
		return Promise.reject(new Error(`Unexpected commit(${message}, ${opts})`));
	}
	renameRemote(name: string, newName: string): Promise<void> {
		return Promise.reject(new Error(`Unexpected renameRemote (${name}, ${newName})`));
	}
	getGlobalConfig(key: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected getGlobalConfig(${key})`));
	}
	detectObjectType(object: string): Promise<{ mimetype: string; encoding?: string | undefined }> {
		return Promise.reject(new Error(`Unexpected detectObjectType(${object})`));
	}
	buffer(ref: string, path: string): Promise<Buffer> {
		return Promise.reject(new Error(`Unexpected buffer(${ref}, ${path})`));
	}
	clean(paths: string[]): Promise<void> {
		return Promise.reject(new Error(`Unexpected clean(${paths})`));
	}
	diffWithHEAD(path?: any): any {
		return Promise.reject(new Error(`Unexpected diffWithHEAD(${path})`));
	}
	diffIndexWithHEAD(path?: any): any {
		return Promise.reject(new Error(`Unexpected diffIndexWithHEAD(${path})`));
	}
	diffIndexWith(ref: any, path?: any): any {
		return Promise.reject(new Error(`Unexpected diffIndexWith(${ref}, ${path})`));
	}
	getMergeBase(ref1: string, ref2: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected getMergeBase(${ref1}, ${ref2})`));
	}
	log(options?: any): Promise<Commit[]> {
		return Promise.reject(new Error(`Unexpected log(${options})`));
	}

	private _state: Mutable<RepositoryState> = {
		HEAD: undefined,
		refs: [],
		remotes: [],
		submodules: [],
		rebaseCommit: undefined,
		mergeChanges: [],
		indexChanges: [],
		workingTreeChanges: [],
		onDidChange: () => ({ dispose() {} }),
	};
	private _config: Map<string, string> = new Map();
	private _branches: Branch[] = [];
	private _expectedFetches: { remoteName?: string; ref?: string; depth?: number }[] = [];
	private _expectedPulls: { remote?: string, ref?: string, unshallow?: boolean }[] = [];
	private _expectedPushes: { remoteName?: string; branchName?: string; setUpstream?: boolean }[] = [];

	inputBox: InputBox = { value: '' };

	rootUri = Uri.file('/root');

	state: RepositoryState = this._state;

	ui: RepositoryUIState = {
		selected: true,
		onDidChange: () => ({ dispose() {} }),
	};

	async getConfigs(): Promise<{ key: string; value: string }[]> {
		return Array.from(this._config, ([k, v]) => ({ key: k, value: v }));
	}

	async getConfig(key: string): Promise<string> {
		return this._config.get(key) || '';
	}

	async setConfig(key: string, value: string): Promise<string> {
		const oldValue = this._config.get(key) || '';
		this._config.set(key, value);
		return oldValue;
	}

	getObjectDetails(treeish: string, treePath: string): Promise<{ mode: string; object: string; size: number }> {
		return Promise.reject(new Error(`Unexpected getObjectDetails(${treeish}, ${treePath})`));
	}

	show(ref: string, treePath: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected show(${ref}, ${treePath})`));
	}

	getCommit(ref: string): Promise<Commit> {
		return Promise.reject(new Error(`Unexpected getCommit(${ref})`));
	}

	apply(patch: string, reverse?: boolean | undefined): Promise<void> {
		return Promise.reject(new Error(`Unexpected apply(..., ${reverse})`));
	}

	diff(cached?: boolean | undefined): Promise<string> {
		return Promise.reject(new Error(`Unexpected diff(${cached})`));
	}

	diffWith(ref: string): Promise<Change[]>;
	diffWith(ref: string, treePath: string): Promise<string>;
	diffWith(ref: string, treePath?: string) {
		return Promise.reject(new Error(`Unexpected diffWith(${ref}, ${treePath})`));
	}

	diffBlobs(object1: string, object2: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected diffBlobs(${object1}, ${object2})`));
	}

	diffBetween(ref1: string, ref2: string): Promise<Change[]>;
	diffBetween(ref1: string, ref2: string, treePath: string): Promise<string>;
	diffBetween(ref1: string, ref2: string, treePath?: string) {
		return Promise.reject(new Error(`Unexpected diffBlobs(${ref1}, ${ref2}, ${treePath})`));
	}

	hashObject(data: string): Promise<string> {
		return Promise.reject(new Error('Unexpected hashObject(...)'));
	}

	async createBranch(name: string, checkout: boolean, ref?: string | undefined): Promise<void> {
		if (this._branches.some(b => b.name === name)) {
			throw new Error(`A branch named ${name} already exists`);
		}

		const branch = {
			type: RefType.Head,
			name,
			commit: ref,
		};

		if (checkout) {
			this._state.HEAD = branch;
		}

		this._state.refs.push(branch);
		this._branches.push(branch);
	}

	async deleteBranch(name: string, force?: boolean | undefined): Promise<void> {
		const index = this._branches.findIndex(b => b.name === name);
		if (index === -1) {
			throw new Error(`Attempt to delete nonexistent branch ${name}`);
		}
		this._branches.splice(index, 1);
	}

	async getBranch(name: string): Promise<Branch> {
		const branch = this._branches.find(b => b.name === name);
		if (!branch) {
			throw new Error(`getBranch called with unrecognized name "${name}"`);
		}
		return branch;
	}

	async getBranches(_query: BranchQuery): Promise<Ref[]> {
		return [];
	}

	async setBranchUpstream(name: string, upstream: string): Promise<void> {
		const index = this._branches.findIndex(b => b.name === name);
		if (index === -1) {
			throw new Error(`setBranchUpstream called with unrecognized branch name ${name})`);
		}

		const match = /^refs\/remotes\/([^\/]+)\/(.+)$/.exec(upstream);
		if (!match) {
			throw new Error(
				`upstream ${upstream} provided to setBranchUpstream did match pattern refs/remotes/<name>/<remote-branch>`,
			);
		}
		const [, remoteName, remoteRef] = match;

		const existing = this._branches[index];
		const replacement = {
			...existing,
			upstream: {
				remote: remoteName,
				name: remoteRef,
			},
		};
		this._branches.splice(index, 1, replacement);

		if (this._state.HEAD === existing) {
			this._state.HEAD = replacement;
		}
	}

	status(): Promise<void> {
		return Promise.reject(new Error('Unexpected status()'));
	}

	async checkout(treeish: string): Promise<void> {
		const branch = this._branches.find(b => b.name === treeish);

		// Also: tags

		if (!branch) {
			throw new Error(`checked called with unrecognized ref ${treeish}`);
		}

		this._state.HEAD = branch;
	}

	async addRemote(name: string, url: string): Promise<void> {
		if (this._state.remotes.some(r => r.name === name)) {
			throw new Error(`A remote named ${name} already exists.`);
		}

		this._state.remotes.push({
			name,
			fetchUrl: url,
			pushUrl: url,
			isReadOnly: false,
		});
	}

	async removeRemote(name: string): Promise<void> {
		const index = this._state.remotes.findIndex(r => r.name === name);
		if (index === -1) {
			throw new Error(`No remote named ${name} exists.`);
		}
		this._state.remotes.splice(index, 1);
	}

	async fetch(arg0?: string | undefined | FetchOptions, ref?: string | undefined, depth?: number | undefined): Promise<void> {
		let remoteName: string | undefined;
		if (typeof arg0 === 'object') {
			remoteName = arg0.remote;
			ref = arg0.ref;
			depth = arg0.depth;
		} else {
			remoteName = arg0;
		}

		const index = this._expectedFetches.findIndex(
			f => f.remoteName === remoteName && f.ref === ref && f.depth === depth,
		);
		if (index === -1) {
			throw new Error(`Unexpected fetch(${remoteName}, ${ref}, ${depth})`);
		}

		if (ref) {
			const match = /^(?:\+?[^:]+\:)?(.*)$/.exec(ref);
			if (match) {
				const [, localRef] = match;
				await this.createBranch(localRef, false);
			}
		}

		this._expectedFetches.splice(index, 1);
	}

	async pull(arg0?: PullOptions | boolean | undefined): Promise<void> {
		let remote: string | undefined;
		let ref: string | undefined;
		let unshallow: boolean | undefined;
		if (typeof arg0 === 'object') {
			remote = arg0.remote;
			ref = arg0.ref;
			unshallow = arg0.unshallow;
		} else {
			unshallow = arg0;
		}
		const index = this._expectedPulls.findIndex(
			f => f.remote === remote && f.ref === ref && f.unshallow === unshallow,
		);
		if (index === -1) {
			throw new Error(`Unexpected pull(${remote}, ${ref}, ${unshallow})`);
		}
		this._expectedPulls.splice(index, 1);
	}

	async push(
		remoteName?: string | undefined,
		branchName?: string | undefined,
		setUpstream?: boolean | undefined,
	): Promise<void> {
		const index = this._expectedPushes.findIndex(
			f => f.remoteName === remoteName && f.branchName === branchName && f.setUpstream === setUpstream,
		);
		if (index === -1) {
			throw new Error(`Unexpected push(${remoteName}, ${branchName}, ${setUpstream})`);
		}
		this._expectedPushes.splice(index, 1);
	}

	blame(treePath: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected blame(${treePath})`));
	}

	expectFetch(remoteName?: string, ref?: string, depth?: number) {
		this._expectedFetches.push({ remoteName, ref, depth });
	}

	expectPull(remote?: string, ref?: string, unshallow?: boolean) {
		this._expectedPulls.push({ remote, ref, unshallow });
	}

	expectPush(remoteName?: string, branchName?: string, setUpstream?: boolean) {
		this._expectedPushes.push({ remoteName, branchName, setUpstream });
	}
}
