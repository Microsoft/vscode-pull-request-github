/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Protocol } from './protocol';
import { Repository } from '../typings/git';

export class Remote {
	public get host(): string {
		return this.gitProtocol.host;
	}
	public get owner(): string {
		return this.gitProtocol.owner;
	}
	public get repositoryName(): string {
		return this.gitProtocol.repositoryName;
	}

	public get normalizedHost(): string {
		const normalizedUri = this.gitProtocol.normalizeUri();
		return `${normalizedUri.scheme}://${normalizedUri.authority}`;
	}

	constructor(
		public readonly remoteName: string,
		public readonly url: string,
		public readonly gitProtocol: Protocol,
	) { }

	equals(remote: Remote): boolean {
		if (this.remoteName !== remote.remoteName) {
			return false;
		}
		if (this.host !== remote.host) {
			return false;
		}
		if (this.owner !== remote.owner) {
			return false;
		}
		if (this.repositoryName !== remote.repositoryName) {
			return false;
		}

		return true;
	}
}

export function parseRemote(remoteName: string, url: string): Remote | null {
	let gitProtocol = new Protocol(url);

	if (gitProtocol.host) {
		return new Remote(remoteName, url, gitProtocol);
	}

	return null;
}

export function parseRepositoryRemotes(repository: Repository): Remote[] {
	return repository.state.remotes
		.map(r => parseRemote(r.name, r.fetchUrl || r.pushUrl))
		.filter(r => !!r);
}