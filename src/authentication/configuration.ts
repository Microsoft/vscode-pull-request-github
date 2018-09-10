import * as vscode from 'vscode';

export interface IHostConfiguration {
	host: string;
	username: string | undefined;
	token: string | undefined;
}

export const HostHelper = class {
	public static getApiHost(host: IHostConfiguration | vscode.Uri): vscode.Uri {
		const hostUri: vscode.Uri = host instanceof vscode.Uri ? host : vscode.Uri.parse(host.host);
		if (hostUri.authority === 'github.com') {
			return vscode.Uri.parse('https://api.github.com');
		} else {
			return vscode.Uri.parse(`${hostUri.scheme}://${hostUri.authority}`);
		}
	}

	public static getApiPath(host: IHostConfiguration | vscode.Uri, path: string): string {
		const hostUri: vscode.Uri = host instanceof vscode.Uri ? host : vscode.Uri.parse(host.host);
		if (hostUri.authority === 'github.com') {
			return path;
		} else {
			return `/api/v3${path}`;
		}
	}
};

export interface IConfiguration extends IHostConfiguration {
	onDidChange: vscode.Event<IConfiguration>;
}

export class Configuration implements IConfiguration {
	public username: string | undefined;
	public token: string | undefined;
	public onDidChange: vscode.Event<IConfiguration>;
	private _emitter: vscode.EventEmitter<IConfiguration>;

	constructor(public host: string) {
		this._emitter = new vscode.EventEmitter<IConfiguration>();
		this.onDidChange = this._emitter.event;
	}

	public update(username: string | undefined, token: string | undefined, raiseEvent: boolean = true): Promise<boolean> {
		if (username !== this.username || token !== this.token) {
			this.username = username;
			this.token = token;
			if (raiseEvent) {
				this._emitter.fire(this);
			}
			return Promise.resolve(true);
		}
		return Promise.resolve(false);
	}

	protected raiseChangedEvent(): void {
		this._emitter.fire(this);
	}
}
