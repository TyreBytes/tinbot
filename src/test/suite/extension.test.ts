import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	__setTestBaseUri,
	collectKnownIssueIds,
	collectKnownIssueMatches,
	collectUnsyncedIssues,
	decideSyncDirection,
	findSyncedTagRanges,
	getItemSourceLine,
	issueMatchesGithub,
	Item,
	parseItems,
	readItems,
} from '../../extension';
import { formatSyncedStamp, GithubIssue } from '../../github';
import { cleanupTaskListFixture, createTaskListFixture, waitForFile } from '../testUtils';

function makeIssue(number: number, title: string, extra: Partial<GithubIssue> = {}): GithubIssue {
	return { number, title, state: 'open', updatedAt: '2026-09-20T09:00:00.000Z', ...extra };
}

function makeIssueItem(overrides: Partial<Item> = {}): Item {
	return { kind: 'issue', name: 'Fix the build', issueId: 5, children: [], ...overrides };
}

suite('parseItems - Zero/One/Many/Boundaries', () => {
	test('Zero: empty text resolves to no items', () => {
		assert.deepStrictEqual(parseItems(''), []);
	});

	test('One: a single section line parses into one section Item', () => {
		assert.deepStrictEqual(parseItems('# Tin Bot Project:'), [
			{ kind: 'section', name: 'Tin Bot Project', children: [] },
		]);
	});

	test('One: a single open task line parses into one task Item with no status', () => {
		assert.deepStrictEqual(parseItems('☐ Buy milk'), [{ kind: 'task', name: 'Buy milk', children: [] }]);
	});

	test('Many: top-level lines with blanks interspersed become siblings with no shared parent', () => {
		const text = '☐ First task\n\n☐ Second task\n# A Header:\n☐ Third task';
		const items = parseItems(text);
		assert.deepStrictEqual(
			items.map((item) => item.name),
			['First task', 'Second task', 'A Header', 'Third task'],
		);
	});

	test('Boundaries: a task indented under a section becomes a child of that section', () => {
		const text = '# Race Weekend:\n\t☐ Race Result Screen';
		assert.deepStrictEqual(parseItems(text), [
			{
				kind: 'section',
				name: 'Race Weekend',
				children: [{ kind: 'task', name: 'Race Result Screen', children: [] }],
			},
		]);
	});

	test('Boundaries: a task indented under a task becomes a child of that task', () => {
		const text = '☐ Race Result Screen\n\t☐ sub task of race results screen.\n\t✔ car icons';
		assert.deepStrictEqual(parseItems(text), [
			{
				kind: 'task',
				name: 'Race Result Screen',
				children: [
					{ kind: 'task', name: 'sub task of race results screen.', children: [] },
					{ kind: 'task', name: 'car icons', status: 'done', children: [] },
				],
			},
		]);
	});

	test('Boundaries: the # count on a header does not change its Depth relative to indentation', () => {
		const text = '# Tin Bot Project:\n\t## Alpha Stage:\n\t# Pain Points of TurtleBrains:';
		const items = parseItems(text);
		assert.deepStrictEqual(
			items[0].children.map((child) => child.name),
			['Alpha Stage', 'Pain Points of TurtleBrains'],
		);
	});

	test('Boundaries: a done marker (✔) line parses into a task Item with status done', () => {
		assert.deepStrictEqual(parseItems('✔ Sign NDA'), [
			{ kind: 'task', name: 'Sign NDA', status: 'done', children: [] },
		]);
	});

	test('Boundaries: a cancelled marker (✘) line parses into a task Item with status cancelled', () => {
		assert.deepStrictEqual(parseItems('✘ Dropped feature'), [
			{ kind: 'task', name: 'Dropped feature', status: 'cancelled', children: [] },
		]);
	});

	test('Boundaries: an open marker (☐) line parses into a task Item with no status field', () => {
		const items = parseItems('☐ Open task');
		assert.deepStrictEqual(items, [{ kind: 'task', name: 'Open task', children: [] }]);
		assert.ok(!Object.prototype.hasOwnProperty.call(items[0], 'status'));
	});

	test('Boundaries: a section never carries a status field', () => {
		const items = parseItems('# A Header:');
		assert.ok(!Object.prototype.hasOwnProperty.call(items[0], 'status'));
	});

	test('Boundaries: a checkbox marker with no text after it is excluded', () => {
		assert.deepStrictEqual(parseItems('☐'), []);
	});

	test('Boundaries: a plain text line with no marker produces no Item of its own', () => {
		assert.deepStrictEqual(parseItems('☐ Get milk\n\tThis is a description line.'), [
			{ kind: 'task', name: 'Get milk', description: 'This is a description line.', children: [] },
		]);
	});
});

suite('parseItems - description blocks', () => {
	test('Zero: a task with no plain-text children has no description field', () => {
		const items = parseItems('☐ Buy milk');
		assert.ok(!Object.prototype.hasOwnProperty.call(items[0], 'description'));
	});

	test('One: a single plain-text line under a task becomes its description', () => {
		const text = '☐ Get milk\n\tOne line of notes.';
		assert.deepStrictEqual(parseItems(text), [
			{ kind: 'task', name: 'Get milk', description: 'One line of notes.', children: [] },
		]);
	});

	test('Many: a blank line inside one run of plain text stays inside a single description block', () => {
		const text = '☐ Get milk\n\tFirst line.\n\n\tSecond line.';
		assert.deepStrictEqual(parseItems(text), [
			{ kind: 'task', name: 'Get milk', description: 'First line.\n\nSecond line.', children: [] },
		]);
	});

	test('Boundaries: description text before, between, and after marked children joins into one description, in file order', () => {
		const text =
			'☐ Race Result Screen\n' +
			'\tBefore text.\n' +
			'\t☐ sub task one\n' +
			'\tBetween text.\n' +
			'\t☐ sub task two\n' +
			'\tAfter text.';
		assert.deepStrictEqual(parseItems(text), [
			{
				kind: 'task',
				name: 'Race Result Screen',
				description: 'Before text.\n\nBetween text.\n\nAfter text.',
				children: [
					{ kind: 'task', name: 'sub task one', children: [] },
					{ kind: 'task', name: 'sub task two', children: [] },
				],
			},
		]);
	});

	test('Boundaries: leading and trailing blank lines around a description block are trimmed', () => {
		const text = '☐ Get milk\n\n\tPadded line.\n\n';
		assert.deepStrictEqual(parseItems(text), [
			{ kind: 'task', name: 'Get milk', description: 'Padded line.', children: [] },
		]);
	});
});

suite('parseItems - tags and dates', () => {
	test('Zero: a line with no @tag token has no tags, completedDate, or cancelledDate fields', () => {
		const items = parseItems('☐ Buy milk');
		assert.ok(!Object.prototype.hasOwnProperty.call(items[0], 'tags'));
		assert.ok(!Object.prototype.hasOwnProperty.call(items[0], 'completedDate'));
		assert.ok(!Object.prototype.hasOwnProperty.call(items[0], 'cancelledDate'));
	});

	test('One: an @done(...) token is removed from name and stored in completedDate', () => {
		assert.deepStrictEqual(parseItems('✔ Sign NDA @done(25-11-05 20:01)'), [
			{ kind: 'task', name: 'Sign NDA', status: 'done', completedDate: '25-11-05 20:01', children: [] },
		]);
	});

	test('One: an @cancelled(...) token is removed from name and stored in cancelledDate', () => {
		assert.deepStrictEqual(parseItems('✘ Dropped feature @cancelled(20260920 09:34)'), [
			{ kind: 'task', name: 'Dropped feature', status: 'cancelled', cancelledDate: '20260920 09:34', children: [] },
		]);
	});

	test('Many: several plain @tag tokens are removed from name and collected into tags, in order', () => {
		assert.deepStrictEqual(parseItems('✔ @hp2 @value5 SetRotation() @done(20251025 08:31)'), [
			{
				kind: 'task',
				name: 'SetRotation()',
				status: 'done',
				tags: ['hp2', 'value5'],
				completedDate: '20251025 08:31',
				children: [],
			},
		]);
	});

	test('Boundaries: an @api-break tag with a hyphen parses as one tag', () => {
		assert.deepStrictEqual(parseItems('☐ Fix this @api-break'), [
			{ kind: 'task', name: 'Fix this', tags: ['api-break'], children: [] },
		]);
	});

	test('Boundaries: tag removal leaves no double space where a tag used to sit', () => {
		const items = parseItems('☐ Word @hp2 word');
		assert.strictEqual(items[0].name, 'Word word');
	});

	test('Boundaries: a section line runs through the same tag extraction as a task line', () => {
		assert.deepStrictEqual(parseItems('# Race Weekend @hp2:'), [
			{ kind: 'section', name: 'Race Weekend', tags: ['hp2'], children: [] },
		]);
	});
});

suite('parseItems - @issue kind', () => {
	test('Zero: a checkbox line with no @issue tag keeps kind task and no issueId', () => {
		const items = parseItems('☐ Buy milk');
		assert.strictEqual(items[0].kind, 'task');
		assert.ok(!Object.prototype.hasOwnProperty.call(items[0], 'issueId'));
	});

	test('One: a bare @issue tag parses into kind issue with issueId unset', () => {
		assert.deepStrictEqual(parseItems('☐ @issue Fix sound issue and merge crusher'), [
			{ kind: 'issue', name: 'Fix sound issue and merge crusher', children: [] },
		]);
	});

	test('One: an @issueN tag parses into kind issue with the number in issueId', () => {
		assert.deepStrictEqual(parseItems('☐ @issue1 Create a Rushcremental title/logo'), [
			{ kind: 'issue', name: 'Create a Rushcremental title/logo', issueId: 1, children: [] },
		]);
	});

	test('Many: an issue Item still carries status, tags, and completedDate like a task', () => {
		assert.deepStrictEqual(parseItems('✔ @issue42 @hp2 Ship the feature @done(20260920 09:00)'), [
			{
				kind: 'issue',
				name: 'Ship the feature',
				status: 'done',
				tags: ['hp2'],
				completedDate: '20260920 09:00',
				issueId: 42,
				children: [],
			},
		]);
	});

	test('Boundaries: a header line never becomes kind issue, even with an @issue tag in its title', () => {
		assert.deepStrictEqual(parseItems('# Backlog @issue3:'), [
			{ kind: 'section', name: 'Backlog', tags: ['issue3'], children: [] },
		]);
	});
});

suite('getItemSourceLine - Zero/One/Many/Boundaries', () => {
	test('One: a single top-level task records line 0', () => {
		const items = parseItems('☐ Buy milk');
		assert.strictEqual(getItemSourceLine(items[0]), 0);
	});

	test('One: a task after leading blank lines records its true line index', () => {
		const items = parseItems('\n\n☐ Buy milk');
		assert.strictEqual(getItemSourceLine(items[0]), 2);
	});

	test('Many: a section and its nested child each record their own line index', () => {
		const items = parseItems('# Race Weekend:\n\t☐ Race Result Screen');
		assert.strictEqual(getItemSourceLine(items[0]), 0);
		assert.strictEqual(getItemSourceLine(items[0].children[0]), 1);
	});

	test('Boundaries: an item parsed from text with no trailing newline still records correctly', () => {
		const items = parseItems('☐ First\n☐ Second');
		assert.strictEqual(getItemSourceLine(items[1]), 1);
	});

	test('Boundaries: a hand-built Item never produced by parseItems has no recorded line', () => {
		const item = { kind: 'task' as const, name: 'Not parsed', children: [] };
		assert.strictEqual(getItemSourceLine(item), undefined);
	});
});

suite('collectUnsyncedIssues - Zero/One/Many/Boundaries', () => {
	test('Zero: a tree with only tasks and sections returns no issues', () => {
		const items = parseItems('# Section:\n\t☐ A task');
		assert.deepStrictEqual(collectUnsyncedIssues(items), []);
	});

	test('One: a single unsynced issue is returned', () => {
		const items = parseItems('☐ @issue Fix sound issue and merge crusher');
		assert.deepStrictEqual(collectUnsyncedIssues(items), items);
	});

	test('Many: unsynced issues nested at multiple depths are all returned, in document order', () => {
		const text = '☐ @issue Top level issue\n# Section:\n\t☐ @issue Nested issue';
		const items = parseItems(text);
		const unsynced = collectUnsyncedIssues(items);
		assert.deepStrictEqual(
			unsynced.map((item) => item.name),
			['Top level issue', 'Nested issue'],
		);
	});

	test('Boundaries: an already-synced issue and a plain task are both skipped', () => {
		const text = '☐ @issue1 Already synced\n☐ Plain task';
		const items = parseItems(text);
		assert.deepStrictEqual(collectUnsyncedIssues(items), []);
	});
});

suite('collectKnownIssueIds - Zero/One/Many/Boundaries', () => {
	test('Zero: a tree with no issues returns an empty set', () => {
		const items = parseItems('☐ Plain task');
		assert.deepStrictEqual(collectKnownIssueIds(items), new Set());
	});

	test('One: a single synced issue is included', () => {
		const items = parseItems('☐ @issue5 Fix the build');
		assert.deepStrictEqual(collectKnownIssueIds(items), new Set([5]));
	});

	test('Many: synced issue ids nested at multiple depths are all included', () => {
		const text = '☐ @issue4 Parent\n\t☐ @issue6 Child\n# Section:\n\t☐ @issue7 In a section';
		const items = parseItems(text);
		assert.deepStrictEqual(collectKnownIssueIds(items), new Set([4, 6, 7]));
	});

	test('Boundaries: an unsynced @issue tag with no number is not included', () => {
		const items = parseItems('☐ @issue Not synced yet');
		assert.deepStrictEqual(collectKnownIssueIds(items), new Set());
	});
});

suite('parseItems - @synced tag', () => {
	test('Zero: a line with no @synced tag has no syncedAt field', () => {
		const items = parseItems('☐ @issue5 Fix the build');
		assert.ok(!Object.prototype.hasOwnProperty.call(items[0], 'syncedAt'));
	});

	test('One: an @synced(...) token is removed from name and stored in syncedAt', () => {
		assert.deepStrictEqual(parseItems('☐ @issue5 Fix the build @synced(20260920 09:00)'), [
			{ kind: 'issue', name: 'Fix the build', issueId: 5, syncedAt: '20260920 09:00', children: [] },
		]);
	});
});

suite('issueMatchesGithub - Zero/One/Many/Boundaries', () => {
	test('Zero: identical title, status, and description match', () => {
		const item = makeIssueItem({ description: 'Some details.' });
		const issue = makeIssue(5, 'Fix the build', { body: 'Some details.' });
		assert.strictEqual(issueMatchesGithub(item, issue), true);
	});

	test('One: a differing title does not match', () => {
		const item = makeIssueItem({ name: 'Fix the build' });
		const issue = makeIssue(5, 'A different title');
		assert.strictEqual(issueMatchesGithub(item, issue), false);
	});

	test('One: a differing status does not match', () => {
		const item = makeIssueItem({ status: 'done' });
		const issue = makeIssue(5, 'Fix the build', { state: 'open' });
		assert.strictEqual(issueMatchesGithub(item, issue), false);
	});

	test('Many: an undefined todo description and an empty GitHub body count as equal', () => {
		const item = makeIssueItem();
		const issue = makeIssue(5, 'Fix the build', { body: undefined });
		assert.strictEqual(issueMatchesGithub(item, issue), true);
	});

	test('Boundaries: a genuinely differing description does not match', () => {
		const item = makeIssueItem({ description: 'Todo description.' });
		const issue = makeIssue(5, 'Fix the build', { body: 'GitHub description.' });
		assert.strictEqual(issueMatchesGithub(item, issue), false);
	});
});

suite('decideSyncDirection - Zero/One/Many/Boundaries', () => {
	const now = new Date('2026-09-20T09:30:00.000Z');
	const lastSyncedAt = new Date('2026-09-20T09:00:00.000Z');

	test('Zero: no @synced stamp yet always baselines, even when both sides already match', () => {
		const item = makeIssueItem();
		const issue = makeIssue(5, 'Fix the build');
		assert.strictEqual(decideSyncDirection(item, issue), 'baseline');
	});

	test('Zero: no @synced stamp yet baselines even when the sides differ', () => {
		const item = makeIssueItem({ name: 'Fix the build' });
		const issue = makeIssue(5, 'A different title on GitHub');
		assert.strictEqual(decideSyncDirection(item, issue), 'baseline');
	});

	test('One: GitHub updated after the last sync pulls', () => {
		const item = makeIssueItem({ syncedAt: formatSyncedStamp(lastSyncedAt) });
		const githubUpdatedAt = new Date('2026-09-20T09:15:00.000Z');
		const issue = makeIssue(5, 'A new title on GitHub', { updatedAt: githubUpdatedAt.toISOString() });
		assert.strictEqual(decideSyncDirection(item, issue), 'pull');
	});

	test('One: GitHub unchanged since the last sync but the todo file differs pushes', () => {
		const item = makeIssueItem({ name: 'A new todo title', syncedAt: formatSyncedStamp(lastSyncedAt) });
		const issue = makeIssue(5, 'Fix the build', { updatedAt: lastSyncedAt.toISOString() });
		assert.strictEqual(decideSyncDirection(item, issue), 'push');
	});

	test('Many: GitHub unchanged since the last sync and both sides match needs no action', () => {
		const item = makeIssueItem({ syncedAt: formatSyncedStamp(lastSyncedAt) });
		const issue = makeIssue(5, 'Fix the build', { updatedAt: lastSyncedAt.toISOString() });
		assert.strictEqual(decideSyncDirection(item, issue), 'none');
	});

	test('Boundaries: a GitHub updatedAt exactly equal to the last sync stamp is not treated as a pull', () => {
		const item = makeIssueItem({ name: 'A new todo title', syncedAt: formatSyncedStamp(lastSyncedAt) });
		const issue = makeIssue(5, 'Fix the build', { updatedAt: lastSyncedAt.toISOString() });
		assert.notStrictEqual(decideSyncDirection(item, issue), 'pull');
	});
});

suite('collectKnownIssueMatches - Zero/One/Many/Boundaries', () => {
	test('Zero: no issues in the tree returns no matches', () => {
		const items = parseItems('☐ Plain task');
		assert.deepStrictEqual(collectKnownIssueMatches(items, [makeIssue(5, 'Unrelated')]), []);
	});

	test('One: a single known issue is matched to its GitHub counterpart', () => {
		const items = parseItems('☐ @issue5 Fix the build');
		const issue = makeIssue(5, 'Fix the build');
		assert.deepStrictEqual(collectKnownIssueMatches(items, [issue]), [{ item: items[0], issue }]);
	});

	test('Many: several known issues nested at multiple depths are all matched, in tree order', () => {
		const text = '☐ @issue4 Parent\n\t☐ @issue6 Child';
		const items = parseItems(text);
		const parentIssue = makeIssue(4, 'Parent');
		const childIssue = makeIssue(6, 'Child');
		assert.deepStrictEqual(collectKnownIssueMatches(items, [childIssue, parentIssue]), [
			{ item: items[0], issue: parentIssue },
			{ item: items[0].children[0], issue: childIssue },
		]);
	});

	test('Boundaries: a GitHub issue not referenced by any todo item is simply not matched', () => {
		const items = parseItems('☐ @issue5 Fix the build');
		const matches = collectKnownIssueMatches(items, [makeIssue(5, 'Fix the build'), makeIssue(9, 'Unrelated issue')]);
		assert.strictEqual(matches.length, 1);
	});

	test('Boundaries: an unsynced issue with no issueId is skipped', () => {
		const items = parseItems('☐ @issue Fix the build');
		assert.deepStrictEqual(collectKnownIssueMatches(items, [makeIssue(5, 'Fix the build')]), []);
	});
});

suite('findSyncedTagRanges - Zero/One/Many/Boundaries', () => {
	test('Zero: text with no @synced tag returns no ranges', () => {
		assert.deepStrictEqual(findSyncedTagRanges('☐ @issue5 Fix the build'), []);
	});

	test('One: a single @synced tag is found, including its leading space', () => {
		const text = '☐ @issue5 Fix the build @synced(20260920 09:00)';
		const ranges = findSyncedTagRanges(text);
		assert.strictEqual(ranges.length, 1);
		assert.strictEqual(text.slice(ranges[0].start, ranges[0].end), ' @synced(20260920 09:00)');
	});

	test('Many: a @synced tag on each of several lines is found once per line, with the right line index', () => {
		const text = '☐ @issue5 First @synced(20260920 09:00)\n☐ @issue6 Second @synced(20260920 09:00)';
		const ranges = findSyncedTagRanges(text);
		assert.deepStrictEqual(
			ranges.map((range) => range.line),
			[0, 1],
		);
	});

	test('Boundaries: a tag containing an internal space is matched as one range', () => {
		const text = '☐ @issue5 Fix the build @synced(20260920 09:00)';
		const ranges = findSyncedTagRanges(text);
		assert.strictEqual(ranges[0].end - ranges[0].start, ' @synced(20260920 09:00)'.length);
	});
});

suite('readItems - Exercise exceptions', () => {
	let fixtureDir: string | undefined;

	teardown(async () => {
		await cleanupTaskListFixture(fixtureDir!);
	});

	test('rejects when task_list.todo does not exist', async () => {
		const { uri, dir } = await createTaskListFixture(undefined);
		fixtureDir = dir;
		await assert.rejects(readItems(vscode.Uri.joinPath(uri, 'task_list.todo')), (err: any) => err.code === 'FileNotFound');
	});
});

suite('tinbot.todoSyncGithub command - Interface', () => {
	// Simple scenario / Interface contract test: exercises real command registration
	// -> readItems -> tasks.json write, against the real bundled task_list.todo.
	test('todoSyncGithub command writes tasks.json next to the real task_list.todo', async function () {
		// A real project_settings.secret makes this call out to the live GitHub API
		// (push, then list, then a parent lookup per new issue), well past mocha's default 2s.
		this.timeout(20000);

		const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'tinbot');
		assert.ok(extension, 'tinbot extension not found');

		const expected = await readItems(vscode.Uri.joinPath(extension!.extensionUri, 'task_list.todo'));
		const outputUri = vscode.Uri.joinPath(extension!.extensionUri, 'tasks.json');

		try {
			await vscode.commands.executeCommand('tinbot.todoSyncGithub');
			const bytes = await vscode.workspace.fs.readFile(outputUri);
			const actual = JSON.parse(new TextDecoder('utf-8').decode(bytes));
			assert.deepStrictEqual(actual, expected);
		} catch (err) {
			assert.fail(`tinbot.todoSyncGithub command threw: ${err}`);
		} finally {
			await vscode.workspace.fs.delete(outputUri, { useTrash: false });
		}
	});

	test('tinbot.todoSyncGithub is registered and discoverable via getCommands', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('tinbot.todoSyncGithub'));
	});
});

suite('tinbot.todoSyncGithub command - Exercise exceptions', () => {
	let fixtureDir: string | undefined;
	let originalShowErrorMessage: typeof vscode.window.showErrorMessage;

	teardown(async () => {
		__setTestBaseUri(undefined);
		(vscode.window as any).showErrorMessage = originalShowErrorMessage;
		await cleanupTaskListFixture(fixtureDir!);
	});

	test('shows an error message when task_list.todo is missing', async () => {
		const { uri, dir } = await createTaskListFixture(undefined);
		fixtureDir = dir;
		__setTestBaseUri(uri);

		originalShowErrorMessage = vscode.window.showErrorMessage;
		let captured: string | undefined;
		(vscode.window as any).showErrorMessage = (message: string) => {
			captured = message;
			return Promise.resolve(undefined);
		};

		await vscode.commands.executeCommand('tinbot.todoSyncGithub');
		assert.ok(captured);
		assert.ok(captured!.includes('could not sync tasks'));
	});
});

suite('.todo save auto-sync - Interface', () => {
	let fixtureDir: string | undefined;

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await cleanupTaskListFixture(fixtureDir!);
	});

	test('saving any .todo file writes tasks.json alongside it, without running the command', async function () {
		this.timeout(10000);
		const { uri, dir } = await createTaskListFixture('☐ Buy milk');
		fixtureDir = dir;
		const todoUri = vscode.Uri.joinPath(uri, 'task_list.todo');
		const outputUri = vscode.Uri.joinPath(uri, 'tasks.json');

		const document = await vscode.workspace.openTextDocument(todoUri);
		const editor = await vscode.window.showTextDocument(document);
		await editor.edit((editBuilder) => {
			editBuilder.insert(new vscode.Position(0, document.lineAt(0).text.length), '\n☐ Another task');
		});
		await document.save();

		await waitForFile(outputUri, 5000);
		const bytes = await vscode.workspace.fs.readFile(outputUri);
		const actual = JSON.parse(new TextDecoder('utf-8').decode(bytes));
		assert.deepStrictEqual(actual, parseItems('☐ Buy milk\n☐ Another task'));
	});
});
