import { default as assert } from 'assert';

import { MockRepository } from '../mocks/mockRepository';
import { PullRequestGitHelper } from '../../github/pullRequestGitHelper';
import { PullRequestModel } from '../../github/pullRequestModel';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { CredentialStore } from '../../github/credentials';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { SinonSandbox, createSandbox } from 'sinon';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { RefType } from '../../api/api';

describe('PullRequestGitHelper', function () {
	let sinon: SinonSandbox;
	let repository: MockRepository;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;

	beforeEach(function () {
		sinon = createSandbox();

		MockCommandRegistry.install(sinon);

		repository = new MockRepository();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('checkoutFromFork', function () {
		it('fetches, checks out, and configures a branch from a fork', async function () {
			const url = 'git@github.com:owner/name.git';
			const remote = new Remote('elsewhere', url, new Protocol(url));
			const gitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);

			const prItem = convertRESTPullRequestToRawPullRequest(
				new PullRequestBuilder()
					.number(100)
					.user(u => u.login('me'))
					.base(b => {
						b.repo(r => r.clone_url('git@github.com:owner/name.git'));
					})
					.head(h => {
						h.repo(r => r.clone_url('git@github.com:you/name.git'));
						h.ref('my-branch');
					})
					.build(),
				gitHubRepository,
			);

			repository.expectFetch('you', 'my-branch:pr/me/100', 1);
			repository.expectPull('you', 'my-branch:pr/me/100', true);

			const pullRequest = new PullRequestModel(telemetry, gitHubRepository, remote, prItem);

			if (!pullRequest.isResolved()) {
				assert(false, 'pull request head not resolved successfully');
			}

			await PullRequestGitHelper.checkoutFromFork(repository, pullRequest, undefined);

			assert.deepStrictEqual(repository.state.remotes, [
				{
					name: 'you',
					fetchUrl: 'git@github.com:you/name',
					pushUrl: 'git@github.com:you/name',
					isReadOnly: false,
				},
			]);
			assert.deepStrictEqual(repository.state.HEAD, {
				type: RefType.Head,
				name: 'pr/me/100',
				commit: undefined,
				upstream: {
					remote: 'you',
					name: 'my-branch',
				},
			});
			assert.strictEqual(await repository.getConfig('branch.pr/me/100.github-pr-owner-number'), 'owner#name#100');
		});
	});
});
