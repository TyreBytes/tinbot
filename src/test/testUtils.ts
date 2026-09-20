import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Polls until a file exists, for asserting on the effect of a fire-and-forget event handler. */
export async function waitForFile(uri: vscode.Uri, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			await vscode.workspace.fs.stat(uri);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error(`waitForFile: ${uri.toString()} did not appear within ${timeoutMs}ms`);
}

export async function createTaskListFixture(content: string | undefined): Promise<{ uri: vscode.Uri; dir: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tinbot-test-'));
	if (content !== undefined) {
		await fs.promises.writeFile(path.join(dir, 'task_list.todo'), content, 'utf8');
	}
	return { uri: vscode.Uri.file(dir), dir };
}

export async function cleanupTaskListFixture(dir: string): Promise<void> {
	await fs.promises.rm(dir, { recursive: true, force: true });
}

/** Writes a tinbot.projectsFile-shaped JSON file to a fresh temp directory, for exercising
 * readProjectSettings without touching the real VS Code settings.json. */
export async function createProjectsSettingsFixture(projects: Record<string, unknown>): Promise<{ uri: vscode.Uri; dir: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tinbot-settings-'));
	const filePath = path.join(dir, 'projects.json');
	await fs.promises.writeFile(filePath, JSON.stringify(projects), 'utf8');
	return { uri: vscode.Uri.file(filePath), dir };
}
