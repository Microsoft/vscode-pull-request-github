/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as Github from '@octokit/rest';
import { CredentialStore } from './credentials';
import { Comment } from '../common/comment';
import { Remote, parseRepositoryRemotes } from '../common/remote';
import { TimelineEvent, EventType, ReviewEvent as CommonReviewEvent, isReviewEvent, isCommitEvent } from '../common/timelineEvent';
import { GitHubRepository } from './githubRepository';
import { IPullRequestsPagingOptions, PRType, ReviewEvent, ITelemetry, IPullRequestEditData, PullRequest, IRawFileChange, IAccount, ILabel, MergeMethodsAvailability } from './interface';
import { PullRequestGitHelper } from './pullRequestGitHelper';
import { PullRequestModel } from './pullRequestModel';
import { GitHubManager } from '../authentication/githubServer';
import { formatError, uniqBy, Predicate } from '../common/utils';
import { Repository, RefType, UpstreamRef } from '../api/api';
import Logger from '../common/logger';
import { EXTENSION_ID } from '../constants';
import { fromPRUri } from '../common/uri';
import { convertRESTPullRequestToRawPullRequest, convertPullRequestsGetCommentsResponseItemToComment, convertIssuesCreateCommentResponseToComment, parseGraphQLTimelineEvents, convertRESTTimelineEvents, getRelatedUsersFromTimelineEvents, parseGraphQLComment, getReactionGroup, convertRESTUserToAccount, convertRESTReviewEvent, parseGraphQLReviewEvent } from './utils';
import { PendingReviewIdResponse, TimelineEventsResponse, PullRequestCommentsResponse, AddCommentResponse, SubmitReviewResponse, DeleteReviewResponse, EditCommentResponse, DeleteReactionResponse, AddReactionResponse } from './graphql';
const queries = require('./queries.gql');

interface PageInformation {
	hasMorePages: boolean | null;
	endCursor: string | null;
}

interface RestErrorResult {
	errors: RestError[];
	message: string;
}

interface RestError {
	code: string;
	field: string;
	resource: string;
}

interface PullRequestsResponseResult {
	pullRequests: PullRequestModel[];
	hasMorePages: boolean;
	hasUnsearchedRepositories: boolean;
}

export class NoGitHubReposError extends Error {
	constructor(public repository: Repository) {
		super();
	}

	get message() {
		return `${this.repository.rootUri.toString()} has no GitHub remotes`;
	}
}

export class DetachedHeadError extends Error {
	constructor(public repository: Repository) {
		super();
	}

	get message() {
		return `${this.repository.rootUri.toString()} has a detached HEAD (create a branch first)`;
	}
}

export class BadUpstreamError extends Error {
	constructor(
		public branchName: string,
		public upstreamRef: UpstreamRef,
		public problem: string) {
		super();
	}

	get message() {
		const { upstreamRef: { remote, name }, branchName, problem } = this;
		return `The upstream ref ${remote}/${name} for branch ${branchName} ${problem}.`;
	}
}

const SETTINGS_NAMESPACE = 'githubPullRequests';
const REMOTES_SETTING = 'remotes';

interface NewCommentPosition {
	path: string;
	position: number;
}

interface ReplyCommentPosition {
	inReplyTo: string;
}

export class PullRequestManager {
	static ID = 'PullRequestManager';
	private _activePullRequest?: PullRequestModel;
	private _credentialStore: CredentialStore;
	private _githubRepositories: GitHubRepository[];
	private _mentionableUsers?: { [key: string]: IAccount[] };
	private _fetchMentionableUsersPromise?: Promise<{ [key: string]: IAccount[] }>;
	private _gitBlameCache: { [key: string]: string } = {};
	private _githubManager: GitHubManager;
	private _repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();

	private _onDidChangeActivePullRequest = new vscode.EventEmitter<void>();
	readonly onDidChangeActivePullRequest: vscode.Event<void> = this._onDidChangeActivePullRequest.event;

	constructor(
		private _repository: Repository,
		private readonly _telemetry: ITelemetry,
	) {
		this._githubRepositories = [];
		this._credentialStore = new CredentialStore(this._telemetry);
		this._githubManager = new GitHubManager();
		vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.${REMOTES_SETTING}`)) {
				await this.updateRepositories();
				vscode.commands.executeCommand('pr.refreshList');
			}
		});

		this.setUpCompletionItemProvider();
	}

	private async getActiveGitHubRemotes(allGitHubRemotes: Remote[]): Promise<Remote[]> {
		const remotesSetting = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string[]>(REMOTES_SETTING);

		if (remotesSetting) {
			remotesSetting.forEach(remote => {
				if (!allGitHubRemotes.some(repo => repo.remoteName === remote)) {
					Logger.appendLine(`No remote with name '${remote}' found. Please update your 'githubPullRequests.remotes' setting.`);
				}
			});

			Logger.debug(`Displaying configured remotes: ${remotesSetting.join(', ')}`, PullRequestManager.ID);

			return remotesSetting
				.map(remote => allGitHubRemotes.find(repo => repo.remoteName === remote))
				.filter(repo => !!repo) as Remote[];
		}

		const upstream = allGitHubRemotes.find(repo => repo.remoteName === 'upstream');
		const origin = allGitHubRemotes.find(repo => repo.remoteName === 'origin');

		const activeRemotes: Remote[] = [];
		if (upstream) {
			Logger.debug(`Displaying upstream remote`, PullRequestManager.ID);
			activeRemotes.push(upstream);
		}

		if (origin) {
			Logger.debug(`Displaying origin remote`, PullRequestManager.ID);
			activeRemotes.push(origin);
		}

		if (activeRemotes.length) {
			return activeRemotes;
		}

		Logger.debug(`Displaying all github remotes`, PullRequestManager.ID);
		const remotes = uniqBy(allGitHubRemotes, remote => remote.gitProtocol.normalizeUri()!.toString());
		return await PullRequestGitHelper.getUserCreatedRemotes(this.repository, remotes);
	}

	private setUpCompletionItemProvider() {
		let lastPullRequest: PullRequestModel | undefined = undefined;
		let lastPullRequestTimelineEvents: TimelineEvent[] = [];
		let cachedUsers: vscode.CompletionItem[] = [];

		vscode.languages.registerCompletionItemProvider({ scheme: 'comment' }, {
			provideCompletionItems: async (document, position, token) => {
				try {
					let query = JSON.parse(document.uri.query);
					if (query.extensionId !== EXTENSION_ID) {
						return;
					}

					const wordRange = document.getWordRangeAtPosition(position, /@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})?/i);
					if (!wordRange || wordRange.isEmpty) {
						return;
					}

					let prRelatedusers: { login: string; name?: string; }[] = [];
					let fileRelatedUsersNames: { [key: string]: boolean } = {};
					let mentionableUsers: { [key: string]: { login: string; name?: string; }[]; } = {};
					let prNumber: number | undefined;
					let remoteName: string | undefined;

					let activeTextEditors = vscode.window.visibleTextEditors;
					if (activeTextEditors.length) {
						let visibilePREditor = activeTextEditors.find(editor => editor.document.uri.scheme === 'pr');

						if (visibilePREditor) {
							let params = fromPRUri(visibilePREditor.document.uri);
							prNumber = params!.prNumber;
							remoteName = params!.remoteName;
						} else if (this._activePullRequest) {
							prNumber = this._activePullRequest.prNumber;
							remoteName = this._activePullRequest.remote.remoteName;
						}

						if (lastPullRequest && prNumber && prNumber === lastPullRequest.prNumber) {
							return cachedUsers;
						}
					}

					let prRelatedUsersPromise = new Promise(async resolve => {
						if (prNumber && remoteName) {
							Logger.debug('get Timeline Events and parse users', PullRequestManager.ID);
							if (lastPullRequest && lastPullRequest.prNumber === prNumber) {
								return lastPullRequestTimelineEvents;
							}

							let githubRepos = this._githubRepositories.filter(repo => repo.remote.remoteName === remoteName);

							if (githubRepos.length) {
								lastPullRequest = await githubRepos[0].getPullRequest(prNumber);
								lastPullRequestTimelineEvents = await this.getTimelineEvents(lastPullRequest!);
							}

							prRelatedusers = getRelatedUsersFromTimelineEvents(lastPullRequestTimelineEvents);
							resolve();
						}

						resolve();
					});

					let fileRelatedUsersNamesPromise = new Promise(async resolve => {
						if (activeTextEditors.length) {
							try {
								Logger.debug('git blame and parse users', PullRequestManager.ID);
								let fsPath = path.resolve(activeTextEditors[0].document.uri.fsPath);
								let blames: string | undefined;
								if (this._gitBlameCache[fsPath]) {
									blames = this._gitBlameCache[fsPath];
								} else {
									blames = await this.repository.blame(fsPath);
									this._gitBlameCache[fsPath] = blames;
								}

								let blameLines = blames.split('\n');

								for (let line in blameLines) {
									let matches = /^\w{11} \S*\s*\((.*)\s*\d{4}\-/.exec(blameLines[line]);

									if (matches && matches.length === 2) {
										let name = matches[1].trim();
										fileRelatedUsersNames[name] = true;
									}
								}
							} catch (err) {
								Logger.debug(err, PullRequestManager.ID);
							}
						}

						resolve();
					});

					let getMentionableUsersPromise = new Promise(async resolve => {
						Logger.debug('get mentionable users', PullRequestManager.ID);
						mentionableUsers = await this.getMentionableUsers();
						resolve();
					});

					await Promise.all([prRelatedUsersPromise, fileRelatedUsersNamesPromise, getMentionableUsersPromise]);

					cachedUsers = [];
					let prRelatedUsersMap: { [key: string]: { login: string; name?: string; } } = {};
					Logger.debug('prepare user suggestions', PullRequestManager.ID);

					prRelatedusers.forEach(user => {
						if (!prRelatedUsersMap[user.login]) {
							prRelatedUsersMap[user.login] = user;
						}
					});

					let secondMap: { [key: string]: boolean } = {};

					for (let mentionableUserGroup in mentionableUsers) {
						mentionableUsers[mentionableUserGroup].forEach(user => {
							if (!prRelatedUsersMap[user.login] && !secondMap[user.login]) {
								secondMap[user.login] = true;

								let priority = 2;
								if (fileRelatedUsersNames[user.login] || (user.name && fileRelatedUsersNames[user.name])) {
									priority = 1;
								}

								if (prRelatedUsersMap[user.login]) {
									priority = 0;
								}

								cachedUsers.push({
									label: `@${user.login}`,
									insertText: `${user.login}`,
									filterText: `${user.login}` + (user.name && user.name !== user.login ? `_${user.name.toLowerCase().replace(' ', '_')}` : ''),
									sortText: `${priority}_${user.login}`,
									detail: `${user.name}`
								});
							}
						});
					}

					for (let user in prRelatedUsersMap) {
						if (!secondMap[user]) {
							// if the mentionable api call fails partially, we should still populate related users from timeline events into the completion list
							cachedUsers.push({
								label: `@${prRelatedUsersMap[user].login}`,
								insertText: `${prRelatedUsersMap[user].login}`,
								filterText: `${prRelatedUsersMap[user].login}` + (prRelatedUsersMap[user].name && prRelatedUsersMap[user].name !== prRelatedUsersMap[user].login ? `_${prRelatedUsersMap[user].name!.toLowerCase().replace(' ', '_')}` : ''),
								sortText: `0_${prRelatedUsersMap[user].login}`,
								detail: `${prRelatedUsersMap[user].name}`
							});
						}
					}

					Logger.debug('done', PullRequestManager.ID);
					return cachedUsers;
				} catch (e) {
					return [];
				}
			}
		}, '@');

	}

	get activePullRequest(): (PullRequestModel | undefined) {
		return this._activePullRequest;
	}

	set activePullRequest(pullRequest: (PullRequestModel | undefined)) {
		this._activePullRequest = pullRequest;
		this._onDidChangeActivePullRequest.fire();
	}

	get repository(): Repository {
		return this._repository;
	}

	set repository(repository: Repository) {
		this._repository = repository;
	}

	async clearCredentialCache(): Promise<void> {
		this._credentialStore.reset();
	}

	async updateRepositories(): Promise<void> {
		Logger.debug('update repositories', PullRequestManager.ID);
		const remotes = parseRepositoryRemotes(this.repository);
		const potentialRemotes = remotes.filter(remote => remote.host);
		const allGitHubRemotes = await Promise.all(potentialRemotes.map(remote => this._githubManager.isGitHub(remote.gitProtocol.normalizeUri()!)))
			.then(results => potentialRemotes.filter((_, index, __) => results[index]))
			.catch(e => {
				Logger.appendLine(`Resolving GitHub remotes failed: ${formatError(e)}`);
				vscode.window.showErrorMessage(`Resolving GitHub remotes failed: ${formatError(e)}`);
				return [];
			});

		const activeRemotes = await this.getActiveGitHubRemotes(allGitHubRemotes);

		if (activeRemotes.length) {
			await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', true);
			Logger.appendLine('Found GitHub remote');
		} else {
			await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', false);
			Logger.appendLine('No GitHub remotes found');
			return;
		}

		let serverAuthPromises = [];
		for (let server of uniqBy(activeRemotes, remote => remote.gitProtocol.normalizeUri()!.authority)) {
			serverAuthPromises.push(this._credentialStore.hasOctokit(server).then(authd => {
				if (!authd) {
					this._credentialStore.loginWithConfirmation(server);
				}
			}));
		}
		// Make sure authentication is set up for all the servers that the remotes are pointing to
		// this will ask the user to sign in if there's no credentials for a server, once per server
		await Promise.all(serverAuthPromises).catch(e => {
			Logger.appendLine(`serverAuthPromises failed: ${formatError(e)}`);
		});

		let repositories: GitHubRepository[] = [];
		let resolveRemotePromises: Promise<void>[] = [];

		activeRemotes.forEach(remote => {
			const repository = new GitHubRepository(remote, this._credentialStore);
			resolveRemotePromises.push(repository.resolveRemote());
			repositories.push(repository);
		});

		return Promise.all(resolveRemotePromises).then(_ => {
			const oldRepositories = this._githubRepositories;
			this._githubRepositories = repositories;
			oldRepositories.forEach(repo => repo.dispose());

			for (let repository of this._githubRepositories) {
				const remoteId = repository.remote.url.toString();
				if (!this._repositoryPageInformation.get(remoteId)) {
					this._repositoryPageInformation.set(remoteId, {
						hasMorePages: null,
						endCursor: null
					});
				}
			}

			this.getMentionableUsers();
			return Promise.resolve();
		});
	}

	async getMentionableUsers(): Promise<{ [key: string]: IAccount[] }> {
		if (this._mentionableUsers) {
			return this._mentionableUsers;
		}

		if (!this._fetchMentionableUsersPromise) {
			let cache: { [key: string]: IAccount[] } = {};
			return this._fetchMentionableUsersPromise = new Promise((resolve) => {
				let promises: Promise<void>[] = [];
				this._githubRepositories.forEach(githubRepository => {
					promises.push(new Promise<void>(async (res) => {
						let data = await githubRepository.getMentionableUsers();
						cache[githubRepository.remote.remoteName] = data;
						res();
					}));
				});

				Promise.all(promises).then(() => {
					resolve(cache);
				});
			});
		}

		return this._fetchMentionableUsersPromise.then(cache => {
			this._mentionableUsers = cache;
			this._fetchMentionableUsersPromise = undefined;
			return this._mentionableUsers;
		});
	}

	getGitHubRemotes(): Remote[] {
		const githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		return githubRepositories.map(repository => repository.remote);
	}

	async authenticate(): Promise<boolean> {
		let ret = false;
		this._credentialStore.reset();
		for (let repository of uniqBy(this._githubRepositories, x => x.remote.normalizedHost)) {
			ret = await repository.authenticate() || ret;
		}
		return ret;
	}

	async getLocalPullRequests(): Promise<PullRequestModel[]> {
		const githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		const localBranches = this.repository.state.refs
			.filter(r => r.type === RefType.Head && r.name !== undefined)
			.map(r => r.name!);

		const promises = localBranches.map(async localBranchName => {
			const matchingPRMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this.repository, localBranchName);

			if (matchingPRMetadata) {
				const { owner, prNumber } = matchingPRMetadata;
				const githubRepo = githubRepositories.find(repo => repo.remote.owner.toLocaleLowerCase() === owner.toLocaleLowerCase());

				if (githubRepo) {
					const pullRequest: PullRequestModel | undefined = await githubRepo.getPullRequest(prNumber);

					if (pullRequest) {
						pullRequest.localBranchName = localBranchName;
						return pullRequest;
					}
				}
			}

			return Promise.resolve(null);
		});

		return Promise.all(promises).then(values => {
			return values.filter(value => value !== null) as PullRequestModel[];
		});
	}

	async getLabels(pullRequest: PullRequestModel): Promise<ILabel[]> {
		const { remote, octokit } = await pullRequest.githubRepository.ensure();

		let hasNextPage = false;
		let page = 1;
		let results: ILabel[] = [];

		do {
			const result = await octokit.issues.getLabels({
				owner: remote.owner,
				repo: remote.repositoryName,
				page
			});

			results = results.concat(result.data.map(label => {
				return {
					name: label.name,
					color: label.color
				};
			}));

			hasNextPage = !!result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
			page += 1;
		} while (hasNextPage);

		return results;
	}

	async deleteLocalPullRequest(pullRequest: PullRequestModel, force?: boolean): Promise<void> {
		if (!pullRequest.localBranchName) {
			return;
		}
		await this.repository.deleteBranch(pullRequest.localBranchName, force);

		let remoteName: string | undefined = undefined;
		try {
			remoteName = await this.repository.getConfig(`branch.${pullRequest.localBranchName}.remote`);
		} catch (e) { }

		if (!remoteName) {
			return;
		}

		// If the extension created a remote for the branch, remove it if there are no other branches associated with it
		const isPRRemote = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this.repository, remoteName);
		if (isPRRemote) {
			const configs = await this.repository.getConfigs();
			const hasOtherAssociatedBranches = configs
				.some(({ key, value }) => /^branch.*\.remote$/.test(key) && value === remoteName);

			if (!hasOtherAssociatedBranches) {
				await this.repository.removeRemote(remoteName);
			}
		}
		this._telemetry.on('branch.delete');
	}

	async getPullRequests(type: PRType, options: IPullRequestsPagingOptions = { fetchNextPage: false }): Promise<PullRequestsResponseResult> {
		if (!this._githubRepositories || !this._githubRepositories.length) {
			return {
				pullRequests: [],
				hasMorePages: false,
				hasUnsearchedRepositories: false
			};
		}

		if (!options.fetchNextPage) {
			for (let repository of this._githubRepositories) {
				this._repositoryPageInformation.set(repository.remote.url.toString(), {
					hasMorePages: null,
					endCursor: null
				});
			}
		}

		const githubRepositories = this._githubRepositories.filter(repo => {
			const info = this._repositoryPageInformation.get(repo.remote.url.toString());
			return info && info.hasMorePages !== false;
		});

		for (let i = 0; i < githubRepositories.length; i++) {
			const githubRepository = githubRepositories[i];

			const pageInformation = this._repositoryPageInformation.get(githubRepository.remote.url.toString())!;
			const pullRequestResponseData = await githubRepository.getPullRequestsGraphQL(type, pageInformation.endCursor);
			const { remote } = await githubRepository.ensure();

			if(!!pullRequestResponseData) {
				pageInformation.hasMorePages = pullRequestResponseData.search.pageInfo.hasNextPage;
				pageInformation.endCursor = pullRequestResponseData.search.pageInfo.endCursor;
			} else {
				pageInformation.hasMorePages = false;
				pageInformation.endCursor = null;
			}

			if (pullRequestResponseData && pullRequestResponseData.search.nodes.length) {
				let pullRequestItems = pullRequestResponseData.search.nodes;

				const pullRequests: PullRequestModel[] = pullRequestItems.map(pullRequestItem => {
						let assignee: IAccount | undefined;
						if(!!pullRequestItem.assignees.nodes && pullRequestItem.assignees.nodes.length) {
							assignee = pullRequestItem.assignees.nodes[0];
						}

						const pullRequest: PullRequest = {
							url: pullRequestItem.url,
							assignee,
							base: {
								label: `${pullRequestItem.baseRef.repository.owner}:${pullRequestItem.baseRef.name}`,
								ref: pullRequestItem.baseRef.name,
								repo: {cloneUrl: pullRequestItem.baseRef.repository.url },
								sha: pullRequestItem.baseRef.target.oid
							},
							head: {
								label: `${pullRequestItem.headRef.repository.owner}:${pullRequestItem.headRef.name}`,
								ref: pullRequestItem.headRef.name,
								repo: {cloneUrl: pullRequestItem.headRef.repository.url },
								sha: pullRequestItem.baseRef.target.oid
							},
							labels: [],
							body: '',
							createdAt: pullRequestItem.createdAt,
							updatedAt: pullRequestItem.updatedAt,
							merged: pullRequestItem.merged,
							nodeId: pullRequestItem.nodeId,
							number: pullRequestItem.number,
							state: pullRequestItem.state,
							title: pullRequestItem.title,
							user: pullRequestItem.author
						};

						return new PullRequestModel(githubRepository, remote, pullRequest);
					});

				return {
					pullRequests: pullRequests,
					hasMorePages: pageInformation.hasMorePages,
					hasUnsearchedRepositories: i < githubRepositories.length - 1
				};
			}
		}

		return {
			pullRequests: [],
			hasMorePages: false,
			hasUnsearchedRepositories: false
		};
	}

	public mayHaveMorePages(): boolean {
		return this._githubRepositories.some(repo => {
			let info = this._repositoryPageInformation.get(repo.remote.url.toString());
			return !!(info && info.hasMorePages !== false);
		});
	}

	async getStatusChecks(pullRequest: PullRequestModel): Promise<Github.ReposGetCombinedStatusForRefResponse> {
		const { remote, octokit } = await pullRequest.githubRepository.ensure();

		const result = await octokit.repos.getCombinedStatusForRef({
			owner: remote.owner,
			repo: remote.repositoryName,
			ref: pullRequest.head.sha
		});

		return result.data;
	}

	async getReviewRequests(pullRequest: PullRequestModel): Promise<IAccount[]> {
		const { remote, octokit } = await pullRequest.githubRepository.ensure();
		const result = await octokit.pullRequests.getReviewRequests({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber
		});

		return result.data.users.map(user => convertRESTUserToAccount(user));
	}

	async getPullRequestComments(pullRequest: PullRequestModel): Promise<Comment[]> {
		const { supportsGraphQl } = pullRequest.githubRepository;
		return supportsGraphQl
			? this.getAllPullRequestReviewComments(pullRequest)
			: this.getPullRequestReviewComments(pullRequest);
	}

	private async getAllPullRequestReviewComments(pullRequest: PullRequestModel): Promise<Comment[]> {
		const { remote, query } = await pullRequest.githubRepository.ensure();
		try {
			const { data } = await query<PullRequestCommentsResponse>({
				query: queries.PullRequestComments,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: pullRequest.prNumber,
				}
			});

			const comments = data.repository.pullRequest.reviews.nodes
				.map((node: any) => node.comments.nodes.map((comment: any) => parseGraphQLComment(comment), remote))
				.reduce((prev: any, curr: any) => prev.concat(curr), [])
				.sort((a: Comment, b: Comment) => { return a.isDraft ? 1 : 0; });

			return comments;
		} catch (e) {
			Logger.appendLine(`Failed to get pull request review comments: ${formatError(e)}`);
			return [];
		}
	}

	/**
	 * Returns review comments from the pull request using the REST API, comments on pending reviews are not included.
	 */
	private async getPullRequestReviewComments(pullRequest: PullRequestModel): Promise<Comment[]> {
		Logger.debug(`Fetch comments of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const { remote, octokit } = await (pullRequest as PullRequestModel).githubRepository.ensure();
		const reviewData = await octokit.pullRequests.getComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});
		Logger.debug(`Fetch comments of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);
		const rawComments = reviewData.data.map(comment => this.addCommentPermissions(convertPullRequestsGetCommentsResponseItemToComment(comment), remote));
		return rawComments;
	}

	async getPullRequestCommits(pullRequest: PullRequestModel): Promise<Github.PullRequestsGetCommitsResponseItem[]> {
		try {
			Logger.debug(`Fetch commits of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
			const { remote, octokit } = await pullRequest.githubRepository.ensure();
			const commitData = await octokit.pullRequests.getCommits({
				number: pullRequest.prNumber,
				owner: remote.owner,
				repo: remote.repositoryName
			});
			Logger.debug(`Fetch commits of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);

			return commitData.data;
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commits failed: ${formatError(e)}`);
			return [];
		}
	}

	async getCommitChangedFiles(pullRequest: PullRequestModel, commit: Github.PullRequestsGetCommitsResponseItem): Promise<Github.ReposGetCommitResponseFilesItem[]> {
		try {
			Logger.debug(`Fetch file changes of commit ${commit.sha} in PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
			const { octokit, remote } = await pullRequest.githubRepository.ensure();
			const fullCommit = await octokit.repos.getCommit({
				owner: remote.owner,
				repo: remote.repositoryName,
				sha: commit.sha
			});
			Logger.debug(`Fetch file changes of commit ${commit.sha} in PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);

			return fullCommit.data.files.filter(file => !!file.patch);
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commit file changes failed: ${formatError(e)}`);
			return [];
		}
	}

	async getTimelineEvents(pullRequest: PullRequestModel): Promise<TimelineEvent[]> {
		Logger.debug(`Fetch timeline events of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const { octokit, query, remote, supportsGraphQl } = await pullRequest.githubRepository.ensure();

		let ret = [];
		if (supportsGraphQl) {
			try {
				const { data } = await query<TimelineEventsResponse>({
					query: queries.TimelineEvents,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						number: pullRequest.prNumber
					}
				});
				ret = data.repository.pullRequest.timeline.edges.map((edge: any) => edge.node);
				let events = parseGraphQLTimelineEvents(ret);
				await this.addReviewTimelineEventComments(pullRequest, events);
				return events;
			} catch (e) {
				console.log(e);
				return [];
			}
		} else {
			ret = (await octokit.issues.getEventsTimeline({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber,
				per_page: 100
			})).data;
			Logger.debug(`Fetch timeline events of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);
			return convertRESTTimelineEvents(await this.parseRESTTimelineEvents(pullRequest, remote, ret));
		}
	}

	async getIssueComments(pullRequest: PullRequestModel): Promise<Github.IssuesGetCommentsResponseItem[]> {
		Logger.debug(`Fetch issue comments of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		const promise = await octokit.issues.getComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});
		Logger.debug(`Fetch issue comments of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);

		return promise.data;
	}

	async createIssueComment(pullRequest: PullRequestModel, text: string): Promise<Comment> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		const promise = await octokit.issues.createComment({
			body: text,
			number: pullRequest.prNumber,
			owner: remote.owner,
			repo: remote.repositoryName
		});

		return this.addCommentPermissions(convertIssuesCreateCommentResponseToComment(promise.data), remote);
	}

	async createCommentReply(pullRequest: PullRequestModel, body: string, reply_to: Comment): Promise<Comment | undefined> {
		const pendingReviewId = await this.getPendingReviewId(pullRequest);
		if (pendingReviewId) {
			return this.addCommentToPendingReview(pullRequest, pendingReviewId, body, { inReplyTo: reply_to.graphNodeId });
		}

		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		try {
			let ret = await octokit.pullRequests.createCommentReply({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber,
				body: body,
				in_reply_to: Number(reply_to.id)
			});

			return this.addCommentPermissions(convertPullRequestsGetCommentsResponseItemToComment(ret.data), remote);
		} catch (e) {
			this.handleError(e);
		}
	}

	async deleteReview(pullRequest: PullRequestModel): Promise<{ deletedReviewId: number, deletedReviewComments: Comment[] }> {
		const pendingReviewId = await this.getPendingReviewId(pullRequest);
		const { mutate } = await pullRequest.githubRepository.ensure();
		const { data } = await mutate<DeleteReviewResponse>({
			mutation: queries.DeleteReview,
			variables: {
				input: { pullRequestReviewId: pendingReviewId }
			}
		});

		const { comments, databaseId } = data!.deletePullRequestReview.pullRequestReview;

		pullRequest.inDraftMode = false;

		return {
			deletedReviewId: databaseId,
			deletedReviewComments: comments.nodes.map(parseGraphQLComment)
		};
	}

	async startReview(pullRequest: PullRequestModel): Promise<void> {
		const { mutate } = await pullRequest.githubRepository.ensure();
		await mutate<void>({
			mutation: queries.StartReview,
			variables: {
				input: {
					body: '',
					pullRequestId: pullRequest.prItem.nodeId
				}
			}
		}).then(x => x.data).catch(e => {
			Logger.appendLine(`Failed to start review: ${e.message}`);
		});

		pullRequest.inDraftMode = true;

		return;
	}

	async inDraftMode(pullRequest: PullRequestModel): Promise<boolean> {
		let inDraftMode = !!await this.getPendingReviewId(pullRequest);
		if (inDraftMode !== pullRequest.inDraftMode) {
			pullRequest.inDraftMode = inDraftMode;
		}

		return inDraftMode;
	}

	async getPendingReviewId(pullRequest = this._activePullRequest): Promise<string | undefined> {
		if (!pullRequest) {
			return undefined;
		}

		if (!pullRequest.githubRepository.supportsGraphQl) {
			return;
		}

		const { query, octokit } = await pullRequest.githubRepository.ensure();
		const { currentUser = '' } = octokit as any;
		try {
			const { data } = await query<PendingReviewIdResponse>({
				query: queries.GetPendingReviewId,
				variables: {
					pullRequestId: (pullRequest as PullRequestModel).prItem.nodeId,
					author: currentUser.login
				}
			});
			return data.node.reviews.nodes[0].id;
		} catch (error) {
			return;
		}
	}

	async addCommentToPendingReview(pullRequest: PullRequestModel, reviewId: string, body: string, position: NewCommentPosition | ReplyCommentPosition): Promise<Comment> {
		const { mutate } = await pullRequest.githubRepository.ensure();
		const { data } = await mutate<AddCommentResponse>({
			mutation: queries.AddComment,
			variables: {
				input: {
					pullRequestReviewId: reviewId,
					body,
					...position
				}
			}
		});

		const { comment } = data!.addPullRequestReviewComment;
		return parseGraphQLComment(comment);
	}

	async addCommentReaction(pullRequest: PullRequestModel, graphNodeId: string, reaction: vscode.CommentReaction): Promise<AddReactionResponse> {
		let reactionEmojiToContent = getReactionGroup().reduce((prev, curr) => {
			prev[curr.label] = curr.title;
			return prev;
		}, {} as { [key: string]: string });
		const { mutate } = await pullRequest.githubRepository.ensure();
		const { data } = await mutate<AddReactionResponse>({
			mutation: queries.AddReaction,
			variables: {
				input: {
					subjectId: graphNodeId,
					content: reactionEmojiToContent[reaction.label!]
				}
			}
		});

		return data!;
	}

	async deleteCommentReaction(pullRequest: PullRequestModel, graphNodeId: string, reaction: vscode.CommentReaction): Promise<DeleteReactionResponse> {
		let reactionEmojiToContent = getReactionGroup().reduce((prev, curr) => {
			prev[curr.label] = curr.title;
			return prev;
		}, {} as { [key: string]: string });
		const { mutate } = await pullRequest.githubRepository.ensure();
		const { data } = await mutate<DeleteReactionResponse>({
			mutation: queries.DeleteReaction,
			variables: {
				input: {
					subjectId: graphNodeId,
					content: reactionEmojiToContent[reaction.label!]
				}
			}
		});

		return data!;
	}

	async createComment(pullRequest: PullRequestModel, body: string, commentPath: string, position: number): Promise<Comment | undefined> {
		const pendingReviewId = await this.getPendingReviewId(pullRequest as PullRequestModel);
		if (pendingReviewId) {
			return this.addCommentToPendingReview(pullRequest as PullRequestModel, pendingReviewId, body, { path: commentPath, position });
		}

		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		try {
			let ret = await octokit.pullRequests.createComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber,
				body: body,
				commit_id: pullRequest.head.sha,
				path: commentPath,
				position: position
			});

			return this.addCommentPermissions(convertPullRequestsGetCommentsResponseItemToComment(ret.data), remote);
		} catch (e) {
			this.handleError(e);
		}
	}

	async getPullRequestDefaults(): Promise<Github.PullRequestsCreateParams> {
		if (!this.repository.state.HEAD) {
			throw new DetachedHeadError(this.repository);
		}
		const { origin } = this;
		const meta = await origin.getMetadata();
		const parent = meta.fork
			? meta.parent
			: await (this.findRepo(byRemoteName('upstream')) || origin).getMetadata();
		const branchName = this.repository.state.HEAD.name;
		const { title, body } = titleAndBodyFrom(await this.getHeadCommitMessage());
		return {
			title, body,
			owner: parent.owner.login,
			repo: parent.name,
			head: `${meta.owner.login}:${branchName}`,
			base: parent.default_branch,
		};
	}

	async getMetadata(remote: string): Promise<any> {
		const repo = this.findRepo(byRemoteName(remote));
		return repo && repo.getMetadata();
	}

	async getHeadCommitMessage(): Promise<string> {
		const { repository } = this;
		if (repository.state.HEAD && repository.state.HEAD.commit) {
			const { message } = await repository.getCommit(repository.state.HEAD.commit);
			return message;
		}

		return '';
	}

	get origin(): GitHubRepository {
		if (!this._githubRepositories.length) {
			throw new NoGitHubReposError(this.repository);
		}

		const { upstreamRef } = this;
		if (upstreamRef) {
			// If our current branch has an upstream ref set, find its GitHubRepository.
			const upstream = this.findRepo(byRemoteName(upstreamRef.remote));
			if (!upstream) {
				// No GitHubRepository? We currently won't try pushing elsewhere,
				// so fail.
				throw new BadUpstreamError(
					this.repository.state.HEAD!.name!,
					upstreamRef,
					'is not a GitHub repo');
			}
			// Otherwise, we'll push upstream.
			return upstream;
		}

		// If no upstream is set, let's go digging.
		const [first, ...rest] = this._githubRepositories;
		return !rest.length  // Is there only one GitHub remote?
			? first // I GUESS THAT'S WHAT WE'RE GOING WITH, THEN.
			:  // Otherwise, let's try...
			this.findRepo(byRemoteName('origin')) || // by convention
			this.findRepo(ownedByMe) ||              // bc maybe we can push there
			first; // out of raw desperation
	}

	findRepo(where: Predicate<GitHubRepository>): GitHubRepository | undefined {
		return this._githubRepositories.filter(where)[0];
	}

	get upstreamRef(): UpstreamRef | undefined {
		const { HEAD } = this.repository.state;
		return HEAD && HEAD.upstream;
	}

	async createPullRequest(params: Github.PullRequestsCreateParams): Promise<PullRequestModel | undefined> {
		try {
			const repo = this._githubRepositories.find(r => r.remote.owner === params.owner && r.remote.repositoryName === params.repo);
			if (!repo) {
				throw new Error(`No matching repository ${params.repo} found for ${params.owner}`);
			}

			await repo.ensure();

			const { title, body } = titleAndBodyFrom(await this.getHeadCommitMessage());
			if (!params.title) {
				params.title = title;
			}

			if (!params.body) {
				params.body = body;
			}

			// Create PR
			let { data } = await repo.octokit.pullRequests.create(params);
			const item = convertRESTPullRequestToRawPullRequest(data);
			const pullRequestModel = new PullRequestModel(repo, repo.remote, item);

			const branchNameSeparatorIndex = params.head.indexOf(':');
			const branchName = params.head.slice(branchNameSeparatorIndex + 1);
			await PullRequestGitHelper.associateBranchWithPullRequest(this._repository, pullRequestModel, branchName);

			return pullRequestModel;
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Creating pull requests failed: ${e}`);
			vscode.window.showWarningMessage(`Creating pull requests for '${params.head}' failed: ${formatError(e)}`);
		}
	}

	async editIssueComment(pullRequest: PullRequestModel, commentId: string, text: string): Promise<Comment> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			const ret = await octokit.issues.editComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				body: text,
				comment_id: Number(commentId)
			});

			return this.addCommentPermissions(convertIssuesCreateCommentResponseToComment(ret.data), remote);
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async editReviewComment(pullRequest: PullRequestModel, comment: Comment, text: string): Promise<Comment> {
		try {
			if (comment.isDraft) {
				return this.editPendingReviewComment(pullRequest, comment.graphNodeId, text);
			}

			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			const ret = await octokit.pullRequests.editComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				body: text,
				comment_id: comment.id
			});

			return this.addCommentPermissions(convertPullRequestsGetCommentsResponseItemToComment(ret.data), remote);
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	private async editPendingReviewComment(pullRequest: PullRequestModel, commentNodeId: string, text: string): Promise<Comment> {
		const { mutate } = await pullRequest.githubRepository.ensure();

		const { data } = await mutate<EditCommentResponse>({
			mutation: queries.EditComment,
			variables: {
				input: {
					pullRequestReviewCommentId: commentNodeId,
					body: text
				}
			}
		});

		return parseGraphQLComment(data!.updatePullRequestReviewComment.pullRequestReviewComment);
	}

	async deleteIssueComment(pullRequest: PullRequestModel, commentId: string): Promise<void> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			await octokit.issues.deleteComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				comment_id: Number(commentId)
			});
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async deleteReviewComment(pullRequest: PullRequestModel, commentId: string): Promise<void> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			await octokit.pullRequests.deleteComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				comment_id: Number(commentId)
			});
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	canEditPullRequest(pullRequest: PullRequestModel): boolean {
		const username = pullRequest.author && pullRequest.author.login;
		return this._credentialStore.isCurrentUser(username, pullRequest.remote);
	}

	private addCommentPermissions(rawComment: Comment, remote: Remote): Comment {
		const isCurrentUser = this._credentialStore.isCurrentUser(rawComment.user!.login, remote);
		const notOutdated = rawComment.position !== null;
		rawComment.canEdit = isCurrentUser && notOutdated;
		rawComment.canDelete = isCurrentUser && notOutdated;

		return rawComment;
	}

	private async changePullRequestState(state: 'open' | 'closed', pullRequest: PullRequestModel): Promise<Github.PullRequestsUpdateResponse> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		let ret = await octokit.pullRequests.update({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			state: state
		});

		return ret.data;
	}

	async editPullRequest(pullRequest: PullRequestModel, toEdit: IPullRequestEditData): Promise<Github.PullRequestsUpdateResponse> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();
			const { data } = await octokit.pullRequests.update({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber,
				body: toEdit.body,
				title: toEdit.title
			});
			return data;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async closePullRequest(pullRequest: PullRequestModel): Promise<PullRequest> {
		return this.changePullRequestState('closed', pullRequest)
			.then(x => {
				this._telemetry.on('pr.close');
				return convertRESTPullRequestToRawPullRequest(x);
			});
	}

	async mergePullRequest(pullRequest: PullRequestModel, title?: string, description?: string, method?: 'merge' | 'squash' | 'rebase'): Promise<any> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();
		return await octokit.pullRequests.merge({
			commit_message: description,
			commit_title: title,
			merge_method: method || vscode.workspace.getConfiguration('githubPullRequests').get<'merge' | 'squash' | 'rebase'>('defaultMergeMethod'),
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
		})
			.then(x => {
				this._telemetry.on('pr.merge');
				return x.data;
			});
	}

	private async createReview(pullRequest: PullRequestModel, event: ReviewEvent, message?: string): Promise<CommonReviewEvent> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		const { data } = await octokit.pullRequests.createReview({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			event: event,
			body: message,
		});

		return convertRESTReviewEvent(data);
	}

	public async submitReview(pullRequest: PullRequestModel, event?: ReviewEvent, body?: string): Promise<CommonReviewEvent> {
		const pendingReviewId = await this.getPendingReviewId(pullRequest);
		const { mutate } = await pullRequest.githubRepository.ensure();

		if (pendingReviewId) {
			const { data } = await mutate<SubmitReviewResponse>({
				mutation: queries.SubmitReview,
				variables: {
					id: pendingReviewId,
					event: event || ReviewEvent.Comment,
					body
				}
			});

			pullRequest.inDraftMode = false;
			return parseGraphQLReviewEvent(data!.submitPullRequestReview.pullRequestReview);
		} else {
			throw new Error(`Submitting review failed, no pending review for current pull request: ${pullRequest.prNumber}.`);
		}
	}

	async requestChanges(pullRequest: PullRequestModel, message?: string): Promise<CommonReviewEvent> {
		const action: Promise<CommonReviewEvent> = await this.getPendingReviewId(pullRequest)
			? this.submitReview(pullRequest, ReviewEvent.RequestChanges, message)
			: this.createReview(pullRequest, ReviewEvent.RequestChanges, message);

		return action
			.then(x => {
				this._telemetry.on('pr.requestChanges');
				return x;
			});
	}

	async approvePullRequest(pullRequest: PullRequestModel, message?: string): Promise<CommonReviewEvent> {
		const action: Promise<CommonReviewEvent> = await this.getPendingReviewId(pullRequest)
			? this.submitReview(pullRequest, ReviewEvent.Approve, message)
			: this.createReview(pullRequest, ReviewEvent.Approve, message);

		return action.then(x => {
			this._telemetry.on('pr.approve');
			return x;
		});
	}

	async getPullRequestFileChangesInfo(pullRequest: PullRequestModel): Promise<IRawFileChange[]> {
		Logger.debug(`Fetch file changes, base, head and merge base of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		if (!pullRequest.base) {
			const info = await octokit.pullRequests.get({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber
			});
			pullRequest.update(convertRESTPullRequestToRawPullRequest(info.data));
		}

		const { data } = await octokit.repos.compareCommits({
			repo: remote.repositoryName,
			owner: remote.owner,
			base: `${pullRequest.base.repositoryCloneUrl.owner}:${pullRequest.base.ref}`,
			head: `${pullRequest.head.repositoryCloneUrl.owner}:${pullRequest.head.ref}`
		});

		pullRequest.mergeBase = data.merge_base_commit.sha;

		Logger.debug(`Fetch file changes and merge base of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);
		return data.files;
	}

	/**
	 * Add reviewers to a pull request
	 * @param pullRequest The pull request
	 * @param reviewers A list of GitHub logins
	 */
	async requestReview(pullRequest: PullRequestModel, reviewers: string[]): Promise<void> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();
		await octokit.pullRequests.createReviewRequest({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			reviewers
		});
	}

	async deleteRequestedReview(pullRequest: PullRequestModel, reviewer: string): Promise<void> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();
		await octokit.pullRequests.deleteReviewRequest({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			reviewers: [ reviewer ]
		});
	}

	async addLabels(pullRequest: PullRequestModel, labels: string[]): Promise<void> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();
		await octokit.issues.addLabels({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			labels
		});
	}

	async removeLabel(pullRequest: PullRequestModel, label: string): Promise<void> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();
		await octokit.issues.removeLabel({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			name: label
		});
	}

	async getPullRequestRepositoryDefaultBranch(pullRequest: PullRequestModel): Promise<string> {
		const branch = await pullRequest.githubRepository.getDefaultBranch();
		return branch;
	}

	async getPullRequestRepositoryMergeMethodsAvailability(pullRequest: PullRequestModel): Promise<MergeMethodsAvailability> {
		const mergeOptions = await pullRequest.githubRepository.getMergeMethodsAvailability();
		return mergeOptions;
	}

	async fullfillPullRequestMissingInfo(pullRequest: PullRequestModel): Promise<void> {
		try {
			Logger.debug(`Fullfill pull request missing info - start`, PullRequestManager.ID);
			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			if (!pullRequest.base) {
				const { data } = await octokit.pullRequests.get({
					owner: remote.owner,
					repo: remote.repositoryName,
					number: pullRequest.prNumber
				});
				pullRequest.update(convertRESTPullRequestToRawPullRequest(data));
			}

			if (!pullRequest.mergeBase) {
				const { data } = await octokit.repos.compareCommits({
					repo: remote.repositoryName,
					owner: remote.owner,
					base: `${pullRequest.base.repositoryCloneUrl.owner}:${pullRequest.base.ref}`,
					head: `${pullRequest.head.repositoryCloneUrl.owner}:${pullRequest.head.ref}`
				});

				pullRequest.mergeBase = data.merge_base_commit.sha;
			}
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching Pull Request merge base failed: ${formatError(e)}`);
		}
		Logger.debug(`Fullfill pull request missing info - done`, PullRequestManager.ID);
	}

	//#region Git related APIs

	async resolvePullRequest(owner: string, repositoryName: string, pullReuqestNumber: number): Promise<PullRequestModel | undefined> {
		const githubRepo = this._githubRepositories.find(repo =>
			repo.remote.owner.toLowerCase() === owner.toLowerCase() && repo.remote.repositoryName.toLowerCase() === repositoryName.toLowerCase()
		);

		if (!githubRepo) {
			return;
		}

		const pr = await githubRepo.getPullRequest(pullReuqestNumber);
		return pr;
	}

	async getMatchingPullRequestMetadataForBranch() {
		if (!this.repository || !this.repository.state.HEAD || !this.repository.state.HEAD.name) {
			return null;
		}

		let matchingPullRequestMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this.repository, this.repository.state.HEAD.name);
		return matchingPullRequestMetadata;
	}

	async checkoutExistingPullRequestBranch(pullRequest: PullRequestModel): Promise<boolean> {
		return await PullRequestGitHelper.checkoutExistingPullRequestBranch(this.repository, this._githubRepositories, pullRequest);
	}

	async fetchAndCheckout(pullRequest: PullRequestModel): Promise<void> {
		await PullRequestGitHelper.fetchAndCheckout(this.repository, this._githubRepositories, pullRequest);
	}

	async checkout(branchName: string): Promise<void> {
		return this.repository.checkout(branchName);
	}

	private handleError(e: any) {
		if (e.code && e.code === 422) {
			let errorObject: RestErrorResult;
			try {
				errorObject = e.message && JSON.parse(e.message);
			} catch {
				// If we failed to parse the JSON re-throw the original error
				// since it will have a more useful stack
				throw e;
			}
			const firstError = errorObject && errorObject.errors && errorObject.errors[0];
			if (firstError && firstError.code === 'missing_field' && firstError.field === 'body') {
				throw new Error('Body can\'t be blank');
			} else {
				throw new Error('There is already a pending review for this pull request on GitHub. Please finish or dismiss this review to be able to leave more comments');
			}

		} else {
			throw e;
		}
	}

	private async addReviewTimelineEventComments(pullRequest: PullRequestModel, events: TimelineEvent[]): Promise<void> {
		interface CommentNode extends Comment {
			childComments?: CommentNode[];
		}

		const reviewEvents = events.filter(isReviewEvent);
		const reviewComments = await this.getPullRequestComments(pullRequest) as CommentNode[];

		const reviewEventsById = reviewEvents.reduce((index, evt) => {
			index[evt.id] = evt;
			evt.comments = [];
			return index;
		}, {} as { [key: number]: CommonReviewEvent });

		const commentsById = reviewComments.reduce((index, evt) => {
			index[evt.id] = evt;
			return index;
		}, {} as { [key: number]: CommentNode });

		const roots: CommentNode[] = [];
		let i = reviewComments.length; while (i-- > 0) {
			const c: CommentNode = reviewComments[i];
			if (!c.inReplyToId) {
				roots.unshift(c);
				continue;
			}
			const parent = commentsById[c.inReplyToId];
			parent.childComments = parent.childComments || [];
			parent.childComments = [c, ...(c.childComments || []), ...parent.childComments];
		}

		roots.forEach(c => {
			const review = reviewEventsById[c.pullRequestReviewId!];
			review.comments = review.comments.concat(c).concat(c.childComments || []);
		});

		const pendingReview = reviewEvents.filter(r => r.state.toLowerCase() === 'pending')[0];
		if (pendingReview) {
			// Ensures that pending comments made in reply to other reviews are included for the pending review
			pendingReview.comments = reviewComments.filter(c => c.isDraft);
		}
	}

	private async fixCommitAttribution(pullRequest: PullRequestModel, events: TimelineEvent[]): Promise<void> {
		const commits = await this.getPullRequestCommits(pullRequest);
		const commitEvents = events.filter(isCommitEvent);
		for (let commitEvent of commitEvents) {
			const matchingCommits = commits.filter(commit => commit.sha === commitEvent.sha);
			if (matchingCommits.length === 1) {
				const author = matchingCommits[0].author;
				// There is not necessarily a GitHub account associated with the commit.
				if (author !== null) {
					commitEvent.author.avatarUrl = author.avatar_url;
					commitEvent.author.login = author.login;
					commitEvent.author.url = author.html_url;
				}
			}
		}
	}

	private async parseRESTTimelineEvents(pullRequest: PullRequestModel, remote: Remote, events: any[]): Promise<TimelineEvent[]> {
		events.forEach(event => {
			let type = getEventType(event.event);
			event.event = type;
			return event;
		});

		events.forEach(event => {
			if (event.event === EventType.Commented) {
				this.addCommentPermissions(event, remote);
			}
		});

		return Promise.all([
			this.addReviewTimelineEventComments(pullRequest, events),
			this.fixCommitAttribution(pullRequest, events)
		]).then(_ => {
			return events;
		});
	}
}

export function getEventType(text: string) {
	switch (text) {
		case 'committed':
			return EventType.Committed;
		case 'mentioned':
			return EventType.Mentioned;
		case 'subscribed':
			return EventType.Subscribed;
		case 'commented':
			return EventType.Commented;
		case 'reviewed':
			return EventType.Reviewed;
		default:
			return EventType.Other;
	}
}

const ownedByMe: Predicate<GitHubRepository> = repo => {
	const { currentUser = null } = repo.octokit as any;
	return currentUser && repo.remote.owner === currentUser.login;
};

const byRemoteName = (name: string): Predicate<GitHubRepository> =>
	({ remote: { remoteName } }) => remoteName === name;

const titleAndBodyFrom = (message: string): { title: string, body: string } => {
	const idxLineBreak = message.indexOf('\n');
	return {
		title: idxLineBreak === -1
			? message
			: message.substr(0, idxLineBreak),

		body: idxLineBreak === -1
			? ''
			: message.slice(idxLineBreak + 1),
	};
};
