import fetch, { RequestInit } from 'node-fetch';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { agent } from '../env/node/net';
import { HostHelper } from './configuration';

export class GitHubManager {
	private _servers: Map<string, boolean> = new Map().set('github.com', true);

	public async isGitHub(host: vscode.Uri): Promise<boolean> {
		if (host === null) {
			return false;
		}

		// .wiki repos are not supported
		if (host.path.endsWith('.wiki')) {
			return false;
		}

		let authority = host.authority === 'ssh.github.com' ? 'github.com' : host.authority;
		if (this._servers.has(authority)) {
			return !!this._servers.get(authority);
		}

		const [uri, options] = await GitHubManager.getOptions(host, 'HEAD', '/rate_limit');

		let isGitHub = false;
		try {
			const response = await fetch(uri.toString(), options);
			const gitHubHeader = response.headers.get('x-github-request-id');
			isGitHub = ((gitHubHeader !== undefined) && (gitHubHeader !== null));
			return isGitHub;
		} catch (ex) {
			Logger.appendLine(`No response from host ${host}: ${ex.message}`, 'GitHubServer');
			return isGitHub;
		} finally {
			Logger.debug(`Host ${host} is associated with GitHub: ${isGitHub}`, 'GitHubServer');
			this._servers.set(host.authority, isGitHub);
		}
	}

	public static async getOptions(
		hostUri: vscode.Uri,
		method: string = 'GET',
		path: string,
		token?: string,
	): Promise<[vscode.Uri, RequestInit]> {
		const headers: {
			'user-agent': string;
			authorization?: string;
		} = {
			'user-agent': 'GitHub VSCode Pull Requests',
		};
		if (token) {
			headers.authorization = `token ${token}`;
		}

		const uri = vscode.Uri.joinPath(await HostHelper.getApiHost(hostUri), HostHelper.getApiPath(hostUri, path));

		return [
			uri,
			{
				hostname: uri.authority,
				port: 443,
				method,
				headers,
				agent,
			},
		];
	}
}
