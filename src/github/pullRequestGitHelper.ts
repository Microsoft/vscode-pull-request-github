/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Inspired by and includes code from GitHub/VisualStudio project, obtained from https://github.com/github/VisualStudio/blob/165a97bdcab7559e0c4393a571b9ff2aed4ba8a7/src/GitHub.App/Services/PullRequestService.cs
 */

import { Branch, Repository } from '../api/api';
import Logger from '../common/logger';
import { Protocol } from '../common/protocol';
import { parseRepositoryRemotes, Remote } from '../common/remote';
import { IResolvedPullRequestModel, PullRequestModel } from './pullRequestModel';

const PullRequestRemoteMetadataKey = 'github-pr-remote';
export const PullRequestMetadataKey = 'github-pr-owner-number';
const PullRequestBranchRegex = /branch\.(.+)\.github-pr-owner-number/;
const PullRequestRemoteRegex = /branch\.(.+)\.remote/;

export interface PullRequestMetadata {
	owner: string;
	repositoryName: string;
	prNumber: number;
}

export class PullRequestGitHelper {
	static ID = 'PullRequestGitHelper';
	static async checkoutFromFork(
		repository: Repository,
		pullRequest: PullRequestModel & IResolvedPullRequestModel,
		remoteName: string | undefined,
	) {
		// the branch is from a fork
		const localBranchName = await PullRequestGitHelper.calculateUniqueBranchNameForPR(repository, pullRequest);

		// create remote for this fork
		if (!remoteName) {
			Logger.appendLine(
				`Branch ${localBranchName} is from a fork. Create a remote first.`,
				PullRequestGitHelper.ID,
			);
			remoteName = await PullRequestGitHelper.createRemote(
				repository,
				pullRequest.remote,
				pullRequest.head.repositoryCloneUrl,
			);
		}

		// fetch the branch
		const ref = `${pullRequest.head.ref}:${localBranchName}`;
		Logger.debug(`Fetch ${remoteName}/${pullRequest.head.ref}:${localBranchName} - start`, PullRequestGitHelper.ID);
		await repository.fetch(remoteName, ref, 1);
		Logger.debug(`Fetch ${remoteName}/${pullRequest.head.ref}:${localBranchName} - done`, PullRequestGitHelper.ID);
		await repository.checkout(localBranchName);
		// set remote tracking branch for the local branch
		await repository.setBranchUpstream(localBranchName, `refs/remotes/${remoteName}/${pullRequest.head.ref}`);
		await this.unshallow(repository, remoteName, ref);
		PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest, localBranchName);
	}

	static async fetchAndCheckout(
		repository: Repository,
		remotes: Remote[],
		pullRequest: PullRequestModel,
	): Promise<void> {
		if (!pullRequest.validatePullRequestModel('Checkout pull request failed')) {
			return;
		}

		const remote = PullRequestGitHelper.getHeadRemoteForPullRequest(remotes, pullRequest);
		const isFork = pullRequest.head.repositoryCloneUrl.owner !== pullRequest.base.repositoryCloneUrl.owner;
		if (!remote || isFork) {
			return PullRequestGitHelper.checkoutFromFork(repository, pullRequest, remote && remote.remoteName);
		}

		const branchName = pullRequest.head.ref;
		const remoteName = remote.remoteName;
		let branch: Branch;

		try {
			branch = await repository.getBranch(branchName);
			Logger.debug(`Checkout ${branchName}`, PullRequestGitHelper.ID);
			await repository.checkout(branchName);

			if (!branch.upstream) {
				// this branch is not associated with upstream yet
				const trackedBranchName = `refs/remotes/${remoteName}/${branchName}`;
				await repository.setBranchUpstream(branchName, trackedBranchName);
			}

			if (branch.behind !== undefined && branch.behind > 0 && branch.ahead === 0) {
				Logger.debug(`Pull from upstream`, PullRequestGitHelper.ID);
				await repository.pull({remote: remoteName, ref: branchName});
			}
		} catch (err) {
			// there is no local branch with the same name, so we are good to fetch, create and checkout the remote branch.
			Logger.appendLine(
				`Branch ${remoteName}/${branchName} doesn't exist on local disk yet.`,
				PullRequestGitHelper.ID,
			);
			const trackedBranchName = `refs/remotes/${remoteName}/${branchName}`;
			Logger.appendLine(`Fetch tracked branch ${trackedBranchName}`, PullRequestGitHelper.ID);
			await repository.fetch(remoteName, branchName, 1);
			const trackedBranch = await repository.getBranch(trackedBranchName);
			// create branch
			await repository.createBranch(branchName, true, trackedBranch.commit);
			await repository.setBranchUpstream(branchName, trackedBranchName);
			await this.unshallow(repository, remoteName, branchName);
		}

		await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest, branchName);
	}

	/**
	 * Attempt to unshallow the repository. If it has been unshallowed in the interim, running with `--unshallow`
	 * will fail, so fall back to a normal pull.
	 */
	static async unshallow(repository: Repository, remoteName: string, branchName: string): Promise<void> {
		try {
			await repository.pull({remote: remoteName, ref: branchName, unshallow: true});
		} catch (e) {
			Logger.appendLine(`Unshallowing failed: ${e}. Falling back to git pull`);
			await repository.pull({remote: remoteName, ref: branchName});
		}
	}

	static async checkoutExistingPullRequestBranch(repository: Repository, pullRequest: PullRequestModel) {
		const key = PullRequestGitHelper.buildPullRequestMetadata(pullRequest);
		const configs = await repository.getConfigs();

		const readConfig = (searchKey: string): string | undefined =>
			configs.filter(({ key: k }) => searchKey === k).map(({ value }) => value)[0];

		const branchInfos = configs
			.map(config => {
				const matches = PullRequestBranchRegex.exec(config.key);
				return {
					branch: matches && matches.length ? matches[1] : null,
					value: config.value,
				};
			})
			.filter(c => c.branch && c.value === key);

		if (branchInfos && branchInfos.length) {
			// let's immediately checkout to branchInfos[0].branch
			const branchName = branchInfos[0].branch!;
			await repository.checkout(branchName);
			const remote = readConfig(`branch.${branchName}.remote`);
			const ref = readConfig(`branch.${branchName}.merge`);
			await repository.fetch(remote, ref);
			const branchStatus = await repository.getBranch(branchInfos[0].branch!);
			if (branchStatus.behind !== undefined && branchStatus.behind > 0 && branchStatus.ahead === 0) {
				Logger.debug(`Pull from upstream`, PullRequestGitHelper.ID);
				await repository.pull();
			}

			return true;
		} else {
			return false;
		}
	}

	static async getBranchNRemoteForPullRequest(
		repository: Repository,
		pullRequest: PullRequestModel,
	): Promise<{
		branch: string;
		remote?: string;
		createdForPullRequest?: boolean;
		remoteInUse?: boolean;
	} | null> {
		const key = PullRequestGitHelper.buildPullRequestMetadata(pullRequest);
		const configs = await repository.getConfigs();

		const branchInfo = configs
			.map(config => {
				const matches = PullRequestBranchRegex.exec(config.key);
				return {
					branch: matches && matches.length ? matches[1] : null,
					value: config.value,
				};
			})
			.find(c => !!c.branch && c.value === key);

		if (branchInfo) {
			// we find the branch
			const branchName = branchInfo.branch;

			try {
				const configKey = `branch.${branchName}.remote`;
				const branchRemotes = configs.filter(config => config.key === configKey).map(config => config.value);
				let remoteName: string | undefined = undefined;
				if (branchRemotes.length) {
					remoteName = branchRemotes[0];
				}

				let createdForPullRequest = false;
				if (remoteName) {
					const remoteCreatedForPullRequestKey = `remote.${remoteName}.github-pr-remote`;
					const remoteCreatedForPullRequest = configs.filter(
						config => config.key === remoteCreatedForPullRequestKey && config.value,
					);

					if (remoteCreatedForPullRequest.length) {
						// it's created for pull request
						createdForPullRequest = true;
					}
				}

				let remoteInUse: boolean | undefined;
				if (createdForPullRequest) {
					// try to find other branches under this remote
					remoteInUse = configs.some(config => {
						const matches = PullRequestRemoteRegex.exec(config.key);

						if (matches && config.key !== `branch.${branchName}.remote` && config.value === remoteName!) {
							return true;
						}

						return false;
					});
				}

				return {
					branch: branchName!,
					remote: remoteName,
					createdForPullRequest,
					remoteInUse,
				};
			} catch (_) {
				return {
					branch: branchName!,
				};
			}
		}

		return null;
	}

	static buildPullRequestMetadata(pullRequest: PullRequestModel) {
		return `${pullRequest.base.repositoryCloneUrl.owner}#${pullRequest.base.repositoryCloneUrl.repositoryName}#${pullRequest.number}`;
	}

	static parsePullRequestMetadata(value: string): PullRequestMetadata | undefined {
		if (value) {
			const matches = /(.*)#(.*)#(.*)/g.exec(value);
			if (matches && matches.length === 4) {
				const [, owner, repo, prNumber] = matches;
				return {
					owner: owner,
					repositoryName: repo,
					prNumber: Number(prNumber),
				};
			}
		}
		return undefined;
	}

	static getMetadataKeyForBranch(branchName: string): string {
		return `branch.${branchName}.${PullRequestMetadataKey}`;
	}

	static async getMatchingPullRequestMetadataForBranch(
		repository: Repository,
		branchName: string,
	): Promise<PullRequestMetadata | undefined> {
		try {
			const configKey = this.getMetadataKeyForBranch(branchName);
			const configValue = await repository.getConfig(configKey);
			return PullRequestGitHelper.parsePullRequestMetadata(configValue);
		} catch (_) {
			return;
		}
	}

	static async createRemote(repository: Repository, baseRemote: Remote, cloneUrl: Protocol) {
		Logger.appendLine(`create remote for ${cloneUrl}.`, PullRequestGitHelper.ID);

		const remotes = parseRepositoryRemotes(repository);
		for (const remote of remotes) {
			if (new Protocol(remote.url).equals(cloneUrl)) {
				return remote.remoteName;
			}
		}

		const remoteName = PullRequestGitHelper.getUniqueRemoteName(repository, cloneUrl.owner);
		cloneUrl.update({
			type: baseRemote.gitProtocol.type,
		});
		await repository.addRemote(remoteName, cloneUrl.toString()!);
		await repository.setConfig(`remote.${remoteName}.${PullRequestRemoteMetadataKey}`, 'true');
		return remoteName;
	}

	static async isRemoteCreatedForPullRequest(repository: Repository, remoteName: string) {
		try {
			Logger.debug(
				`Check if remote '${remoteName}' is created for pull request - start`,
				PullRequestGitHelper.ID,
			);
			const isForPR = await repository.getConfig(`remote.${remoteName}.${PullRequestRemoteMetadataKey}`);
			Logger.debug(`Check if remote '${remoteName}' is created for pull request - end`, PullRequestGitHelper.ID);
			return isForPR === 'true';
		} catch (_) {
			return false;
		}
	}

	static async calculateUniqueBranchNameForPR(
		repository: Repository,
		pullRequest: PullRequestModel,
	): Promise<string> {
		const branchName = `pr/${pullRequest.author.login}/${pullRequest.number}`;
		let result = branchName;
		let number = 1;

		while (true) {
			try {
				await repository.getBranch(result);
				result = `${branchName}-${number++}`;
			} catch (err) {
				break;
			}
		}

		return result;
	}

	static getUniqueRemoteName(repository: Repository, name: string) {
		let uniqueName = name;
		let number = 1;
		const remotes = parseRepositoryRemotes(repository);

		// eslint-disable-next-line no-loop-func
		while (remotes.find(e => e.remoteName === uniqueName)) {
			uniqueName = `${name}${number++}`;
		}

		return uniqueName;
	}

	static getHeadRemoteForPullRequest(
		remotes: Remote[],
		pullRequest: PullRequestModel & IResolvedPullRequestModel,
	): Remote | undefined {
		return remotes.find(
			remote => remote.gitProtocol && remote.gitProtocol.equals(pullRequest.head.repositoryCloneUrl),
		);
	}

	static async associateBranchWithPullRequest(
		repository: Repository,
		pullRequest: PullRequestModel,
		branchName: string,
	) {
		Logger.appendLine(`associate ${branchName} with Pull Request #${pullRequest.number}`, PullRequestGitHelper.ID);
		const prConfigKey = `branch.${branchName}.${PullRequestMetadataKey}`;
		await repository.setConfig(prConfigKey, PullRequestGitHelper.buildPullRequestMetadata(pullRequest));
	}
}
