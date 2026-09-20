import * as assert from 'assert';
import * as vscode from 'vscode';
import { __setTestBaseUri, parseItems, readItems } from '../../extension';
import { cleanupTaskListFixture, createTaskListFixture } from '../testUtils';

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

suite('readItems - Exercise exceptions', () => {
	let fixtureDir: string | undefined;

	teardown(async () => {
		await cleanupTaskListFixture(fixtureDir!);
	});

	test('rejects when task_list.todo does not exist', async () => {
		const { uri, dir } = await createTaskListFixture(undefined);
		fixtureDir = dir;
		await assert.rejects(readItems(uri), (err: any) => err.code === 'FileNotFound');
	});
});

suite('tinbot.todoSyncGithub command - Interface', () => {
	// Simple scenario / Interface contract test: exercises real command registration
	// -> readItems -> tasks.json write, against the real bundled task_list.todo.
	test('todoSyncGithub command writes tasks.json next to the real task_list.todo', async () => {
		const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'tinbot');
		assert.ok(extension, 'tinbot extension not found');

		const expected = await readItems(extension!.extensionUri);
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
