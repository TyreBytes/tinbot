import * as vscode from 'vscode';
import {
	addIssuesToStaging,
	applyIssuePull,
	applyStampOnly,
	buildStagingForest,
	createGithubIssue,
	formatSyncedStamp,
	getIssueParent,
	GithubIssue,
	githubStatusToTodoStatus,
	listAllIssues,
	parseSyncedStamp,
	patchIssueLine,
	ProjectSettings,
	readProjectSettings,
	TodoStatus,
	todoStatusToGithubPatch,
	updateGithubIssue,
} from './github';

export interface Item {
	kind: 'section' | 'task' | 'issue';
	name: string;
	status?: 'done' | 'cancelled';
	description?: string;
	tags?: string[];
	completedDate?: string;
	cancelledDate?: string;
	issueId?: number;
	syncedAt?: string;
	children: Item[];
}

const sectionHeaderPattern = /^#+\s*(.+):$/;
const taskMarkerPattern = /^[☐✔✘]\s*/;
const doneTagPattern = /@done\(([^)]+)\)/;
const cancelledTagPattern = /@cancelled\(([^)]+)\)/;
const syncedTagPattern = /@synced\(([^)]+)\)/;
const issueTagPattern = /@issue(\d+)?(?![\w-])/;
const genericTagPattern = /@\w[\w-]*/g;

function countLeadingTabs(line: string): number {
	let count = 0;
	while (count < line.length && line[count] === '\t') {
		count += 1;
	}
	return count;
}

function taskStatus(marker: string): 'done' | 'cancelled' | undefined {
	if (marker === '✔') {
		return 'done';
	}
	if (marker === '✘') {
		return 'cancelled';
	}
	return undefined;
}

function applyTags(item: Item, rawName: string): void {
	let name = rawName;

	const doneMatch = name.match(doneTagPattern);
	if (doneMatch) {
		item.completedDate = doneMatch[1];
		name = name.replace(doneTagPattern, '');
	}

	const cancelledMatch = name.match(cancelledTagPattern);
	if (cancelledMatch) {
		item.cancelledDate = cancelledMatch[1];
		name = name.replace(cancelledTagPattern, '');
	}

	const syncedMatch = name.match(syncedTagPattern);
	if (syncedMatch) {
		item.syncedAt = syncedMatch[1];
		name = name.replace(syncedTagPattern, '');
	}

	if (item.kind === 'task') {
		const issueMatch = name.match(issueTagPattern);
		if (issueMatch) {
			item.kind = 'issue';
			if (issueMatch[1] !== undefined) {
				item.issueId = Number(issueMatch[1]);
			}
			name = name.replace(issueTagPattern, '');
		}
	}

	const tags: string[] = [];
	name = name.replace(genericTagPattern, (match) => {
		tags.push(match.slice(1));
		return '';
	});
	if (tags.length > 0) {
		item.tags = tags;
	}

	item.name = name.replace(/\s+/g, ' ').trim();
}

function trimBlockLines(lines: string[]): string {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].length === 0) {
		start += 1;
	}
	while (end > start && lines[end - 1].length === 0) {
		end -= 1;
	}
	return lines.slice(start, end).join('\n');
}

const itemSourceLine = new WeakMap<Item, number>();

export function getItemSourceLine(item: Item): number | undefined {
	return itemSourceLine.get(item);
}

export function parseItems(text: string): Item[] {
	const root: Item = { kind: 'section', name: '', children: [] };
	const stack: Array<{ depth: number; item: Item }> = [{ depth: -1, item: root }];
	let openBlock: { owner: Item; lines: string[] } | undefined;

	const closeOpenBlock = () => {
		if (openBlock === undefined) {
			return;
		}
		const blockText = trimBlockLines(openBlock.lines);
		if (blockText.length > 0) {
			openBlock.owner.description =
				openBlock.owner.description === undefined ? blockText : `${openBlock.owner.description}\n\n${blockText}`;
		}
		openBlock = undefined;
	};

	const popTo = (depth: number) => {
		while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
			stack.pop();
		}
	};

	const lines = text.split(/\r?\n/);
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const rawLine = lines[lineIndex];
		const depth = countLeadingTabs(rawLine);
		const content = rawLine.slice(depth).trim();

		if (content.length === 0) {
			if (openBlock !== undefined) {
				openBlock.lines.push('');
			}
			continue;
		}

		const headerMatch = content.match(sectionHeaderPattern);
		if (headerMatch) {
			closeOpenBlock();
			popTo(depth);
			const item: Item = { kind: 'section', name: '', children: [] };
			applyTags(item, headerMatch[1].trim());
			stack[stack.length - 1].item.children.push(item);
			stack.push({ depth, item });
			itemSourceLine.set(item, lineIndex);
			continue;
		}

		if (taskMarkerPattern.test(content)) {
			closeOpenBlock();
			const marker = content[0];
			const rawName = content.replace(taskMarkerPattern, '').trim();
			if (rawName.length === 0) {
				continue;
			}
			popTo(depth);
			const status = taskStatus(marker);
			const item: Item = status === undefined ? { kind: 'task', name: '', children: [] } : { kind: 'task', name: '', status, children: [] };
			applyTags(item, rawName);
			stack[stack.length - 1].item.children.push(item);
			stack.push({ depth, item });
			itemSourceLine.set(item, lineIndex);
			continue;
		}

		// A line with no header/task marker is plain text: a description block for the
		// nearest enclosing Item, found the same way a task's parent is found.
		popTo(depth);
		const owner = stack[stack.length - 1].item;
		if (openBlock === undefined || openBlock.owner !== owner) {
			closeOpenBlock();
			openBlock = { owner, lines: [content] };
		} else {
			openBlock.lines.push(content);
		}
	}

	closeOpenBlock();
	return root.children;
}

export async function readItems(todoUri: vscode.Uri): Promise<Item[]> {
	const bytes = await vscode.workspace.fs.readFile(todoUri);
	const text = new TextDecoder('utf-8').decode(bytes);
	return parseItems(text);
}

export function collectUnsyncedIssues(items: Item[]): Item[] {
	const result: Item[] = [];
	const walk = (list: Item[]) => {
		for (const item of list) {
			if (item.kind === 'issue' && item.issueId === undefined) {
				result.push(item);
			}
			walk(item.children);
		}
	};
	walk(items);
	return result;
}

export function collectKnownIssueIds(items: Item[]): Set<number> {
	const ids = new Set<number>();
	const walk = (list: Item[]) => {
		for (const item of list) {
			if (item.kind === 'issue' && item.issueId !== undefined) {
				ids.add(item.issueId);
			}
			walk(item.children);
		}
	};
	walk(items);
	return ids;
}

function itemIssueStatus(item: Item): TodoStatus {
	return item.status ?? 'open';
}

/** Whether the todo item and its matching GitHub issue already agree on title, status, and description. */
export function issueMatchesGithub(item: Item, issue: GithubIssue): boolean {
	if (item.name !== issue.title) {
		return false;
	}
	if (itemIssueStatus(item) !== githubStatusToTodoStatus(issue.state, issue.stateReason)) {
		return false;
	}
	return (item.description ?? '') === (issue.body ?? '');
}

export type SyncDirection = 'baseline' | 'pull' | 'push' | 'none';

/**
 * Decides how one already-synced issue should be reconciled against its GitHub counterpart.
 * An issue with no @synced stamp yet is only ever baselined (stamped, nothing pushed or
 * pulled) so a fresh one-sided edit on either side can never be silently overwritten by a
 * guess. Once a stamp exists: GitHub having changed since it wins (pull); otherwise, any
 * remaining difference must have come from the todo file, so it wins (push).
 */
export function decideSyncDirection(item: Item, issue: GithubIssue): SyncDirection {
	if (item.syncedAt === undefined) {
		return 'baseline';
	}
	const syncedAt = parseSyncedStamp(item.syncedAt);
	const githubUpdatedAt = new Date(issue.updatedAt);
	if (githubUpdatedAt.getTime() > syncedAt.getTime()) {
		return 'pull';
	}
	return issueMatchesGithub(item, issue) ? 'none' : 'push';
}

export interface IssueMatch {
	item: Item;
	issue: GithubIssue;
}

export function collectKnownIssueMatches(items: Item[], issues: GithubIssue[]): IssueMatch[] {
	const issueByNumber = new Map<number, GithubIssue>();
	for (const issue of issues) {
		issueByNumber.set(issue.number, issue);
	}

	const matches: IssueMatch[] = [];
	const walk = (list: Item[]) => {
		for (const item of list) {
			if (item.kind === 'issue' && item.issueId !== undefined) {
				const issue = issueByNumber.get(item.issueId);
				if (issue !== undefined) {
					matches.push({ item, issue });
				}
			}
			walk(item.children);
		}
	};
	walk(items);
	return matches;
}

async function reconcileKnownIssues(todoUri: vscode.Uri, items: Item[], issues: GithubIssue[], settings: ProjectSettings, now: Date): Promise<void> {
	const pending = collectKnownIssueMatches(items, issues)
		.map((match) => ({ match, direction: decideSyncDirection(match.item, match.issue) }))
		.filter((entry) => entry.direction !== 'none')
		.sort((a, b) => getItemSourceLine(b.match.item)! - getItemSourceLine(a.match.item)!);

	if (pending.length === 0) {
		return;
	}

	let text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(todoUri));
	const syncedAt = formatSyncedStamp(now);

	for (const entry of pending) {
		const { item, issue } = entry.match;
		const lineNumber = getItemSourceLine(item);
		if (lineNumber === undefined) {
			throw new Error(`tinbot: no source line recorded for issue #${issue.number}`);
		}

		if (entry.direction === 'pull') {
			text = applyIssuePull(text, item, lineNumber, issue, syncedAt);
			continue;
		}
		if (entry.direction === 'push') {
			await updateGithubIssue(settings, issue.number, {
				title: item.name,
				body: item.description ?? '',
				...todoStatusToGithubPatch(itemIssueStatus(item)),
			});
		}
		text = applyStampOnly(text, lineNumber, syncedAt);
	}

	await vscode.workspace.fs.writeFile(todoUri, new TextEncoder().encode(text));
}

async function pushUnsyncedIssuesToGithub(todoUri: vscode.Uri, items: Item[], settings: ProjectSettings, now: Date): Promise<void> {
	for (const item of collectUnsyncedIssues(items)) {
		const lineNumber = getItemSourceLine(item);
		if (lineNumber === undefined) {
			throw new Error(`tinbot: no source line recorded for issue "${item.name}"`);
		}

		const issueId = await createGithubIssue(settings, item.name, item.description ?? '');

		const bytes = await vscode.workspace.fs.readFile(todoUri);
		const text = new TextDecoder('utf-8').decode(bytes);
		const patched = applyStampOnly(patchIssueLine(text, lineNumber, issueId), lineNumber, formatSyncedStamp(now));
		await vscode.workspace.fs.writeFile(todoUri, new TextEncoder().encode(patched));

		item.issueId = issueId;
	}
}

async function pullNewIssuesFromGithub(
	todoUri: vscode.Uri,
	items: Item[],
	openIssues: GithubIssue[],
	settings: ProjectSettings,
	now: Date,
): Promise<void> {
	const knownIds = collectKnownIssueIds(items);
	const newIssues = openIssues.filter((issue) => !knownIds.has(issue.number)).sort((a, b) => a.number - b.number);
	if (newIssues.length === 0) {
		return;
	}

	const parentOf = new Map<number, number>();
	for (const issue of newIssues) {
		const parentNumber = await getIssueParent(settings, issue.number);
		if (parentNumber !== undefined && newIssues.some((candidate) => candidate.number === parentNumber)) {
			parentOf.set(issue.number, parentNumber);
		}
	}

	const forest = buildStagingForest(newIssues, parentOf);

	const bytes = await vscode.workspace.fs.readFile(todoUri);
	const text = new TextDecoder('utf-8').decode(bytes);
	const patched = addIssuesToStaging(text, forest, formatSyncedStamp(now));
	await vscode.workspace.fs.writeFile(todoUri, new TextEncoder().encode(patched));
}

async function syncWithGithub(todoUri: vscode.Uri, items: Item[]): Promise<void> {
	const settings = await readProjectSettings(vscode.Uri.joinPath(todoUri, '..'));
	if (settings === undefined) {
		return;
	}

	const now = new Date();
	await pushUnsyncedIssuesToGithub(todoUri, items, settings, now);

	const allIssues = await listAllIssues(settings);
	await reconcileKnownIssues(todoUri, items, allIssues, settings, now);

	const openIssues = allIssues.filter((issue) => issue.state === 'open');
	await pullNewIssuesFromGithub(todoUri, items, openIssues, settings, now);
}

const syncedTagWithLeadingSpacePattern = /\s?@synced\([^)]*\)/g;

/** Per-line offsets of every @synced(...) tag in the text, including one leading space so
 * hiding it leaves no gap between it and the previous word. */
export function findSyncedTagRanges(text: string): Array<{ line: number; start: number; end: number }> {
	const ranges: Array<{ line: number; start: number; end: number }> = [];
	text.split(/\r\n|\n/).forEach((line, lineIndex) => {
		syncedTagWithLeadingSpacePattern.lastIndex = 0;
		let match = syncedTagWithLeadingSpacePattern.exec(line);
		while (match !== null) {
			ranges.push({ line: lineIndex, start: match.index, end: match.index + match[0].length });
			match = syncedTagWithLeadingSpacePattern.exec(line);
		}
	});
	return ranges;
}

function isTodoDocument(document: vscode.TextDocument): boolean {
	return document.uri.fsPath.endsWith('.todo');
}

/** Shared by the manual command and the save-triggered sync: reads the given .todo file,
 * writes its parsed tasks.json alongside it, then reconciles it against GitHub. */
async function runTodoSync(todoUri: vscode.Uri): Promise<void> {
	let items: Item[];
	try {
		items = await readItems(todoUri);
		const outputUri = vscode.Uri.joinPath(todoUri, '..', 'tasks.json');
		const json = JSON.stringify(items, null, 2);
		await vscode.workspace.fs.writeFile(outputUri, new TextEncoder().encode(json));
	} catch (err) {
		vscode.window.showErrorMessage(`tinbot: could not sync tasks: ${err}`);
		return;
	}

	try {
		await syncWithGithub(todoUri, items);
	} catch (err) {
		vscode.window.showErrorMessage(`tinbot: could not sync issues to GitHub: ${err}`);
	}
}

let baseUriOverride: vscode.Uri | undefined;

/** Test-only seam: lets tests point the command at a fixture dir instead of the real extension path. */
export function __setTestBaseUri(uri: vscode.Uri | undefined): void {
	baseUriOverride = uri;
}

export function activate(context: vscode.ExtensionContext) {
	const syncedDecorationType = vscode.window.createTextEditorDecorationType({ opacity: '0.3' });

	const updateSyncedDecorations = (editor: vscode.TextEditor | undefined): void => {
		if (editor === undefined || !isTodoDocument(editor.document)) {
			return;
		}
		const ranges = findSyncedTagRanges(editor.document.getText()).map(
			({ line, start, end }) => new vscode.Range(line, start, line, end),
		);
		editor.setDecorations(syncedDecorationType, ranges);
	};

	updateSyncedDecorations(vscode.window.activeTextEditor);

	context.subscriptions.push(
		syncedDecorationType,
		vscode.window.onDidChangeActiveTextEditor(updateSyncedDecorations),
		vscode.workspace.onDidChangeTextDocument((event) => {
			const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document === event.document);
			updateSyncedDecorations(editor);
		}),
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (isTodoDocument(document)) {
				void runTodoSync(document.uri);
			}
		}),
	);

	const disposable = vscode.commands.registerCommand('tinbot.todoSyncGithub', async () => {
		const baseUri = baseUriOverride ?? context.extensionUri;
		await runTodoSync(vscode.Uri.joinPath(baseUri, 'task_list.todo'));
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
