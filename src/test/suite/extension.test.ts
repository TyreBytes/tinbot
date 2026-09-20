import * as assert from 'assert';
import * as vscode from 'vscode';
import { __setTestBaseUri, parseTasks, readTasks } from '../../extension';
import { cleanupTaskListFixture, createTaskListFixture } from '../testUtils';

suite('parseTasks - Zero/One/Many/Boundaries', () => {
	test('Zero: empty text resolves to no tasks', () => {
		assert.deepStrictEqual(parseTasks(''), []);
	});

	test('Zero: whitespace-only text resolves to no tasks', () => {
		assert.deepStrictEqual(parseTasks('\n   \n\t\n\n'), []);
	});

	test('One: single unchecked task line returns one pending task', () => {
		assert.deepStrictEqual(parseTasks('☐ Buy milk'), [{ name: 'Buy milk', done: false }]);
	});

	test('One: single checked task line returns one done task', () => {
		assert.deepStrictEqual(parseTasks('✔ Buy milk'), [{ name: 'Buy milk', done: true }]);
	});

	test('Many: multiple lines with blanks interspersed returns every task in order', () => {
		const text = '\n☐ First task\n\n✔ Second task done\n☐ Third task\n';
		assert.deepStrictEqual(parseTasks(text), [
			{ name: 'First task', done: false },
			{ name: 'Second task done', done: true },
			{ name: 'Third task', done: false },
		]);
	});

	test('Boundaries: leading blank lines before the task lines are skipped', () => {
		assert.deepStrictEqual(parseTasks('\n\n\n☐ Do the thing'), [{ name: 'Do the thing', done: false }]);
	});

	test('Boundaries: trailing whitespace and tabs on a task line are trimmed', () => {
		assert.deepStrictEqual(parseTasks('☐ Do the thing   \t\t'), [{ name: 'Do the thing', done: false }]);
	});

	test('Boundaries: a checkbox marker with no text after it is excluded', () => {
		assert.deepStrictEqual(parseTasks('☐'), []);
	});

	test('Boundaries: a checkbox marker followed only by spaces is excluded', () => {
		assert.deepStrictEqual(parseTasks('☐   '), []);
	});

	test('Boundaries: a line with no checkbox prefix is included as-is, trimmed', () => {
		assert.deepStrictEqual(parseTasks('  Just plain text, no marker  '), [
			{ name: 'Just plain text, no marker', done: false },
		]);
	});

	test('Boundaries: CRLF line endings leave no stray \\r in any task name', () => {
		const tasks = parseTasks('☐ Task with CRLF\r\n\r\n☐ Second\r\n');
		assert.deepStrictEqual(tasks, [
			{ name: 'Task with CRLF', done: false },
			{ name: 'Second', done: false },
		]);
		assert.ok(tasks.every((task) => !task.name.includes('\r')));
	});
});

suite('readTasks - Exercise exceptions', () => {
	let fixtureDir: string | undefined;

	teardown(async () => {
		await cleanupTaskListFixture(fixtureDir!);
	});

	test('rejects when task_list.todo does not exist', async () => {
		const { uri, dir } = await createTaskListFixture(undefined);
		fixtureDir = dir;
		await assert.rejects(readTasks(uri), (err: any) => err.code === 'FileNotFound');
	});
});

suite('tinbot.todoSyncGithub command - Interface', () => {
	// Simple scenario / Interface contract test: exercises real command registration
	// -> readTasks -> tasks.json write, against the real bundled task_list.todo.
	test('todoSyncGithub command writes tasks.json next to the real task_list.todo', async () => {
		const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'tinbot');
		assert.ok(extension, 'tinbot extension not found');

		const expected = await readTasks(extension!.extensionUri);
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
