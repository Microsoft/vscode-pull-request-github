import { createContext } from 'react';
import { getMessageHandler, MessageHandler } from './message';
import { PullRequest, getState, setState, updateState } from './cache';
import { MergeMethod } from '../src/github/interface';
import { IComment } from '../src/common/comment';
import { EventType, ReviewEvent, isReviewEvent } from '../src/common/timelineEvent';

export class PRContext {
	constructor(
		public pr: PullRequest = getState(),
		public onchange: ((ctx: PullRequest) => void) | null = null,
		private _handler: MessageHandler = null) {
		if (!_handler) {
			this._handler = getMessageHandler(this.handleMessage);
		}
	}

	public setTitle = (title: string) =>
		this.postMessage({ command: 'pr.edit-title', args: { text: title } })

	public setDescription = (description: string) =>
		this.postMessage({ command: 'pr.edit-description', args: { text: description } })

	public checkout = () =>
		this.postMessage({ command: 'pr.checkout' })

	public exitReviewMode = async () => {
		if (!this.pr) { return; }
		return this.postMessage({
			command: 'pr.checkout-default-branch',
			args: this.pr.repositoryDefaultBranch,
		});
	}

	public refresh = () =>
		this.postMessage({ command: 'pr.refresh' })

	public checkMergeability = () =>
		this.postMessage({ command: 'pr.checkMergeability' })

	public merge = (args: { title: string, description: string, method: MergeMethod }) =>
		this.postMessage({ command: 'pr.merge', args	})

	public deleteBranch = () =>
		this.postMessage({ command: 'pr.deleteBranch' })

	public readyForReview = () =>
		this.postMessage({ command: 'pr.readyForReview' })

	public comment = async (args: string) => {
		const result = await this.postMessage({ command: 'pr.comment', args});
		const newComment = result.value;
		newComment.event = EventType.Commented;
		this.updatePR({
			events: [...this.pr.events, newComment],
			pendingCommentText: '',
		});
	}

	public addReviewers = () =>
		this.postMessage({ command: 'pr.add-reviewers' })

	public addLabels = () =>
		this.postMessage({ command: 'pr.add-labels' })

	public deleteComment = async (args: { id: number, pullRequestReviewId?: number }) => {
		await this.postMessage({ command: 'pr.delete-comment', args });
		const { pr } = this;
		const { id, pullRequestReviewId } = args;
		if (!pullRequestReviewId) {
			this.updatePR({
				events: pr.events.filter(e => e.id !== id)
			});
			return;
		}
		const index = pr.events.findIndex(e => e.id === pullRequestReviewId);
		if (index === -1) {
			console.error('Could not find review:', pullRequestReviewId);
			return;
		}
		const review: ReviewEvent = pr.events[index] as ReviewEvent;
		if (!review.comments) {
			console.error('No comments to delete for review:', pullRequestReviewId, review);
			return;
		}
		this.pr.events.splice(index, 1, {
			...review,
			comments: review.comments.filter(c => c.id !== id)
		});
		this.updatePR(this.pr);
	}

	public editComment = (args: {comment: IComment, text: string}) =>
		this.postMessage({ command: 'pr.edit-comment', args })

	public updateDraft = (id: number, body: string) => {
		const pullRequest = getState();
		const pendingCommentDrafts = pullRequest.pendingCommentDrafts || Object.create(null);
		if (body === pendingCommentDrafts[id]) { return; }
		pendingCommentDrafts[id] = body;
		this.updatePR({ pendingCommentDrafts: pendingCommentDrafts });
	}

	public requestChanges = async (body: string) =>
		this.appendReview(await this.postMessage({ command: 'pr.request-changes', args: body }))

	public approve = async (body: string) =>
		this.appendReview(await this.postMessage({ command: 'pr.approve', args: body }))

	public submit = async (body: string) =>
		this.appendReview(await this.postMessage({ command: 'pr.submit', args: body }))

	public close = async (body?: string) =>
		this.appendReview(await this.postMessage({ command: 'pr.close', args: body }))

	public removeReviewer = async (login: string) => {
		await this.postMessage({ command: 'pr.remove-reviewer', args: login });
		const reviewers = this.pr.reviewers.filter(r => r.reviewer.login !== login);
		this.updatePR({ reviewers });
	}

	public removeLabel = async (label: string) => {
		await this.postMessage({ command: 'pr.remove-label', args: label });
		const labels = this.pr.labels.filter(r => r.name !== label);
		this.updatePR({ labels });
	}

	public applyPatch = async (comment: IComment) => {
		this.postMessage({ command: 'pr.apply-patch', args: { comment } });
	}

	private appendReview({ review, reviewers }: any) {
		const state = this.pr;
		const events = state.events.filter(e => !isReviewEvent(e) || e.state.toLowerCase() !== 'pending');
			events.forEach(event => {
				if (isReviewEvent(event)) {
					event.comments.forEach(c => c.isDraft = false);
				}
			});
		state.reviewers = reviewers;
		state.events = [
			...state.events
				.filter(e => isReviewEvent(e) ? e.state !== 'PENDING' : e),
			review
		];
		state.reviewState = review.state;
		this.updatePR(state);
	}

	public openDiff = (comment: IComment) =>
		this.postMessage({ command: 'pr.open-diff', args: { comment } })

	setPR = (pr: PullRequest) => {
		this.pr = pr;
		setState(this.pr);
		if (this.onchange) { this.onchange(this.pr); }
		return this;
	}

	updatePR = (pr: Partial<PullRequest>) => {
		updateState(pr);
		this.pr = { ...this.pr, ...pr };
		if (this.onchange) { this.onchange(this.pr); }
		return this;
	}

	postMessage(message: any) {
		return this._handler.postMessage(message);
	}

	handleMessage = (message: any) => {
		switch (message.command) {
			case 'pr.initialize':
				return this.setPR(message.pullrequest);
			case 'update-state':
				return this.updatePR({ state: message.state });
			case 'pr.update-checkout-status':
				return this.updatePR({ isCurrentlyCheckedOut: message.isCurrentlyCheckedOut });
			case 'pr.deleteBranch':
				return this.updatePR({ head: 'UNKNOWN'});
			case 'pr.enable-exit':
				return this.updatePR({ isCurrentlyCheckedOut: true });
			case 'set-scroll':
				window.scrollTo(message.scrollPosition.x, message.scrollPosition.y);
		}
	}

	public static instance = new PRContext();
}

const PullRequestContext = createContext<PRContext>(PRContext.instance);
export default PullRequestContext;
