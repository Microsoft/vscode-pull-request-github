import * as OctokitRest from '@octokit/rest';
import { Endpoints } from '@octokit/types';

export namespace OctokitCommon {
	export type IssuesAssignParams = OctokitRest.RestEndpointMethodTypes['issues']['addAssignees']['parameters'];
	export type IssuesCreateParams = OctokitRest.RestEndpointMethodTypes['issues']['create']['parameters'];
	export type IssuesCreateResponseData = Endpoints['POST /repos/{owner}/{repo}/issues']['response']['data'];
	export type IssuesListCommentsResponseData = Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}/comments']['response']['data'];
	export type IssuesListEventsForTimelineResponseData = Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}/timeline']['response']['data'];
	export type IssuesListEventsForTimelineResponseItemActor = IssuesListEventsForTimelineResponseData[0]['actor'];
	export type PullsCreateParams = OctokitRest.RestEndpointMethodTypes['pulls']['create']['parameters'];
	export type PullsCreateResponseData = Endpoints['POST /repos/{owner}/{repo}/pulls']['response']['data'];
	export type PullsCreateReviewResponseData = Endpoints['POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews']['response']['data'];
	export type PullsCreateReviewCommentResponseData = Endpoints['POST /repos/{owner}/{repo}/pulls/{pull_number}/comments']['response']['data'];
	export type PullsGetResponseData = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response']['data'];
	export type PullsGetResponseUser = PullsGetResponseData['user'];
	export type PullsListCommitsResponseData = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/commits']['response']['data'];
	export type PullsListRequestedReviewersResponseData = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers']['response']['data'];
	export type PullsListResponseItem = Endpoints['GET /repos/{owner}/{repo}/pulls']['response']['data'][0];
	export type PullsListResponseItemHead = PullsListResponseItem['head'];
	export type PullsListResponseItemBase = PullsListResponseItem['base'];
	export type PullsListResponseItemHeadRepo = PullsListResponseItemHead['repo'];
	export type PullsListResponseItemBaseRepo = PullsListResponseItemBase['repo'];
	export type PullsListResponseItemUser = PullsListResponseItem['user'];
	export type PullsListResponseItemAssignee = PullsListResponseItem['assignee'];
	export type PullsListResponseItemAssigneesItem = PullsListResponseItem['assignees'][0];
	export type PullsListResponseItemRequestedReviewersItem = PullsListResponseItem['requested_reviewers'][0];
	export type PullsListResponseItemBaseUser = PullsListResponseItemBase['user'];
	export type PullsListResponseItemBaseRepoOwner = PullsListResponseItemBase['repo']['owner'];
	export type PullsListResponseItemHeadUser = PullsListResponseItemHead['user'];
	export type PullsListResponseItemHeadRepoOwner = PullsListResponseItemHead['repo']['owner'];
	export type PullsListReviewRequestsResponseTeamsItem = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers']['response']['data']['teams'][0];
	export type PullsListResponseItemHeadRepoTemplateRepository = PullsListResponseItem['head']['repo']['template_repository'];
	export type PullsListCommitsResponseItem = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/commits']['response']['data'][0];
	export type ReposCompareCommitsResponseData = Endpoints['GET /repos/{owner}/{repo}/compare/{base}...{head}']['response']['data'];
	export type ReposGetCombinedStatusForRefResponseStatusesItem = Endpoints['GET /repos/{owner}/{repo}/commits/{ref}/status']['response']['data']['statuses'][0];
	export type ReposGetCommitResponseData = Endpoints['GET /repos/{owner}/{repo}/commits/{ref}']['response']['data'];
	export type ReposGetCommitResponseFiles = Endpoints['GET /repos/{owner}/{repo}/commits/{ref}']['response']['data']['files'];
	export type ReposGetResponseData = Endpoints['GET /repos/{owner}/{repo}']['response']['data'];
	export type ReposGetResponseCodeOfConduct = ReposGetResponseData['code_of_conduct'];
	export type ReposGetResponseOrganization = ReposGetResponseData['organization'];
	export type ReposListBranchesResponseData = Endpoints['GET /repos/{owner}/{repo}/branches']['response']['data'];
	export type SearchReposResponseItem = Endpoints['GET /search/repositories']['response']['data']['items'][0];

}