/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as  MarkdownIt from 'markdown-it';
const Checkbox = require('markdown-it-checkbox');
const md = MarkdownIt({
	html: true,
	linkify: true
})
.use(Checkbox, {
	divWrap: true,
	divClass: 'github-checkbox',

});

export default md;