import * as assert from 'assert';
import * as vscode from 'vscode';
import { readFirstTask } from '../../extension';

suite('tinbot extension', () => {
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
});
