import * as vscode from 'vscode';

export interface Task {
	name: string;
	done: boolean;
}

export function parseTasks(text: string): Task[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => ({
			done: line.startsWith('✔'),
			name: line.replace(/^[☐✔]\s*/, '').trim(),
		}))
		.filter((task) => task.name.length > 0);
}

export async function readTasks(baseUri: vscode.Uri): Promise<Task[]> {
	const fileUri = vscode.Uri.joinPath(baseUri, 'task_list.todo');
	const bytes = await vscode.workspace.fs.readFile(fileUri);
	const text = new TextDecoder('utf-8').decode(bytes);
	return parseTasks(text);
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
			const tasks = await readTasks(baseUri);
			const outputUri = vscode.Uri.joinPath(baseUri, 'tasks.json');
			const json = JSON.stringify(tasks, null, 2);
			await vscode.workspace.fs.writeFile(outputUri, new TextEncoder().encode(json));
		} catch (err) {
			vscode.window.showErrorMessage(`tinbot: could not sync tasks: ${err}`);
		}
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
