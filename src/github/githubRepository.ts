/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Octokit } from '@octokit/rest';
import * as OctokitTypes from '@octokit/types';
import { ApolloQueryResult, FetchResult, MutationOptions, NetworkStatus, QueryOptions } from 'apollo-boost';
import * as vscode from 'vscode';
import { AuthenticationError } from '../common/authentication';
import Logger from '../common/logger';
import { Protocol } from '../common/protocol';
import { parseRemote, Remote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { PRCommentController } from '../view/prCommentController';
import { OctokitCommon } from './common';
import { CredentialStore, GitHub } from './credentials';
import {
	AssignableUsersResponse,
	ForkDetailsResponse,
	IssuesResponse,
	IssuesSearchResponse,
	MaxIssueResponse,
	MentionableUsersResponse,
	MilestoneIssuesResponse,
	PullRequestResponse,
	ViewerPermissionResponse,
} from './graphql';
import { IAccount, IMilestone, Issue, RepoAccessAndMergeMethods } from './interface';
import { IssueModel } from './issueModel';
import { PullRequestModel } from './pullRequestModel';
import defaultSchema from './queries.gql';
import {
	convertRESTPullRequestToRawPullRequest,
	getPRFetchQuery,
	parseGraphQLIssue,
	parseGraphQLPullRequest,
	parseGraphQLViewerPermission,
	parseMilestone,
} from './utils';

export const PULL_REQUEST_PAGE_SIZE = 20;

const GRAPHQL_COMPONENT_ID = 'GraphQL';

export interface ItemsData {
	items: any[];
	hasMorePages: boolean;
}

export interface IssueData extends ItemsData {
	items: IssueModel[];
	hasMorePages: boolean;
}

export interface PullRequestData extends IssueData {
	items: PullRequestModel[];
}

export interface MilestoneData extends ItemsData {
	items: { milestone: IMilestone; issues: IssueModel[] }[];
	hasMorePages: boolean;
}

export enum ViewerPermission {
	Unknown = 'unknown',
	Admin = 'ADMIN',
	Maintain = 'MAINTAIN',
	Read = 'READ',
	Triage = 'TRIAGE',
	Write = 'WRITE',
}

export interface ForkDetails {
	isFork: boolean;
	parent: {
		owner: string;
		name: string;
	};
}

export interface IMetadata extends OctokitCommon.ReposGetResponseData {
	currentUser: any;
}

export class GitHubRepository implements vscode.Disposable {
	static ID = 'GitHubRepository';
	protected _initialized: boolean = false;
	protected _hub: GitHub | undefined;
	protected _metadata: IMetadata | undefined;
	private _toDispose: vscode.Disposable[] = [];
	public commentsController?: vscode.CommentController;
	public commentsHandler?: PRCommentController;
	public readonly isGitHubDotCom: boolean;

	public get hub(): GitHub {
		if (!this._hub) {
			if (!this._initialized) {
				throw new Error('Call ensure() before accessing this property.');
			} else {
				throw new AuthenticationError('Not authenticated.');
			}
		}
		return this._hub;
	}

	public equals(repo: GitHubRepository): boolean {
		return this.remote.equals(repo.remote);
	}

	public async ensureCommentsController(): Promise<void> {
		try {
			if (this.commentsController) {
				return;
			}

			await this.ensure();
			this.commentsController = vscode.comments.createCommentController(
				`browse-${this.remote.normalizedHost}`,
				`GitHub Pull Request for ${this.remote.normalizedHost}`,
			);
			this.commentsHandler = new PRCommentController(this.commentsController);
			this._toDispose.push(this.commentsController);
			this._toDispose.push(this.commentsController);
		} catch (e) {
			console.log(e);
		}
	}

	dispose() {
		this._toDispose.forEach(d => d.dispose());
	}

	public get octokit(): Octokit {
		return this.hub && this.hub.octokit;
	}

	constructor(
		public remote: Remote,
		private readonly _credentialStore: CredentialStore,
		private readonly _telemetry: ITelemetry,
	) {
		this.isGitHubDotCom = remote.host.toLowerCase() === 'github.com';
	}

	query = async <T>(query: QueryOptions): Promise<ApolloQueryResult<T>> => {
		const gql = this.hub && this.hub.graphql;
		if (!gql) {
			Logger.debug(`Not available for query: ${query}`, GRAPHQL_COMPONENT_ID);
			return {
				data: null,
				loading: false,
				networkStatus: NetworkStatus.error,
				stale: false,
			} as any;
		}

		Logger.debug(`Request: ${JSON.stringify(query, null, 2)}`, GRAPHQL_COMPONENT_ID);
		const rsp = await gql.query<T>(query);
		Logger.debug(`Response: ${JSON.stringify(rsp, null, 2)}`, GRAPHQL_COMPONENT_ID);
		return rsp;
	};

	mutate = async <T>(mutation: MutationOptions<T>): Promise<FetchResult<T>> => {
		const gql = this.hub && this.hub.graphql;
		if (!gql) {
			Logger.debug(`Not available for query: ${mutation}`, GRAPHQL_COMPONENT_ID);
			return {
				data: null,
				loading: false,
				networkStatus: NetworkStatus.error,
				stale: false,
			} as any;
		}

		Logger.debug(`Request: ${JSON.stringify(mutation, null, 2)}`, GRAPHQL_COMPONENT_ID);
		const rsp = await gql.mutate<T>(mutation);
		Logger.debug(`Response: ${JSON.stringify(rsp, null, 2)}`, GRAPHQL_COMPONENT_ID);
		return rsp;
	};

	get schema() {
		return defaultSchema as any;
	}

	async getMetadata(): Promise<any> {
		Logger.debug(`Fetch metadata - enter`, GitHubRepository.ID);
		if (this._metadata) {
			Logger.debug(
				`Fetch metadata ${this._metadata.owner.login}/${this._metadata.name} - done`,
				GitHubRepository.ID,
			);
			return this._metadata;
		}
		const { octokit, remote } = await this.ensure();
		const result = await octokit.repos.get({
			owner: remote.owner,
			repo: remote.repositoryName,
		});
		Logger.debug(`Fetch metadata ${remote.owner}/${remote.repositoryName} - done`, GitHubRepository.ID);
		this._metadata = ({ ...result.data, currentUser: (octokit as any).currentUser } as unknown) as IMetadata;
		return this._metadata;
	}

	async resolveRemote(): Promise<void> {
		try {
			const { clone_url } = await this.getMetadata();
			this.remote = parseRemote(this.remote.remoteName, clone_url, this.remote.gitProtocol)!;
		} catch (e) {
			Logger.appendLine(`Unable to resolve remote: ${e}`);
		}
	}

	async ensure(): Promise<GitHubRepository> {
		this._initialized = true;

		if (!this._credentialStore.isAuthenticated()) {
			this._hub = await this._credentialStore.showSignInNotification();
		} else {
			this._hub = this._credentialStore.getHub();
		}

		return this;
	}

	async getDefaultBranch(): Promise<string> {
		try {
			Logger.debug(`Fetch default branch - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const { data } = await octokit.repos.get({
				owner: remote.owner,
				repo: remote.repositoryName,
			});
			Logger.debug(`Fetch default branch - done`, GitHubRepository.ID);

			return data.default_branch;
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Fetching default branch failed: ${e}`);
		}

		return 'master';
	}

	async getRepoAccessAndMergeMethods(): Promise<RepoAccessAndMergeMethods> {
		try {
			Logger.debug(`Fetch repo permissions and available merge methods - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const { data } = await octokit.repos.get({
				owner: remote.owner,
				repo: remote.repositoryName,
			});
			Logger.debug(`Fetch repo permissions and available merge methods - done`, GitHubRepository.ID);

			return {
				// Users with push access to repo have rights to merge/close PRs,
				// edit title/description, assign reviewers/labels etc.
				hasWritePermission: data.permissions?.push ?? false,
				mergeMethodsAvailability: {
					merge: data.allow_merge_commit ?? false,
					squash: data.allow_squash_merge ?? false,
					rebase: data.allow_rebase_merge ?? false,
				},
			};
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Fetching repo permissions and available merge methods failed: ${e}`);
		}

		return {
			hasWritePermission: true,
			mergeMethodsAvailability: {
				merge: true,
				squash: true,
				rebase: true,
			},
		};
	}

	async getAllPullRequests(page?: number): Promise<PullRequestData | undefined> {
		try {
			Logger.debug(`Fetch all pull requests - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const result = await octokit.pulls.list({
				owner: remote.owner,
				repo: remote.repositoryName,
				per_page: PULL_REQUEST_PAGE_SIZE,
				page: page || 1,
			});

			const hasMorePages = !!result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
			if (!result.data) {
				// We really don't expect this to happen, but it seems to (see #574).
				// Log a warning and return an empty set.
				Logger.appendLine(
					`Warning: no result data for ${remote.owner}/${remote.repositoryName} Status: ${result.status}`,
				);
				return {
					items: [],
					hasMorePages: false,
				};
			}

			const pullRequests = result.data
				.map(pullRequest => {
					if (!pullRequest.head.repo) {
						Logger.appendLine('GitHubRepository> The remote branch for this PR was already deleted.');
						return null;
					}

					return new PullRequestModel(
						this._telemetry,
						this,
						this.remote,
						convertRESTPullRequestToRawPullRequest(pullRequest, this),
					);
				})
				.filter(item => item !== null) as PullRequestModel[];

			Logger.debug(`Fetch all pull requests - done`, GitHubRepository.ID);
			return {
				items: pullRequests,
				hasMorePages,
			};
		} catch (e) {
			Logger.appendLine(`Fetching all pull requests failed: ${e}`, GitHubRepository.ID);
			if (e.code === 404) {
				// not found
				vscode.window.showWarningMessage(
					`Fetching pull requests for remote '${this.remote.remoteName}' failed, please check if the url ${this.remote.url} is valid.`,
				);
			} else {
				throw e;
			}
		}
		return undefined;
	}

	async getPullRequestForBranch(branch: string): Promise<PullRequestModel[] | undefined> {
		try {
			Logger.debug(`Fetch pull requests for branch - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const result = await octokit.pulls.list({
				owner: remote.owner,
				repo: remote.repositoryName,
				head: `${remote.owner}:${branch}`,
			});

			const pullRequests = result.data
				.map(pullRequest => {
					return new PullRequestModel(
						this._telemetry,
						this,
						this.remote,
						convertRESTPullRequestToRawPullRequest(pullRequest as any, this),
					);
				})
				.filter(item => item !== null) as PullRequestModel[];

			Logger.debug(`Fetch pull requests for branch - done`, GitHubRepository.ID);
			return pullRequests;
		} catch (e) {
			Logger.appendLine(`Fetching pull requests for branch failed: ${e}`, GitHubRepository.ID);
			if (e.code === 404) {
				// not found
				vscode.window.showWarningMessage(
					`Fetching pull requests for remote '${this.remote.remoteName}' failed, please check if the url ${this.remote.url} is valid.`,
				);
			} else {
				throw e;
			}
		}

		return undefined;
	}

	private getRepoForIssue(githubRepository: GitHubRepository, parsedIssue: Issue): GitHubRepository {
		if (
			parsedIssue.repositoryName &&
			parsedIssue.repositoryUrl &&
			(githubRepository.remote.owner !== parsedIssue.repositoryOwner ||
				githubRepository.remote.repositoryName !== parsedIssue.repositoryName)
		) {
			const remote = new Remote(
				parsedIssue.repositoryName,
				parsedIssue.repositoryUrl,
				new Protocol(parsedIssue.repositoryUrl),
			);
			githubRepository = new GitHubRepository(remote, this._credentialStore, this._telemetry);
		}
		return githubRepository;
	}

	async getIssuesForUserByMilestone(page?: number): Promise<MilestoneData | undefined> {
		try {
			Logger.debug(`Fetch all issues - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<MilestoneIssuesResponse>({
				query: schema.GetMilestones,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					assignee: this._credentialStore.getCurrentUser().login,
				},
			});
			Logger.debug(`Fetch all issues - done`, GitHubRepository.ID);

			const milestones: { milestone: IMilestone; issues: IssueModel[] }[] = [];
			let githubRepository: GitHubRepository = this;
			if (data && data.repository.milestones && data.repository.milestones.nodes) {
				data.repository.milestones.nodes.forEach(raw => {
					const milestone = parseMilestone(raw);
					if (milestone) {
						const issues: IssueModel[] = [];
						raw.issues.edges.forEach(issue => {
							const parsedIssue = parseGraphQLIssue(issue.node, this);
							githubRepository = this.getRepoForIssue(githubRepository, parsedIssue);
							issues.push(new IssueModel(githubRepository, githubRepository.remote, parsedIssue));
						});
						milestones.push({ milestone, issues });
					}
				});
			}
			return {
				items: milestones,
				hasMorePages: data.repository.milestones.pageInfo.hasNextPage,
			};
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch issues: ${e}`);
			return;
		}
	}

	async getIssuesWithoutMilestone(page?: number): Promise<IssueData | undefined> {
		try {
			Logger.debug(`Fetch issues without milestone- enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<IssuesResponse>({
				query: schema.IssuesWithoutMilestone,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					assignee: this._credentialStore.getCurrentUser().login,
				},
			});
			Logger.debug(`Fetch issues without milestone - done`, GitHubRepository.ID);

			const issues: IssueModel[] = [];
			let githubRepository: GitHubRepository = this;
			if (data && data.repository.issues.edges) {
				data.repository.issues.edges.forEach(raw => {
					if (raw.node.id) {
						const parsedIssue = parseGraphQLIssue(raw.node, this);
						githubRepository = this.getRepoForIssue(githubRepository, parsedIssue);
						issues.push(new IssueModel(githubRepository, githubRepository.remote, parsedIssue));
					}
				});
			}
			return {
				items: issues,
				hasMorePages: data.repository.issues.pageInfo.hasNextPage,
			};
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch issues without milestone: ${e}`);
			return;
		}
	}

	async getIssues(page?: number, queryString?: string): Promise<IssueData | undefined> {
		try {
			Logger.debug(`Fetch issues with query - enter`, GitHubRepository.ID);
			const { query, schema } = await this.ensure();
			const { data } = await query<IssuesSearchResponse>({
				query: schema.Issues,
				variables: {
					query: `${queryString} type:issue`,
				},
			});
			Logger.debug(`Fetch issues with query - done`, GitHubRepository.ID);

			const issues: IssueModel[] = [];
			let githubRepository: GitHubRepository = this;
			if (data && data.search.edges) {
				data.search.edges.forEach(raw => {
					if (raw.node.id) {
						const parsedIssue = parseGraphQLIssue(raw.node, this);
						githubRepository = this.getRepoForIssue(githubRepository, parsedIssue);
						issues.push(new IssueModel(githubRepository, githubRepository.remote, parsedIssue));
					}
				});
			}
			return {
				items: issues,
				hasMorePages: data.search.pageInfo.hasNextPage,
			};
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch issues with query: ${e}`);
			return;
		}
	}

	async getMaxIssue(): Promise<number | undefined> {
		try {
			Logger.debug(`Fetch max issue - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<MaxIssueResponse>({
				query: schema.MaxIssue,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
				},
			});
			Logger.debug(`Fetch max issue - done`, GitHubRepository.ID);

			if (data && data.repository.issues.edges.length === 1) {
				return data.repository.issues.edges[0].node.number;
			}
			return;
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch issues with query: ${e}`);
			return;
		}
	}

	async getViewerPermission(): Promise<ViewerPermission> {
		try {
			Logger.debug(`Fetch viewer permission - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<ViewerPermissionResponse>({
				query: schema.GetViewerPermission,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
				},
			});
			Logger.debug(`Fetch viewer permission - done`, GitHubRepository.ID);
			return parseGraphQLViewerPermission(data);
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch viewer permission: ${e}`);
			return ViewerPermission.Unknown;
		}
	}

	async fork(): Promise<string | undefined> {
		try {
			Logger.debug(`Fork repository`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const result = await octokit.repos.createFork({
				owner: remote.owner,
				repo: remote.repositoryName,
			});
			return result.data.clone_url;
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Forking repository failed: ${e}`);
			return undefined;
		}
	}

	async getRepositoryForkDetails(): Promise<ForkDetails | undefined> {
		try {
			Logger.debug(`Fetch viewer permission - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<ForkDetailsResponse>({
				query: schema.GetViewerPermission,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
				},
			});
			Logger.debug(`Fetch viewer permission - done`, GitHubRepository.ID);
			return data.repository;
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch viewer permission: ${e}`);
			return;
		}
	}

	async getAuthenticatedUser(): Promise<string> {
		const { octokit } = await this.ensure();
		const user = await octokit.users.getAuthenticated({});
		return user.data.login;
	}

	async getPullRequestsForCategory(categoryQuery: string, page?: number): Promise<PullRequestData | undefined> {
		try {
			Logger.debug(`Fetch pull request category ${categoryQuery} - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const user = await octokit.users.getAuthenticated({});
			// Search api will not try to resolve repo that redirects, so get full name first
			const repo = await octokit.repos.get({ owner: this.remote.owner, repo: this.remote.repositoryName });
			const { data, headers } = await octokit.search.issuesAndPullRequests({
				q: getPRFetchQuery(repo.data.full_name, user.data.login, categoryQuery),
				per_page: PULL_REQUEST_PAGE_SIZE,
				page: page || 1,
			});
			const promises: Promise<OctokitTypes.OctokitResponse<OctokitCommon.PullsGetResponseData>>[] = [];
			data.items.forEach((item: any /** unluckily Octokit.AnyResponse */) => {
				promises.push(
					new Promise(async (resolve, reject) => {
						const prData = await octokit.pulls.get({
							owner: remote.owner,
							repo: remote.repositoryName,
							pull_number: item.number,
						});
						resolve(prData);
					}),
				);
			});

			const hasMorePages = !!headers.link && headers.link.indexOf('rel="next"') > -1;
			const pullRequestResponses = await Promise.all(promises);

			const pullRequests = pullRequestResponses
				.map(response => {
					if (!response.data.head.repo) {
						Logger.appendLine('GitHubRepository> The remote branch for this PR was already deleted.');
						return null;
					}

					return new PullRequestModel(
						this._telemetry,
						this,
						this.remote,
						convertRESTPullRequestToRawPullRequest(response.data, this),
					);
				})
				.filter(item => item !== null) as PullRequestModel[];

			Logger.debug(`Fetch pull request category ${categoryQuery} - done`, GitHubRepository.ID);

			return {
				items: pullRequests,
				hasMorePages,
			};
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Fetching all pull requests failed: ${e}`);
			if (e.code === 404) {
				// not found
				vscode.window.showWarningMessage(
					`Fetching pull requests for remote ${this.remote.remoteName}, please check if the url ${this.remote.url} is valid.`,
				);
			} else {
				throw e;
			}
		}
		return undefined;
	}

	async getPullRequest(id: number): Promise<PullRequestModel | undefined> {
		try {
			Logger.debug(`Fetch pull request ${id} - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();

			const { data } = await query<PullRequestResponse>({
				query: schema.PullRequest,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: id,
				},
			});
			Logger.debug(`Fetch pull request ${id} - done`, GitHubRepository.ID);

			return new PullRequestModel(this._telemetry, this, remote, parseGraphQLPullRequest(data, this));
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch PR: ${e}`);
			return;
		}
	}

	async getIssue(id: number, withComments: boolean = false): Promise<IssueModel | undefined> {
		try {
			Logger.debug(`Fetch issue ${id} - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();

			const { data } = await query<PullRequestResponse>({
				query: withComments ? schema.IssueWithComments : schema.Issue,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: id,
				},
			});
			Logger.debug(`Fetch issue ${id} - done`, GitHubRepository.ID);

			return new IssueModel(this, remote, parseGraphQLPullRequest(data, this));
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch PR: ${e}`);
			return;
		}
	}

	async listBranches(owner: string, repositoryName: string): Promise<string[]> {
		const { octokit } = await this.ensure();
		Logger.debug(`List branches for ${owner}/${repositoryName} - enter`, GitHubRepository.ID);

		try {
			const result = (await octokit.paginate<OctokitCommon.ReposListBranchesResponseData>(
				'GET /repos/:owner/:repo/branches',
				{
					owner: owner,
					repo: repositoryName,
					per_page: 100,
				},
			)) as any;

			Logger.debug(`List branches for ${owner}/${repositoryName} - done`, GitHubRepository.ID);
			return result.map(branch => branch.name);
		} catch (e) {
			Logger.debug(`List branches for ${owner}/${repositoryName} failed`, GitHubRepository.ID);
			throw e;
		}
	}

	async deleteBranch(pullRequestModel: PullRequestModel): Promise<void> {
		const { octokit } = await this.ensure();

		if (!pullRequestModel.validatePullRequestModel('Unable to delete branch')) {
			return;
		}

		try {
			await octokit.git.deleteRef({
				owner: pullRequestModel.head.repositoryCloneUrl.owner,
				repo: pullRequestModel.head.repositoryCloneUrl.repositoryName,
				ref: `heads/${pullRequestModel.head.ref}`,
			});
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to delete branch: ${e}`);
			return;
		}
	}

	async getMentionableUsers(): Promise<IAccount[]> {
		Logger.debug(`Fetch mentionable users - enter`, GitHubRepository.ID);
		const { query, remote, schema } = await this.ensure();

		let after = null;
		let hasNextPage = false;
		const ret: IAccount[] = [];

		do {
			try {
				const result: { data: MentionableUsersResponse } = await query<MentionableUsersResponse>({
					query: schema.GetMentionableUsers,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						first: 100,
						after: after,
					},
				});

				ret.push(
					...result.data.repository.mentionableUsers.nodes.map(node => {
						return {
							login: node.login,
							avatarUrl: node.avatarUrl,
							name: node.name,
							url: node.url,
							email: node.email,
						};
					}),
				);

				hasNextPage = result.data.repository.mentionableUsers.pageInfo.hasNextPage;
				after = result.data.repository.mentionableUsers.pageInfo.endCursor;
			} catch (e) {
				Logger.debug(`Unable to fetch mentionable users: ${e}`, GitHubRepository.ID);
				return ret;
			}
		} while (hasNextPage);

		return ret;
	}

	async getAssignableUsers(): Promise<IAccount[]> {
		Logger.debug(`Fetch assignable users - enter`, GitHubRepository.ID);
		const { query, remote, schema } = await this.ensure();

		let after = null;
		let hasNextPage = false;
		const ret: IAccount[] = [];

		do {
			try {
				const result: { data: AssignableUsersResponse } = await query<AssignableUsersResponse>({
					query: schema.GetAssignableUsers,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						first: 100,
						after: after,
					},
				});

				ret.push(
					...result.data.repository.assignableUsers.nodes.map(node => {
						return {
							login: node.login,
							avatarUrl: node.avatarUrl,
							name: node.name,
							url: node.url,
							email: node.email,
						};
					}),
				);

				hasNextPage = result.data.repository.assignableUsers.pageInfo.hasNextPage;
				after = result.data.repository.assignableUsers.pageInfo.endCursor;
			} catch (e) {
				Logger.debug(`Unable to fetch assignable users: ${e}`, GitHubRepository.ID);
				if (
					e.graphQLErrors &&
					e.graphQLErrors.length > 0 &&
					e.graphQLErrors[0].type === 'INSUFFICIENT_SCOPES'
				) {
					vscode.window.showWarningMessage(
						`GitHub user features will not work. ${e.graphQLErrors[0].message}`,
					);
				}
				return ret;
			}
		} while (hasNextPage);

		return ret;
	}

	/**
	 * Compare across commits.
	 * @param base The base branch. Must be a branch name. If comparing acrossing repositories, use the format <repo_owner>:branch.
	 * @param head The head branch. Must be a branch name. If comparing acrossing repositories, use the format <repo_owner>:branch.
	 */
	public async compareCommits(base: string, head: string): Promise<OctokitCommon.ReposCompareCommitsResponseData> {
		const { remote, octokit } = await this.ensure();
		const { data } = await octokit.repos.compareCommits({
			repo: remote.repositoryName,
			owner: remote.owner,
			base,
			head,
		});

		return data;
	}

	isCurrentUser(login: string): boolean {
		return this._credentialStore.isCurrentUser(login);
	}
}
