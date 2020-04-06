/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import TelemetryReporter from 'vscode-extension-telemetry';
import { Repository } from './api/api';
import { ApiImpl } from './api/api1';
import * as Keychain from './authentication/keychain';
import { migrateConfiguration } from './authentication/vsConfiguration';
import { registerCommands } from './commands';
import Logger from './common/logger';
import { Resource } from './common/resources';
import { handler as uriHandler } from './common/uri';
import { formatError, onceEvent } from './common/utils';
import * as PersistentState from './common/persistentState';
import { EXTENSION_ID } from './constants';
import { PullRequestManager } from './github/pullRequestManager';
import { registerBuiltinGitProvider, registerLiveShareGitProvider } from './gitProviders/api';
import { FileTypeDecorationProvider } from './view/fileTypeDecorationProvider';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { ReviewManager } from './view/reviewManager';
import { IssueFeatureRegistrar } from './issues/issueFeatureRegistrar';

const aiKey: string = 'AIF-d9b70cd4-b9f9-4d70-929b-a071c400b217';

// fetch.promise polyfill
const fetch = require('node-fetch');
const PolyfillPromise = require('es6-promise').Promise;
fetch.Promise = PolyfillPromise;

let telemetry: TelemetryReporter;

async function init(context: vscode.ExtensionContext, api: ApiImpl, repository: Repository, tree: PullRequestsTreeDataProvider): Promise<void> {
	context.subscriptions.push(Logger);
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

	Keychain.init(context);
	PersistentState.init(context);

	await migrateConfiguration();
	context.subscriptions.push(Keychain.onDidChange(async _ => {
		if (prManager) {
			try {
				await prManager.clearCredentialCache();
				if (reviewManager) {
					reviewManager.updateState();
				}
			} catch (e) {
				vscode.window.showErrorMessage(formatError(e));
			}
		}
	}));

	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
	context.subscriptions.push(new FileTypeDecorationProvider());

	const prManager = new PullRequestManager(repository, telemetry, api);
	api.pullRequestManager = prManager;
	context.subscriptions.push(prManager);

	const reviewManager = new ReviewManager(context, repository, prManager, tree, telemetry);
	tree.initialize(prManager);
	registerCommands(context, prManager, reviewManager, telemetry);

	api.onDidChangeState(() => {
		reviewManager.updateState();
	});

	api.repositories.forEach(repo => {
		repo.ui.onDidChange(() => {
			// No multi-select support, always show last selected repo
			if (repo.ui.selected) {
				prManager.repository = repo;
				reviewManager.repository = repo;
				tree.updateQueries();
			}
		});
	});

	api.onDidOpenRepository(repo => {
		repo.ui.onDidChange(() => {
			if (repo.ui.selected) {
				prManager.repository = repo;
				reviewManager.repository = repo;
				tree.updateQueries();
			}
		});
	});

	await vscode.commands.executeCommand('setContext', 'github:initialized', true);
	const issuesFeatures = new IssueFeatureRegistrar(prManager, reviewManager, context);
	context.subscriptions.push(issuesFeatures);
	await issuesFeatures.initialize();

	/* __GDPR__
		"startup" : {}
	*/
	telemetry.sendTelemetryEvent('startup');
}

export async function activate(context: vscode.ExtensionContext): Promise<ApiImpl> {
	// initialize resources
	Resource.initialize(context);
	const apiImpl = new ApiImpl();

	const version = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.version;
	telemetry = new TelemetryReporter(EXTENSION_ID, version, aiKey);
	context.subscriptions.push(telemetry);

	context.subscriptions.push(registerBuiltinGitProvider(apiImpl));
	context.subscriptions.push(registerLiveShareGitProvider(apiImpl));
	context.subscriptions.push(apiImpl);

	Logger.appendLine('Looking for git repository');

	const prTree = new PullRequestsTreeDataProvider(telemetry);
	context.subscriptions.push(prTree);

	// The Git extension API sometimes returns a single repository that does not have selected set,
	// so fall back to the first repository if no selected repository is found.
	const selectedRepository = apiImpl.repositories.find(repository => repository.ui.selected) || apiImpl.repositories[0];
	if (selectedRepository) {
		await init(context, apiImpl, selectedRepository, prTree);
	} else {
		onceEvent(apiImpl.onDidOpenRepository)(r => init(context, apiImpl, r, prTree));
	}

	return apiImpl;
}

export async function deactivate() {
	if (telemetry) {
		telemetry.dispose();
	}
}
