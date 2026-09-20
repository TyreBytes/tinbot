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

interface CreateIssueApiResponse {
	number: number;
}

export async function createGithubIssue(settings: ProjectSettings, title: string, body: string): Promise<number> {
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

	const result = (await response.json()) as CreateIssueApiResponse;
	return result.number;
}

export async function updateGithubIssueTitle(settings: ProjectSettings, issueNumber: number, title: string): Promise<void> {
	const { token, owner, repo } = settings.github;
	const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
		method: 'PATCH',
		headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title }),
	});

	if (!response.ok) {
		const responseText = await response.text();
		throw new Error(`GitHub API returned ${response.status} ${response.statusText}: ${responseText}`);
	}
}

export interface GithubIssue {
	number: number;
	title: string;
	body?: string;
}

interface ListIssuesApiEntry {
	number: number;
	title: string;
	body?: string | null;
	pull_request?: unknown;
}

export async function listOpenIssues(settings: ProjectSettings): Promise<GithubIssue[]> {
	const { token, owner, repo } = settings.github;
	const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100`, {
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
			const issue: GithubIssue = { number: entry.number, title: entry.title };
			if (typeof entry.body === 'string' && entry.body.length > 0) {
				issue.body = entry.body;
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

const issueStagingHeader = '# Issue Staging:';

function countLeadingTabsLocal(line: string): number {
	let count = 0;
	while (count < line.length && line[count] === '\t') {
		count += 1;
	}
	return count;
}

function renderStagingLines(issues: StagingIssue[], depth: number): string[] {
	const lines: string[] = [];
	const indent = '\t'.repeat(depth + 1);
	for (const issue of issues) {
		lines.push(`${'\t'.repeat(depth)}☐ @issue${issue.number} ${issue.title}`);
		if (issue.description !== undefined) {
			// Written verbatim, markdown and all: parseItems() reads these as plain-text
			// lines with no marker, so they come back as this issue's .description.
			for (const descriptionLine of issue.description.split(/\r\n|\n/)) {
				lines.push(descriptionLine.length === 0 ? '' : `${indent}${descriptionLine}`);
			}
		}
		lines.push(...renderStagingLines(issue.children, depth + 1));
	}
	return lines;
}

export function addIssuesToStaging(text: string, issues: StagingIssue[]): string {
	if (issues.length === 0) {
		return text;
	}

	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r\n|\n/);
	const newLines = renderStagingLines(issues, 1);

	const headerIndex = lines.findIndex((line) => line.trim() === issueStagingHeader && countLeadingTabsLocal(line) === 0);

	if (headerIndex === -1) {
		let start = 0;
		while (start < lines.length && lines[start].trim().length === 0) {
			start += 1;
		}
		return [issueStagingHeader, ...newLines, '', ...lines.slice(start)].join(eol);
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

	return [...before, ...newLines, ...separator, ...after].join(eol);
}

const issueTagPattern = /@issue(?![\w-])/;

export function patchIssueLine(text: string, lineNumber: number, issueId: number): string {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r\n|\n/);
	const target = lines[lineNumber];
	if (target === undefined) {
		throw new Error(`patchIssueLine: line ${lineNumber} does not exist (file has ${lines.length} lines)`);
	}

	const patched = target.replace(issueTagPattern, `@issue${issueId}`);
	if (patched === target) {
		throw new Error(`patchIssueLine: line ${lineNumber} has no unsynced @issue tag: ${JSON.stringify(target)}`);
	}

	lines[lineNumber] = patched;
	return lines.join(eol);
}
