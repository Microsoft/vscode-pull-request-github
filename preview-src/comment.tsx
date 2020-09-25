import * as React from 'react';
import { useContext, useState, useEffect, useRef, useCallback } from 'react';

import { Spaced, nbsp } from './space';
import { Avatar, AuthorLink } from './user';
import Timestamp from './timestamp';
import { IComment } from '../src/common/comment';
import { PullRequest } from './cache';
import PullRequestContext from './context';
import { editIcon, deleteIcon, commentIcon } from './icon';
import { GithubItemStateEnum } from '../src/github/interface';
import { useStateProp } from './hooks';
import emitter from './events';

export type Props = Partial<IComment & PullRequest> & {
	headerInEditMode?: boolean
	isPRDescription?: boolean
};

export function CommentView(comment: Props) {
	const { id, pullRequestReviewId, canEdit, canDelete, bodyHTML, body, isPRDescription } = comment;
	const [bodyMd, setBodyMd] = useStateProp(body);
	const [bodyHTMLState, setBodyHtml] = useStateProp(bodyHTML);
	const { deleteComment, editComment, setDescription, pr } = useContext(PullRequestContext);
	const currentDraft = pr.pendingCommentDrafts && pr.pendingCommentDrafts[id];
	const [inEditMode, setEditMode] = useState(!!currentDraft);
	const [showActionBar, setShowActionBar] = useState(false);

	if (inEditMode) {
		return React.cloneElement(
			comment.headerInEditMode
				? <CommentBox for={comment} /> : <></>, {}, [
				<EditComment id={id}
					body={currentDraft || bodyMd}
					onCancel={
						() => {
							if (pr.pendingCommentDrafts) {
								delete pr.pendingCommentDrafts[id];
							}
							setEditMode(false);
						}
					}
					onSave={
						async text => {
							try {
								const result = isPRDescription
									? await setDescription(text)
									: await editComment({ comment: comment as IComment, text });

								setBodyHtml(result.bodyHTML);
								setBodyMd(text);
							} finally {
								setEditMode(false);
							}
						}
					} />
			]);
	}

	return <CommentBox
		for={comment}
		onMouseEnter={() => setShowActionBar(true)}
		onMouseLeave={() => setShowActionBar(false)}
	>{showActionBar
		? <div className='action-bar comment-actions'>
			<button onClick={() => emitter.emit('quoteReply', bodyMd)}>{commentIcon}</button>
			{canEdit ? <button onClick={() => setEditMode(true)}>{editIcon}</button> : null}
			{canDelete ? <button onClick={() => deleteComment({ id, pullRequestReviewId })}>{deleteIcon}</button> : null}
		</div>
		: null
		}
		<CommentBody comment={comment as IComment} bodyHTML={bodyHTMLState} body={bodyMd} />
	</CommentBox>;
}

type CommentBoxProps = {
	for: Partial<IComment & PullRequest>
	header?: React.ReactChild
	onMouseEnter?: any
	onMouseLeave?: any
	children?: any
};

function CommentBox({
	for: comment,
	onMouseEnter, onMouseLeave, children }: CommentBoxProps) {
	const { user, author, createdAt, htmlUrl, isDraft } = comment;
	return <div className='comment-container comment review-comment'
		{...{ onMouseEnter, onMouseLeave }}
	>
		<div className='review-comment-container'>
			<div className='review-comment-header'>
				<Spaced>
					<Avatar for={user || author} />
					<AuthorLink for={user || author} />
					{
						createdAt
							? <>
								commented{nbsp}
								<Timestamp href={htmlUrl} date={createdAt} />
							</>
							: <em>pending</em>
					}
					{
						isDraft
							? <>
								<span className='pending-label'>Pending</span>
							</>
							: null
					}
				</Spaced>
			</div>
			{children}
		</div>
	</div>;
}

type FormInputSet = {
	[name: string]: HTMLInputElement | HTMLTextAreaElement
};

type EditCommentProps = {
	id: number
	body: string
	onCancel: () => void
	onSave: (body: string) => Promise<any>
};

function EditComment({ id, body, onCancel, onSave }: EditCommentProps) {
	const { updateDraft } = useContext(PullRequestContext);
	const draftComment = useRef<{ body: string, dirty: boolean }>({ body, dirty: false });
	const form = useRef<HTMLFormElement>();

	useEffect(() => {
		const interval = setInterval(
			() => {
				if (draftComment.current.dirty) {
					updateDraft(id, draftComment.current.body);
					draftComment.current.dirty = false;
				}
			},
			500);
		return () => clearInterval(interval);
	},
		[draftComment]);

	const submit = useCallback(
		async () => {
			const { markdown, submitButton }: FormInputSet = form.current;
			submitButton.disabled = true;
			try {
				await onSave(markdown.value);
			} finally {
				submitButton.disabled = false;
			}
		},
		[form, onSave]);

	const onSubmit = useCallback(
		event => {
			event.preventDefault();
			submit();
		},
		[submit]
	);

	const onKeyDown = useCallback(
		e => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		},
		[submit]
	);

	const onInput = useCallback(
		e => {
			draftComment.current.body = (e.target as any).value;
			draftComment.current.dirty = true;
		},
		[draftComment]);

	return <form ref={form} onSubmit={onSubmit}>
		<textarea
			name='markdown'
			defaultValue={body}
			onKeyDown={onKeyDown}
			onInput={onInput}
		/>
		<div className='form-actions'>
			<button className='secondary' onClick={onCancel}>Cancel</button>
			<input type='submit' name='submitButton' value='Save' />
		</div>
	</form>;
}

export interface Embodied {
	comment?: IComment;
	bodyHTML?: string;
	body?: string;
}

export const CommentBody = ({ comment, bodyHTML, body }: Embodied) => {
	if (!body && !bodyHTML) {
		return <div className='comment-body'><em>No description provided.</em></div>;
	}

	const { applyPatch } = useContext(PullRequestContext);
	const renderedBody = <div dangerouslySetInnerHTML={{ __html: bodyHTML }} />;

	const containsSuggestion = (body || bodyHTML).indexOf('```diff') > -1;
	const applyPatchButton = containsSuggestion
		? <button onClick={() => applyPatch(comment)}>Apply Patch</button>
		: <></>;

	return <div className='comment-body'>
		{renderedBody}
		{applyPatchButton}
	</div>;
};

export function AddComment({ pendingCommentText, state, hasWritePermission, isIssue, reviewState }: PullRequest) {
	const { updatePR, comment, requestChanges, approve, close } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);
	const form = useRef<HTMLFormElement>();
	const textareaRef = useRef<HTMLTextAreaElement>();

	emitter.addListener('quoteReply', (message) => {
		updatePR({ pendingCommentText: `> ${message} \n\n` });
		textareaRef.current.scrollIntoView();
		textareaRef.current.focus();
	});

	const submit = useCallback(
		async (command: (body: string) => Promise<any> = comment) => {
			try {
				setBusy(true);
				const { body }: FormInputSet = form.current;
				await command(body.value);
				updatePR({ pendingCommentText: '' });
			} finally {
				setBusy(false);
			}
		},
		[comment, updatePR, setBusy]);

	const onSubmit = useCallback(
		e => {
			e.preventDefault();
			submit();
		},
		[submit]);

	const onKeyDown = useCallback(
		e => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				submit();
			}
		},
		[submit]);

	const onClick = useCallback(
		e => {
			e.preventDefault();
			const { command } = e.target.dataset;
			submit({ approve, requestChanges, close }[command]);
		},
		[submit, approve, requestChanges, close]);

	return <form id='comment-form'
		ref={form}
		className='comment-form main-comment-form'
		onSubmit={onSubmit}>
		<textarea id='comment-textarea'
			name='body'
			ref={textareaRef}
			onInput={
				({ target }) =>
					updatePR({ pendingCommentText: (target as any).value })
			}
			onKeyDown={onKeyDown}
			value={pendingCommentText}
			placeholder='Leave a comment' />
		<div className='form-actions'>
			{hasWritePermission && !isIssue
				? <button id='close'
					className='secondary'
					disabled={isBusy || state !== GithubItemStateEnum.Open}
					onClick={onClick}
					data-command='close'>Close Pull Request</button>
				: null}
			{!isIssue
				? <button id='request-changes'
					disabled={isBusy || !pendingCommentText}
					className='secondary'
					onClick={onClick}
					data-command='requestChanges'>Request Changes</button>
				: null}
			{!isIssue
				? < button id='approve'
					className='secondary'
					disabled={isBusy || reviewState === 'APPROVED'}
					onClick={onClick}
					data-command='approve'>Approve</button>
				: null}
			<input id='reply'
				value='Comment'
				type='submit'
				className='secondary'
				disabled={isBusy || !pendingCommentText} />
		</div>
	</form>;
}
