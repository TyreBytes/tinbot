import * as vscode from 'vscode';

export async function readFirstTask(extensionUri: vscode.Uri): Promise<string> {
	const fileUri = vscode.Uri.joinPath(extensionUri, 'task_list.todo');
	const bytes = await vscode.workspace.fs.readFile(fileUri);
	const text = new TextDecoder('utf-8').decode(bytes);
	const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
	return line ? line.replace(/^[☐✔]\s*/, '').trim() : '';
}

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('tinbot.helloWorld', async () => {
		try {
			const message = await readFirstTask(context.extensionUri);
			vscode.window.showInformationMessage(message);
		} catch (err) {
			vscode.window.showErrorMessage(`tinbot: could not read task_list.todo: ${err}`);
		}
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
