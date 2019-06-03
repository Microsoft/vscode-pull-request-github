import * as Octokit from '../../../common/octokit';
import { UserBuilder } from './userBuilder';
import { RefBuilder } from './refBuilder';
import { createLink, createBuilderClass } from '../base';

export type PullRequestUnion = Octokit.PullRequestsGetResponse;
type Links = PullRequestUnion['_links'];

export const PullRequestBuilder = createBuilderClass<PullRequestUnion>()({
	id: {default: 0},
	node_id: {default: 'node0'},
	number: {default: 1347},
	url: {default: 'https://api.github.com/repos/octocat/reponame/pulls/1347'},
	state: {default: 'open'},
	html_url: {default: 'https://github.com/octocat/reponame/pull/1347'},
	diff_url: {default: 'https://github.com/octocat/reponame/pull/1347.diff'},
	patch_url: {default: 'https://github.com/octocat/reponame/pull/1347.patch'},
	issue_url: {default: 'https://api.github.com/repos/octocat/reponame/issues/1347'},
	commits_url: {default: 'https://api.github.com/repos/octocat/reponame/pulls/1347/commits'},
	review_comments_url: {default: 'https://api.github.com/repos/octocat/reponame/pulls/1347/comments'},
	review_comment_url: {default: 'https://api.github.com/repos/octocat/reponame/pulls/comments{/number}'},
	comments_url: {default: 'https://api.github.com/repos/octocat/reponame/issues/1347/comments'},
	statuses_url: {default: 'https://api.github.com/repos/octocat/reponame/statuses/6dcb09b5b57875f334f61aebed695e2e4193db5e'},
	locked: {default: false},
	title: {default: 'New feature'},
	body: {default: 'Please merge thx'},
	user: {linked: UserBuilder},
	assignee: {linked: UserBuilder},
	labels: {default: []},
	active_lock_reason: {default: ''},
	created_at: {default: '2019-01-01T08:00:00Z'},
	updated_at: {default: '2019-01-01T08:00:00Z'},
	closed_at: {default: ''},
	merged_at: {default: ''},
	merge_commit_sha: {default: ''},
	head: {linked: RefBuilder},
	base: {linked: RefBuilder},
	merged: {default: false},
	mergeable: {default: true},
	merged_by: {linked: UserBuilder},
	comments: {default: 10},
	commits: {default: 5},
	additions: {default: 3},
	deletions: {default: 400},
	changed_files: {default: 10},
	maintainer_can_modify: {default: true},
	milestone: {default: null},
	_links: createLink<Links>()({
		self: createLink<Links['self']>()({
			href: {default: 'https://api.github.com/repos/octocat/reponame/pulls/1347'}
		}),
		html: createLink<Links['html']>()({
			href: {default: 'https://github.com/octocat/reponame/pull/1347'}
		}),
		issue: createLink<Links['issue']>()({
			href: {default: 'https://api.github.com/repos/octocat/reponame/issues/1347'}
		}),
		comments: createLink<Links['comments']>()({
			href: {default: 'https://api.github.com/repos/octocat/reponame/issues/1347/comments'}
		}),
		review_comments: createLink<Links['review_comments']>()({
			href: {default: 'https://api.github.com/repos/octocat/reponame/pulls/1347/comments'}
		}),
		review_comment: createLink<Links['review_comment']>()({
			href: {default: 'https://api.github.com/repos/octocat/reponame/pulls/comments{/number}'}
		}),
		commits: createLink<Links['commits']>()({
			href: {default: 'https://api.github.com/repos/octocat/reponame/pulls/1347/commits'}
		}),
		statuses: createLink<Links['statuses']>()({
			href: {default: 'https://api.github.com/repos/octocat/reponame/statuses/6dcb09b5b57875f334f61aebed695e2e4193db5e'}
		})
	}),
});

export type PullRequestBuilder = InstanceType<typeof PullRequestBuilder>;