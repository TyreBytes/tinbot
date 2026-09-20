import * as assert from 'assert';
import * as vscode from 'vscode';
import { __setTestBaseUri, readFirstTask } from '../../extension';
import { cleanupTaskListFixture, createTaskListFixture } from '../testUtils';

suite('readFirstTask - Zero/One/Many/Boundaries', () => {
	let fixtureDir: string | undefined;

	teardown(async () => {
		if (fixtureDir) {
			await cleanupTaskListFixture(fixtureDir);
			fixtureDir = undefined;
		}
	});

	test('Zero: empty file resolves to empty string', async () => {
		const { uri, dir } = await createTaskListFixture('');
		fixtureDir = dir;
		assert.strictEqual(await readFirstTask(uri), '');
	});

	test('Zero: whitespace-only file resolves to empty string', async () => {
		const { uri, dir } = await createTaskListFixture('\n   \n\t\n\n');
		fixtureDir = dir;
		assert.strictEqual(await readFirstTask(uri), '');
	});

	test('One: single unchecked task line returns its cleaned text', async () => {
		const { uri, dir } = await createTaskListFixture('☐ Buy milk');
		fixtureDir = dir;
		assert.strictEqual(await readFirstTask(uri), 'Buy milk');
	});

	test('One: single checked task line returns its cleaned text', async () => {
		const { uri, dir } = await createTaskListFixture('✔ Buy milk');
		fixtureDir = dir;
		assert.strictEqual(await readFirstTask(uri), 'Buy milk');
	});

	test('Many: multiple lines with blanks interspersed returns only the first non-blank line', async () => {
		const { uri, dir } = await createTaskListFixture(
			'\n☐ First task\n\n✔ Second task done\n☐ Third task\n'
		);
		fixtureDir = dir;
		assert.strictEqual(await readFirstTask(uri), 'First task');
	});

	test('Boundaries: leading blank lines before the task line are skipped', async () => {
		const { uri, dir } = await createTaskListFixture('\n\n\n☐ Do the thing');
		fixtureDir = dir;
		assert.strictEqual(await readFirstTask(uri), 'Do the thing');
	});

	test('Boundaries: trailing whitespace and tabs on the task line are trimmed', async () => {
		const { uri, dir } = await createTaskListFixture('☐ Do the thing   \t\t');
		fixtureDir = dir;
		assert.strictEqual(await readFirstTask(uri), 'Do the thing');
	});

	test('Boundaries: checkbox marker with no text after it resolves to empty string', async () => {
		const { uri, dir } = await createTaskListFixture('☐');
		fixtureDir = dir;
		assert.strictEqual(await readFirstTask(uri), '');
	});

	test('Boundaries: checkbox marker followed only by spaces resolves to empty string', async () => {
		const { uri, dir } = await createTaskListFixture('☐   ');
		fixtureDir = dir;
		assert.strictEqual(await readFirstTask(uri), '');
	});

	test('Boundaries: first line with no checkbox prefix is returned as-is, trimmed', async () => {
		const { uri, dir } = await createTaskListFixture('  Just plain text, no marker  ');
		fixtureDir = dir;
		assert.strictEqual(await readFirstTask(uri), 'Just plain text, no marker');
	});

	test('Boundaries: CRLF line endings leave no stray \\r in the returned string', async () => {
		const { uri, dir } = await createTaskListFixture('☐ Task with CRLF\r\n\r\n☐ Second\r\n');
		fixtureDir = dir;
		const result = await readFirstTask(uri);
		assert.strictEqual(result, 'Task with CRLF');
		assert.ok(!result.includes('\r'));
	});
});

suite('readFirstTask - Exercise exceptions', () => {
	let fixtureDir: string | undefined;

	teardown(async () => {
		if (fixtureDir) {
			await cleanupTaskListFixture(fixtureDir);
			fixtureDir = undefined;
		}
	});

	test('rejects when task_list.todo does not exist', async () => {
		const { uri, dir } = await createTaskListFixture(undefined);
		fixtureDir = dir;
		await assert.rejects(readFirstTask(uri), (err: any) => err.code === 'FileNotFound');
	});
});

suite('tinbot.helloWorld command - Interface', () => {
	// Simple scenario / Interface contract test: exercises real command registration
	// -> readFirstTask -> showInformationMessage wiring against the real bundled task_list.todo.
	test('helloWorld command shows the first task from task_list.todo', async () => {
		const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'tinbot');
		assert.ok(extension, 'tinbot extension not found');

		const expected = await readFirstTask(extension!.extensionUri);

		const original = vscode.window.showInformationMessage;
		let captured: string | undefined;
		(vscode.window as any).showInformationMessage = (message: string) => {
			captured = message;
			return Promise.resolve(undefined);
		};

		try {
			await vscode.commands.executeCommand('tinbot.helloWorld');
			assert.strictEqual(captured, expected);
		} finally {
			(vscode.window as any).showInformationMessage = original;
		}
	});

	test('tinbot.helloWorld is registered and discoverable via getCommands', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('tinbot.helloWorld'));
	});
});

suite('tinbot.helloWorld command - Exercise exceptions', () => {
	let fixtureDir: string | undefined;
	let originalShowErrorMessage: typeof vscode.window.showErrorMessage;

	teardown(async () => {
		__setTestBaseUri(undefined);
		(vscode.window as any).showErrorMessage = originalShowErrorMessage;
		if (fixtureDir) {
			await cleanupTaskListFixture(fixtureDir);
			fixtureDir = undefined;
		}
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

		await vscode.commands.executeCommand('tinbot.helloWorld');
		assert.ok(captured);
		assert.ok(captured!.includes('could not read task_list.todo'));
	});
});
