import * as vscode from 'vscode';

export interface Item {
	kind: 'section' | 'task';
	name: string;
	status?: 'done' | 'cancelled';
	description?: string;
	tags?: string[];
	completedDate?: string;
	cancelledDate?: string;
	children: Item[];
}

const sectionHeaderPattern = /^#+\s*(.+):$/;
const taskMarkerPattern = /^[☐✔✘]\s*/;
const doneTagPattern = /@done\(([^)]+)\)/;
const cancelledTagPattern = /@cancelled\(([^)]+)\)/;
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

	for (const rawLine of text.split(/\r?\n/)) {
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

export async function readItems(baseUri: vscode.Uri): Promise<Item[]> {
	const fileUri = vscode.Uri.joinPath(baseUri, 'task_list.todo');
	const bytes = await vscode.workspace.fs.readFile(fileUri);
	const text = new TextDecoder('utf-8').decode(bytes);
	return parseItems(text);
}

let baseUriOverride: vscode.Uri | undefined;

/** Test-only seam: lets tests point the command at a fixture dir instead of the real extension path. */
export function __setTestBaseUri(uri: vscode.Uri | undefined): void {
	baseUriOverride = uri;
}

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('tinbot.todoSyncGithub', async () => {
		try {
			const baseUri = baseUriOverride ?? context.extensionUri;
			const items = await readItems(baseUri);
			const outputUri = vscode.Uri.joinPath(baseUri, 'tasks.json');
			const json = JSON.stringify(items, null, 2);
			await vscode.workspace.fs.writeFile(outputUri, new TextEncoder().encode(json));
		} catch (err) {
			vscode.window.showErrorMessage(`tinbot: could not sync tasks: ${err}`);
		}
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
