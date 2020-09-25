import { createBuilderClass } from '../../../src/test/builders/base';
import { PullRequest } from '../../cache';
import { GithubItemStateEnum, PullRequestMergeability } from '../../../src/github/interface';
import { CombinedStatusBuilder } from '../../../src/test/builders/rest/combinedStatusBuilder';

import { AccountBuilder } from './account';

export const PullRequestBuilder = createBuilderClass<PullRequest>()({
	number: { default: 1234 },
	title: { default: 'the default title' },
	url: { default: 'https://github.com/owner/name/pulls/1234' },
	createdAt: { default: '2019-01-01T10:00:00Z' },
	body: { default: 'the *default* body' },
	bodyHTML: { default: 'the <b>default</b> body' },
	author: { linked: AccountBuilder },
	state: { default: GithubItemStateEnum.Open },
	events: { default: [] },
	isCurrentlyCheckedOut: { default: true },
	base: { default: 'master' },
	head: { default: 'my-fork:my-branch' },
	labels: { default: [] },
	commitsCount: { default: 10 },
	repositoryDefaultBranch: { default: 'master' },
	canEdit: { default: true },
	hasWritePermission: { default: true },
	pendingCommentText: { default: null },
	pendingCommentDrafts: { default: null },
	status: { linked: CombinedStatusBuilder },
	mergeable: { default: PullRequestMergeability.Mergeable },
	defaultMergeMethod: { default: 'merge' },
	mergeMethodsAvailability: { default: { merge: true, squash: true, rebase: true } },
	reviewers: { default: [] },
	isDraft: { default: false },
	isIssue: { default: false },
	reviewState: {default: 'REQUESTED'}
});
