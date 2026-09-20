import * as assert from 'assert';
import * as vscode from 'vscode';

suite('tinbot extension', () => {
	test('helloWorld command shows the hello world message', async () => {
		const original = vscode.window.showInformationMessage;
		let captured: string | undefined;
		(vscode.window as any).showInformationMessage = (message: string) => {
			captured = message;
			return Promise.resolve(undefined);
		};

		try {
			await vscode.commands.executeCommand('tinbot.helloWorld');
			assert.strictEqual(captured, 'Hello, world!');
		} finally {
			(vscode.window as any).showInformationMessage = original;
		}
	});
});
