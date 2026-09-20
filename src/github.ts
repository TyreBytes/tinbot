import * as vscode from 'vscode';

export interface ProjectSettings {
	github: {
		token: string;
		owner: string;
		repo: string;
	};
}

export async function readProjectSettings(baseUri: vscode.Uri): Promise<ProjectSettings | undefined> {
	const fileUri = vscode.Uri.joinPath(baseUri, 'project_settings.secret');
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(fileUri);
	} catch (err) {
		if ((err as { code?: string }).code === 'FileNotFound') {
			return undefined;
		}
		throw err;
	}

	const text = new TextDecoder('utf-8').decode(bytes);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`project_settings.secret is not valid JSON: ${err}`);
	}

	const github = (parsed as { github?: Record<string, unknown> } | undefined)?.github ?? {};
	const missing: string[] = [];
	if (typeof github.token !== 'string' || github.token.length === 0) {
		missing.push('github.token');
	}
	if (typeof github.owner !== 'string' || github.owner.length === 0) {
		missing.push('github.owner');
	}
	if (typeof github.repo !== 'string' || github.repo.length === 0) {
		missing.push('github.repo');
	}
	if (missing.length > 0) {
		throw new Error(`project_settings.secret is missing required field(s): ${missing.join(', ')}`);
	}

	return { github: { token: github.token as string, owner: github.owner as string, repo: github.repo as string } };
}

function githubHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'tinbot-vscode-extension',
	};
}

export interface CreatedGithubIssue {
	id: number;
	number: number;
}

export async function createGithubIssue(settings: ProjectSettings, title: string, body: string): Promise<CreatedGithubIssue> {
	const { token, owner, repo } = settings.github;
	const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
		method: 'POST',
		headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, body }),
	});

	if (!response.ok) {
		const responseText = await response.text();
		throw new Error(`GitHub API returned ${response.status} ${response.statusText}: ${responseText}`);
	}

	const result = (await response.json()) as CreatedGithubIssue;
	return { id: result.id, number: result.number };
}

/** Links an already-created issue as a sub-issue of a parent issue, using GitHub's sub-issues API.
 * The parent is addressed by its issue number (as in every other call here); the child must be
 * addressed by its internal database id, which is GitHub's own requirement for this endpoint. */
export async function addSubIssue(settings: ProjectSettings, parentIssueNumber: number, subIssueId: number): Promise<void> {
	const { token, owner, repo } = settings.github;
	const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${parentIssueNumber}/sub_issues`, {
		method: 'POST',
		headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ sub_issue_id: subIssueId }),
	});

	if (!response.ok) {
		const responseText = await response.text();
		throw new Error(`GitHub API returned ${response.status} ${response.statusText}: ${responseText}`);
	}
}

/** Unlinks a sub-issue from its current parent, addressed the same way as addSubIssue: the
 * parent by its issue number in the URL, the child by its internal id in the body. */
export async function removeSubIssue(settings: ProjectSettings, parentIssueNumber: number, subIssueId: number): Promise<void> {
	const { token, owner, repo } = settings.github;
	const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${parentIssueNumber}/sub_issue`, {
		method: 'DELETE',
		headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ sub_issue_id: subIssueId }),
	});

	if (!response.ok) {
		const responseText = await response.text();
		throw new Error(`GitHub API returned ${response.status} ${response.statusText}: ${responseText}`);
	}
}

export interface GithubIssuePatch {
	title?: string;
	body?: string;
	state?: 'open' | 'closed';
	state_reason?: 'completed' | 'not_planned';
}

export async function updateGithubIssue(settings: ProjectSettings, issueNumber: number, patch: GithubIssuePatch): Promise<void> {
	const { token, owner, repo } = settings.github;
	const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
		method: 'PATCH',
		headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(patch),
	});

	if (!response.ok) {
		const responseText = await response.text();
		throw new Error(`GitHub API returned ${response.status} ${response.statusText}: ${responseText}`);
	}
}

export interface GithubIssue {
	id: number;
	number: number;
	title: string;
	body?: string;
	state: 'open' | 'closed';
	stateReason?: string;
	updatedAt: string;
	closedAt?: string;
	/** The current parent issue's number, if any. Not part of the bulk listing endpoint;
	 * populated separately (see getIssueParent) by callers that need to reconcile it. */
	parentNumber?: number;
}

interface ListIssuesApiEntry {
	id: number;
	number: number;
	title: string;
	body?: string | null;
	pull_request?: unknown;
	state: string;
	state_reason?: string | null;
	updated_at: string;
	closed_at?: string | null;
}

export async function listAllIssues(settings: ProjectSettings): Promise<GithubIssue[]> {
	const { token, owner, repo } = settings.github;
	const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=100`, {
		headers: githubHeaders(token),
	});

	if (!response.ok) {
		const responseText = await response.text();
		throw new Error(`GitHub API returned ${response.status} ${response.statusText}: ${responseText}`);
	}

	const entries = (await response.json()) as ListIssuesApiEntry[];
	// The issues endpoint also returns pull requests; only a real issue lacks this field.
	return entries
		.filter((entry) => entry.pull_request === undefined)
		.map((entry) => {
			const issue: GithubIssue = {
				id: entry.id,
				number: entry.number,
				title: entry.title,
				state: entry.state === 'closed' ? 'closed' : 'open',
				updatedAt: entry.updated_at,
			};
			if (typeof entry.body === 'string' && entry.body.length > 0) {
				issue.body = entry.body;
			}
			if (typeof entry.state_reason === 'string') {
				issue.stateReason = entry.state_reason;
			}
			if (typeof entry.closed_at === 'string') {
				issue.closedAt = entry.closed_at;
			}
			return issue;
		});
}

export async function getIssueParent(settings: ProjectSettings, issueNumber: number): Promise<number | undefined> {
	const { token, owner, repo } = settings.github;
	const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/parent`, {
		headers: githubHeaders(token),
	});

	if (response.status === 404) {
		return undefined;
	}
	if (!response.ok) {
		const responseText = await response.text();
		throw new Error(`GitHub API returned ${response.status} ${response.statusText}: ${responseText}`);
	}

	const result = (await response.json()) as { number: number };
	return result.number;
}

export type TodoStatus = 'open' | 'done' | 'cancelled';

/** Maps a GitHub issue's state/state_reason onto the todo file's open/done/cancelled vocabulary. */
export function githubStatusToTodoStatus(state: 'open' | 'closed', stateReason?: string): TodoStatus {
	if (state === 'open') {
		return 'open';
	}
	return stateReason === 'not_planned' ? 'cancelled' : 'done';
}

export function todoStatusToGithubPatch(status: TodoStatus): { state: 'open' | 'closed'; state_reason?: 'completed' | 'not_planned' } {
	if (status === 'open') {
		return { state: 'open' };
	}
	return { state: 'closed', state_reason: status === 'cancelled' ? 'not_planned' : 'completed' };
}

// The :SS group is optional so a stamp written by an older version of tinbot (before seconds
// were added) still parses, rather than breaking every issue that already has one.
const syncedStampFormatPattern = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The extension's own bookkeeping format for @synced(...): YYYYMMDD HH:MM:SS, always in local
 * time. Seconds matter here: this stamp is compared against GitHub's own updated_at, and a
 * push's resulting GitHub timestamp always lands a little after the moment this is stamped
 * from. Minute precision left up to 59 seconds of slack in which that same-minute GitHub
 * timestamp would look "newer" than the stamp, wrongly triggering a pull that could discard
 * an edit made moments later in that window; seconds narrow that gap to under one second.
 */
export function formatSyncedStamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function parseSyncedStamp(text: string): Date {
	const match = text.match(syncedStampFormatPattern);
	if (match === null) {
		throw new Error(`parseSyncedStamp: "${text}" is not in the expected YYYYMMDD HH:MM[:SS] format`);
	}
	const [, year, month, day, hour, minute, second] = match;
	return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? '0'));
}

export function splitTextLines(text: string): { eol: string; lines: string[] } {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	return { eol, lines: text.split(/\r\n|\n/) };
}

export function joinTextLines(lines: string[], eol: string): string {
	return lines.join(eol);
}

function countLeadingTabsLocal(line: string): number {
	let count = 0;
	while (count < line.length && line[count] === '\t') {
		count += 1;
	}
	return count;
}

// Mirrors extension.ts's own taskMarkerPattern/sectionHeaderPattern: github.ts stays free of
// any dependency on extension.ts, so the shapes it needs to recognize are duplicated here.
const taskMarkerPatternLocal = /^[☐✔✘]\s*/;
const sectionHeaderPatternLocal = /^#+\s*(.+):$/;

export interface StagingIssue {
	number: number;
	title: string;
	description?: string;
	children: StagingIssue[];
}

export function buildStagingForest(issues: GithubIssue[], parentOf: Map<number, number>): StagingIssue[] {
	const nodeByNumber = new Map<number, StagingIssue>();
	for (const issue of issues) {
		const node: StagingIssue = { number: issue.number, title: issue.title, children: [] };
		if (issue.body !== undefined) {
			node.description = issue.body;
		}
		nodeByNumber.set(issue.number, node);
	}

	const roots: StagingIssue[] = [];
	for (const issue of issues) {
		const node = nodeByNumber.get(issue.number)!;
		const parentNumber = parentOf.get(issue.number);
		const parentNode = parentNumber === undefined ? undefined : nodeByNumber.get(parentNumber);
		if (parentNode === undefined) {
			roots.push(node);
		} else {
			parentNode.children.push(node);
		}
	}

	return roots;
}

export interface IssueLineFields {
	issueId: number;
	tags?: string[];
	name: string;
	status: TodoStatus;
	statusDate?: string;
	syncedAt: string;
}

/** Renders one issue's todo line in the extension's canonical tag order: issue tag, other
 * tags, name, done/cancelled date, @synced last. */
export function renderIssueLine(depth: number, fields: IssueLineFields): string {
	const marker = fields.status === 'done' ? '✔' : fields.status === 'cancelled' ? '✘' : '☐';
	const otherTags = (fields.tags ?? []).map((tag) => `@${tag}`);
	const parts = [`@issue${fields.issueId}`, ...otherTags, fields.name];
	let line = `${'\t'.repeat(depth)}${marker} ${parts.join(' ')}`;
	if (fields.status !== 'open' && fields.statusDate !== undefined) {
		line += ` @${fields.status}(${fields.statusDate})`;
	}
	return `${line} @synced(${fields.syncedAt})`;
}

const syncedTagPattern = /\s*@synced\([^)]*\)/;

/** Replaces (or appends) the @synced(...) tag on a line so it always ends up last. */
export function setSyncedTag(line: string, syncedAt: string): string {
	return `${line.replace(syncedTagPattern, '')} @synced(${syncedAt})`;
}

/** Renders a description as indented lines, one tab deeper than the item. Written verbatim,
 * markdown and all: parseItems() reads these back as plain-text lines with no marker. An
 * empty description renders as no lines at all, so a pull can clear a description cleanly. */
export function renderDescriptionBlockLines(description: string, itemDepth: number): string[] {
	if (description.length === 0) {
		return [];
	}
	const indent = '\t'.repeat(itemDepth + 1);
	return description.split(/\r\n|\n/).map((line) => (line.length === 0 ? '' : `${indent}${line}`));
}

/**
 * Finds the extent of an item's own (leading) description block: the run of lines
 * immediately after its line, up to the first child (task/section) line or a dedent to the
 * item's own depth or shallower, whichever comes first. Trailing blank lines are excluded.
 * This covers every item in practice, including one with a description followed by
 * children, but does not locate description text written after or between children.
 */
export function findDescriptionBlockExtent(lines: string[], itemLineIndex: number): { start: number; end: number } {
	const itemDepth = countLeadingTabsLocal(lines[itemLineIndex]);
	let end = itemLineIndex + 1;
	while (end < lines.length) {
		const line = lines[end];
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			end += 1;
			continue;
		}
		if (countLeadingTabsLocal(line) <= itemDepth) {
			break;
		}
		if (taskMarkerPatternLocal.test(trimmed) || sectionHeaderPatternLocal.test(trimmed)) {
			break;
		}
		end += 1;
	}

	let trimmedEnd = end;
	while (trimmedEnd > itemLineIndex + 1 && lines[trimmedEnd - 1].trim().length === 0) {
		trimmedEnd -= 1;
	}
	return { start: itemLineIndex + 1, end: trimmedEnd };
}

function renderStagingLines(issues: StagingIssue[], depth: number, syncedAt: string): string[] {
	const lines: string[] = [];
	for (const issue of issues) {
		lines.push(renderIssueLine(depth, { issueId: issue.number, name: issue.title, status: 'open', syncedAt }));
		lines.push(...renderDescriptionBlockLines(issue.description ?? '', depth));
		lines.push(...renderStagingLines(issue.children, depth + 1, syncedAt));
	}
	return lines;
}

const issueStagingHeader = '# Issue Staging:';

export function addIssuesToStaging(text: string, issues: StagingIssue[], syncedAt: string): string {
	if (issues.length === 0) {
		return text;
	}

	const { eol, lines } = splitTextLines(text);
	const newLines = renderStagingLines(issues, 1, syncedAt);

	const headerIndex = lines.findIndex((line) => line.trim() === issueStagingHeader && countLeadingTabsLocal(line) === 0);

	if (headerIndex === -1) {
		let start = 0;
		while (start < lines.length && lines[start].trim().length === 0) {
			start += 1;
		}
		return joinTextLines([issueStagingHeader, ...newLines, '', ...lines.slice(start)], eol);
	}

	let insertAt = headerIndex + 1;
	while (insertAt < lines.length) {
		const line = lines[insertAt];
		if (line.trim().length > 0 && countLeadingTabsLocal(line) === 0) {
			break;
		}
		insertAt += 1;
	}

	let end = insertAt;
	while (end > headerIndex + 1 && lines[end - 1].trim().length === 0) {
		end -= 1;
	}

	const before = lines.slice(0, end);
	const after = lines.slice(insertAt);
	const separator = after.length > 0 ? [''] : [];

	return joinTextLines([...before, ...newLines, ...separator, ...after], eol);
}

const bareIssueTagPattern = /@issue(?![\w-])/;

export function patchIssueLine(text: string, lineNumber: number, issueId: number): string {
	const { eol, lines } = splitTextLines(text);
	const target = lines[lineNumber];
	if (target === undefined) {
		throw new Error(`patchIssueLine: line ${lineNumber} does not exist (file has ${lines.length} lines)`);
	}

	const patched = target.replace(bareIssueTagPattern, `@issue${issueId}`);
	if (patched === target) {
		throw new Error(`patchIssueLine: line ${lineNumber} has no unsynced @issue tag: ${JSON.stringify(target)}`);
	}

	lines[lineNumber] = patched;
	return joinTextLines(lines, eol);
}

/** Pull direction: rewrites an issue's line and its leading description block from GitHub's
 * current title/status/body, and stamps @synced. */
export function applyIssuePull(text: string, item: { tags?: string[] }, lineNumber: number, issue: GithubIssue, syncedAt: string): string {
	const { eol, lines } = splitTextLines(text);
	const depth = countLeadingTabsLocal(lines[lineNumber]);
	const status = githubStatusToTodoStatus(issue.state, issue.stateReason);
	const statusDate = status === 'open' ? undefined : formatSyncedStamp(new Date(issue.closedAt ?? issue.updatedAt));

	lines[lineNumber] = renderIssueLine(depth, {
		issueId: issue.number,
		tags: item.tags,
		name: issue.title,
		status,
		statusDate,
		syncedAt,
	});

	const { start, end } = findDescriptionBlockExtent(lines, lineNumber);
	lines.splice(start, end - start, ...renderDescriptionBlockLines(issue.body ?? '', depth));

	return joinTextLines(lines, eol);
}

/** Push direction: the todo file is already correct, so only its @synced stamp is touched. */
export function applyStampOnly(text: string, lineNumber: number, syncedAt: string): string {
	const { eol, lines } = splitTextLines(text);
	lines[lineNumber] = setSyncedTag(lines[lineNumber], syncedAt);
	return joinTextLines(lines, eol);
}
