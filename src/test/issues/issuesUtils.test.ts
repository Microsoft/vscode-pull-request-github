import { default as assert } from 'assert';
import { parseIssueExpressionOutput, sanitizeIssueTitle, ISSUE_OR_URL_EXPRESSION } from '../../issues/util';

describe('Issues utilities', function () {
	it('regular expressions', async function () {
		const issueNumber = '#1234';
		const issueNumberParsed = parseIssueExpressionOutput(issueNumber.match(ISSUE_OR_URL_EXPRESSION));
		assert.equal(issueNumberParsed?.issueNumber, 1234);
		assert.equal(issueNumberParsed?.commentNumber, undefined);
		assert.equal(issueNumberParsed?.name, undefined);
		assert.equal(issueNumberParsed?.owner, undefined);

		const issueNumberGH = 'GH-321';
		const issueNumberGHParsed = parseIssueExpressionOutput(issueNumberGH.match(ISSUE_OR_URL_EXPRESSION));
		assert.equal(issueNumberGHParsed?.issueNumber, 321);
		assert.equal(issueNumberGHParsed?.commentNumber, undefined);
		assert.equal(issueNumberGHParsed?.name, undefined);
		assert.equal(issueNumberGHParsed?.owner, undefined);
		const issueSingleDigit = '#1';
		const issueSingleDigitParsed = parseIssueExpressionOutput(issueSingleDigit.match(ISSUE_OR_URL_EXPRESSION));
		assert.equal(issueSingleDigitParsed?.issueNumber, 1);
		assert.equal(issueSingleDigitParsed?.commentNumber, undefined);
		assert.equal(issueSingleDigitParsed?.name, undefined);
		assert.equal(issueSingleDigitParsed?.owner, undefined);
		const issueRepo = 'alexr00/myRepo#234';
		const issueRepoParsed = parseIssueExpressionOutput(issueRepo.match(ISSUE_OR_URL_EXPRESSION));
		assert.equal(issueRepoParsed?.issueNumber, 234);
		assert.equal(issueRepoParsed?.commentNumber, undefined);
		assert.equal(issueRepoParsed?.name, 'myRepo');
		assert.equal(issueRepoParsed?.owner, 'alexr00');
		const issueUrl = 'http://github.com/alexr00/myRepo/issues/567';
		const issueUrlParsed = parseIssueExpressionOutput(issueUrl.match(ISSUE_OR_URL_EXPRESSION));
		assert.equal(issueUrlParsed?.issueNumber, 567);
		assert.equal(issueUrlParsed?.commentNumber, undefined);
		assert.equal(issueUrlParsed?.name, 'myRepo');
		assert.equal(issueUrlParsed?.owner, 'alexr00');
		const commentUrl = 'https://github.com/microsoft/vscode/issues/96#issuecomment-641150523';
		const commentUrlParsed = parseIssueExpressionOutput(commentUrl.match(ISSUE_OR_URL_EXPRESSION));
		assert.equal(commentUrlParsed?.issueNumber, 96);
		assert.equal(commentUrlParsed?.commentNumber, 641150523);
		assert.equal(commentUrlParsed?.name, 'vscode');
		assert.equal(commentUrlParsed?.owner, 'microsoft');
		const notIssue = '#a4';
		const notIssueParsed = parseIssueExpressionOutput(notIssue.match(ISSUE_OR_URL_EXPRESSION));
		assert.equal(notIssueParsed, undefined);
	});

	describe('sanitizeIssueTitle', () => {
		[
			{ input: 'Issue', expected: 'issue' },
			{ input: 'Issue A', expected: 'issue-a' },
			{ input: 'Issue \ A', expected: 'issue-a' },
			{ input: 'Issue     A', expected: 'issue-a' },
			{ input: 'Issue @ A', expected: 'issue-a' },
			{ input: 'Issue \'A\'', expected: 'issue-a' },
			{ input: 'Issue "A"', expected: 'issue-a' },
			{ input: '@Issue "A"', expected: 'issue-a' },
			{ input: 'Issue "A"%', expected: 'issue-a' },
			{ input: 'Issue .A', expected: 'issue-a' },
			{ input: 'Issue ,A', expected: 'issue-a' },
			{ input: 'Issue :A', expected: 'issue-a' },
			{ input: 'Issue ;A', expected: 'issue-a' },
			{ input: 'Issue ~A', expected: 'issue-a' },
			{ input: 'Issue #A', expected: 'issue-a' },
		]
		.forEach((testCase) => {
			it(`Transforms '${testCase.input}' into '${testCase.expected}'`, () => {
				const actual = sanitizeIssueTitle(testCase.input);
				assert.equal(actual, testCase.expected);
			});
		});
	});
});
