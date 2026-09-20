import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('tinbot.helloWorld', () => {
		vscode.window.showInformationMessage('Hello, world!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
