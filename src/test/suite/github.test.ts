import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	addIssuesToStaging,
	applyIssuePull,
	applyStampOnly,
	buildStagingForest,
	findDescriptionBlockExtent,
	formatSyncedStamp,
	GithubIssue,
	githubStatusToTodoStatus,
	parseSyncedStamp,
	patchIssueLine,
	readProjectSettings,
	renderDescriptionBlockLines,
	renderIssueLine,
	setSyncedTag,
	todoStatusToGithubPatch,
} from '../../github';
import { parseItems } from '../../extension';
import { cleanupTaskListFixture, createProjectsSettingsFixture } from '../testUtils';

function makeIssue(number: number, title: string, extra: Partial<GithubIssue> = {}): GithubIssue {
	return { id: number * 1000, number, title, state: 'open', updatedAt: '2026-09-20T09:00:00.000Z', ...extra };
}

suite('readProjectSettings - Zero/One/Many/Boundaries', () => {
	const todoUri = vscode.Uri.file('/fake/project/task_list.todo');
	const otherTodoUri = vscode.Uri.file('/fake/other-project/task_list.todo');
	let settingsDir: string | undefined;

	teardown(async () => {
		await vscode.workspace.getConfiguration('tinbot').update('projectsFile', undefined, vscode.ConfigurationTarget.Global);
		await cleanupTaskListFixture(settingsDir!);
	});

	async function useProjects(projects: Record<string, unknown>): Promise<void> {
		const fixture = await createProjectsSettingsFixture(projects);
		settingsDir = fixture.dir;
		await vscode.workspace.getConfiguration('tinbot').update('projectsFile', fixture.uri.fsPath, vscode.ConfigurationTarget.Global);
	}

	test('Zero: no entry for this file resolves to undefined', async () => {
		await useProjects({});
		assert.strictEqual(await readProjectSettings(todoUri), undefined);
	});

	test('One: a valid entry resolves to the parsed settings', async () => {
		await useProjects({ [todoUri.fsPath]: { github: { token: 'ghp_abc', owner: 'tyre-bytes', repo: 'tinbot' } } });

		assert.deepStrictEqual(await readProjectSettings(todoUri), {
			github: { token: 'ghp_abc', owner: 'tyre-bytes', repo: 'tinbot' },
		});
	});

	test('Boundaries: an entry missing github.token rejects naming that field', async () => {
		await useProjects({ [todoUri.fsPath]: { github: { owner: 'tyre-bytes', repo: 'tinbot' } } });

		await assert.rejects(readProjectSettings(todoUri), /github\.token/);
	});

	test('Many: an entry missing multiple fields rejects naming all of them', async () => {
		await useProjects({ [todoUri.fsPath]: { github: { token: 'ghp_abc' } } });

		await assert.rejects(
			readProjectSettings(todoUri),
			(err: Error) => err.message.includes('github.owner') && err.message.includes('github.repo'),
		);
	});

	test('Boundaries: a different .todo file\'s entry does not collide, even with the same base name', async () => {
		await useProjects({ [otherTodoUri.fsPath]: { github: { token: 'ghp_abc', owner: 'tyre-bytes', repo: 'tinbot' } } });

		assert.strictEqual(await readProjectSettings(todoUri), undefined);
	});
});

suite('readProjectSettings - settings file location', () => {
	teardown(async () => {
		await vscode.workspace.getConfiguration('tinbot').update('projectsFile', undefined, vscode.ConfigurationTarget.Global);
	});

	test('Boundaries: an unset tinbot.projectsFile resolves to undefined', async () => {
		assert.strictEqual(await readProjectSettings(vscode.Uri.file('/fake/project/task_list.todo')), undefined);
	});

	test('Boundaries: a tinbot.projectsFile pointing at a missing file resolves to undefined', async () => {
		await vscode.workspace
			.getConfiguration('tinbot')
			.update('projectsFile', '/fake/does-not-exist/projects.json', vscode.ConfigurationTarget.Global);

		assert.strictEqual(await readProjectSettings(vscode.Uri.file('/fake/project/task_list.todo')), undefined);
	});
});

suite('patchIssueLine - Zero/One/Many/Boundaries', () => {
	test('One: patches the bare @issue on the target line into @issueN', () => {
		assert.strictEqual(patchIssueLine('☐ @issue Fix sound issue and merge crusher', 0, 7), '☐ @issue7 Fix sound issue and merge crusher');
	});

	test('One: leaves every other line byte-identical', () => {
		const text = '☐ First\n☐ @issue Second\n☐ Third';
		assert.strictEqual(patchIssueLine(text, 1, 3), '☐ First\n☐ @issue3 Second\n☐ Third');
	});

	test('Many: preserves other @tags already present on the same line', () => {
		const text = '✔ @issue @hp2 Ship the feature @done(20260920 09:00:00)';
		assert.strictEqual(patchIssueLine(text, 0, 12), '✔ @issue12 @hp2 Ship the feature @done(20260920 09:00:00)');
	});

	test('Boundaries: \\r\\n line endings are preserved', () => {
		const text = '☐ First\r\n☐ @issue Second\r\n☐ Third';
		assert.strictEqual(patchIssueLine(text, 1, 5), '☐ First\r\n☐ @issue5 Second\r\n☐ Third');
	});

	test('Boundaries: a line with no bare @issue tag rejects', () => {
		assert.throws(() => patchIssueLine('☐ @issue3 Already synced', 0, 9), /no unsynced @issue tag/);
	});

	test('Boundaries: an out-of-range line number rejects', () => {
		assert.throws(() => patchIssueLine('☐ @issue Only line', 5, 9), /does not exist/);
	});
});

suite('buildStagingForest - Zero/One/Many/Boundaries', () => {
	test('Zero: no issues returns an empty forest', () => {
		assert.deepStrictEqual(buildStagingForest([], new Map()), []);
	});

	test('One: a single issue with no parent becomes a root', () => {
		const forest = buildStagingForest([makeIssue(5, 'Fix the build')], new Map());
		assert.deepStrictEqual(forest, [{ number: 5, title: 'Fix the build', children: [] }]);
	});

	test('Many: an issue whose parent is also in the batch nests under that parent', () => {
		const issues = [makeIssue(4, 'Make the final Alpha Build'), makeIssue(6, 'Fix the build on Windows')];
		const parentOf = new Map([[6, 4]]);
		assert.deepStrictEqual(buildStagingForest(issues, parentOf), [
			{
				number: 4,
				title: 'Make the final Alpha Build',
				children: [{ number: 6, title: 'Fix the build on Windows', children: [] }],
			},
		]);
	});

	test('Boundaries: an issue whose parent is not in the batch becomes its own root', () => {
		const issues = [makeIssue(6, 'Fix the build on Windows')];
		const parentOf = new Map([[6, 4]]);
		assert.deepStrictEqual(buildStagingForest(issues, parentOf), [
			{ number: 6, title: 'Fix the build on Windows', children: [] },
		]);
	});

	test('Boundaries: an issue body becomes the node description', () => {
		const forest = buildStagingForest([makeIssue(5, 'Fix the build', { body: 'Some **markdown** body.' })], new Map());
		assert.deepStrictEqual(forest, [
			{ number: 5, title: 'Fix the build', description: 'Some **markdown** body.', children: [] },
		]);
	});

	test('Boundaries: an issue with no body has no description field', () => {
		const forest = buildStagingForest([makeIssue(5, 'Fix the build')], new Map());
		assert.ok(!Object.prototype.hasOwnProperty.call(forest[0], 'description'));
	});
});

suite('addIssuesToStaging - Zero/One/Many/Boundaries', () => {
	test('Zero: no issues to add returns the text unchanged', () => {
		const text = '☐ Existing task';
		assert.strictEqual(addIssuesToStaging(text, [], '20260920 09:00:00'), text);
	});

	test('One: creates the section at the top when it does not exist', () => {
		const result = addIssuesToStaging('☐ Existing task', [{ number: 5, title: 'New issue', children: [] }], '20260920 09:00:00');
		assert.strictEqual(result, '# Issue Staging:\n\t☐ @issue5 New issue @synced(20260920 09:00:00)\n\n☐ Existing task');
	});

	test('Many: nested children render one tab deeper than their parent', () => {
		const result = addIssuesToStaging(
			'☐ Existing task',
			[{ number: 4, title: 'Parent issue', children: [{ number: 6, title: 'Child issue', children: [] }] }],
			'20260920 09:00:00',
		);
		assert.strictEqual(
			result,
			'# Issue Staging:\n\t☐ @issue4 Parent issue @synced(20260920 09:00:00)\n\t\t☐ @issue6 Child issue @synced(20260920 09:00:00)\n\n☐ Existing task',
		);
	});

	test('Boundaries: appends after existing staged issues when the section already exists', () => {
		const text = '# Issue Staging:\n\t☐ @issue5 Already staged @synced(20260919 08:00:00)\n\n☐ Existing task';
		const result = addIssuesToStaging(text, [{ number: 7, title: 'Another new issue', children: [] }], '20260920 09:00:00');
		assert.strictEqual(
			result,
			'# Issue Staging:\n\t☐ @issue5 Already staged @synced(20260919 08:00:00)\n\t☐ @issue7 Another new issue @synced(20260920 09:00:00)\n\n☐ Existing task',
		);
	});

	test('Boundaries: leaves every other line untouched when the section already exists', () => {
		const text = '# Issue Staging:\n\t☐ @issue5 Already staged @synced(20260919 08:00:00)\n\n☐ First\n☐ Second';
		const result = addIssuesToStaging(text, [{ number: 7, title: 'Another new issue', children: [] }], '20260920 09:00:00');
		assert.ok(result.endsWith('☐ First\n☐ Second'));
	});

	test('One: a single-line description renders one tab deeper than its issue', () => {
		const result = addIssuesToStaging(
			'☐ Existing task',
			[{ number: 5, title: 'New issue', description: 'Some details.', children: [] }],
			'20260920 09:00:00',
		);
		assert.strictEqual(
			result,
			'# Issue Staging:\n\t☐ @issue5 New issue @synced(20260920 09:00:00)\n\t\tSome details.\n\n☐ Existing task',
		);
	});

	test('Many: a multi-paragraph description keeps its blank-line paragraph break', () => {
		const result = addIssuesToStaging(
			'☐ Existing task',
			[{ number: 5, title: 'New issue', description: 'First paragraph.\n\nSecond paragraph.', children: [] }],
			'20260920 09:00:00',
		);
		assert.strictEqual(
			result,
			'# Issue Staging:\n\t☐ @issue5 New issue @synced(20260920 09:00:00)\n\t\tFirst paragraph.\n\n\t\tSecond paragraph.\n\n☐ Existing task',
		);
	});

	test('Boundaries: markdown syntax in the description is written verbatim', () => {
		const description = '# Heading\n\n- bullet one\n- bullet two\n\n```js\ncode();\n```';
		const result = addIssuesToStaging(
			'☐ Existing task',
			[{ number: 5, title: 'New issue', description, children: [] }],
			'20260920 09:00:00',
		);
		assert.ok(result.includes('\t\t# Heading'));
		assert.ok(result.includes('\t\t- bullet one'));
		assert.ok(result.includes('\t\t- bullet two'));
		assert.ok(result.includes('\t\t```js'));
		assert.ok(result.includes('\t\tcode();'));
		assert.ok(result.includes('\t\t```'));
	});

	test('Boundaries: a description and nested children both render, description first', () => {
		const result = addIssuesToStaging(
			'☐ Existing task',
			[
				{
					number: 4,
					title: 'Parent issue',
					description: 'Parent details.',
					children: [{ number: 6, title: 'Child issue', children: [] }],
				},
			],
			'20260920 09:00:00',
		);
		assert.strictEqual(
			result,
			'# Issue Staging:\n\t☐ @issue4 Parent issue @synced(20260920 09:00:00)\n\t\tParent details.\n\t\t☐ @issue6 Child issue @synced(20260920 09:00:00)\n\n☐ Existing task',
		);
	});

	test('Boundaries: the written description round-trips through parseItems back into .description', () => {
		const text = addIssuesToStaging(
			'☐ Existing task',
			[{ number: 5, title: 'New issue', description: 'First paragraph.\n\nSecond paragraph, with `code`.', children: [] }],
			'20260920 09:00:00',
		);
		const items = parseItems(text);
		const staging = items.find((item) => item.name === 'Issue Staging')!;
		assert.strictEqual(staging.children[0].description, 'First paragraph.\n\nSecond paragraph, with `code`.');
	});
});

suite('githubStatusToTodoStatus - Zero/One/Many/Boundaries', () => {
	test('Zero: open maps to open', () => {
		assert.strictEqual(githubStatusToTodoStatus('open'), 'open');
	});

	test('One: closed with no state reason maps to done', () => {
		assert.strictEqual(githubStatusToTodoStatus('closed'), 'done');
	});

	test('One: closed with state reason completed maps to done', () => {
		assert.strictEqual(githubStatusToTodoStatus('closed', 'completed'), 'done');
	});

	test('Many: closed with state reason not_planned maps to cancelled', () => {
		assert.strictEqual(githubStatusToTodoStatus('closed', 'not_planned'), 'cancelled');
	});

	test('Boundaries: an open issue with state reason reopened still maps to open', () => {
		assert.strictEqual(githubStatusToTodoStatus('open', 'reopened'), 'open');
	});
});

suite('todoStatusToGithubPatch - Zero/One/Many/Boundaries', () => {
	test('Zero: open maps to a state-only patch', () => {
		assert.deepStrictEqual(todoStatusToGithubPatch('open'), { state: 'open' });
	});

	test('One: done maps to closed with reason completed', () => {
		assert.deepStrictEqual(todoStatusToGithubPatch('done'), { state: 'closed', state_reason: 'completed' });
	});

	test('One: cancelled maps to closed with reason not_planned', () => {
		assert.deepStrictEqual(todoStatusToGithubPatch('cancelled'), { state: 'closed', state_reason: 'not_planned' });
	});
});

suite('formatSyncedStamp / parseSyncedStamp - Zero/One/Many/Boundaries', () => {
	test('One: formatting a date round-trips back through parsing to the same instant', () => {
		const date = new Date(2026, 8, 20, 16, 16, 42);
		assert.deepStrictEqual(parseSyncedStamp(formatSyncedStamp(date)), date);
	});

	test('One: formatSyncedStamp pads single-digit month, day, hour, minute, and second', () => {
		assert.strictEqual(formatSyncedStamp(new Date(2026, 0, 5, 9, 4, 3)), '20260105 09:04:03');
	});

	test('Boundaries: parseSyncedStamp rejects text that is not in the expected format', () => {
		assert.throws(() => parseSyncedStamp('not a date'), /expected YYYYMMDD HH:MM\[:SS\] format/);
	});

	test('One: parseSyncedStamp accepts a legacy stamp with no seconds, defaulting them to zero', () => {
		assert.deepStrictEqual(parseSyncedStamp('20260920 09:04'), new Date(2026, 8, 20, 9, 4, 0));
	});

	test('Boundaries: parseSyncedStamp rejects a date-only string with no time', () => {
		assert.throws(() => parseSyncedStamp('20260920'), /expected YYYYMMDD HH:MM\[:SS\] format/);
	});
});

suite('setSyncedTag - Zero/One/Many/Boundaries', () => {
	test('Zero: no existing tag is appended', () => {
		assert.strictEqual(setSyncedTag('☐ @issue5 Fix the build', '20260920 09:00:00'), '☐ @issue5 Fix the build @synced(20260920 09:00:00)');
	});

	test('One: an existing tag is replaced and stays last', () => {
		assert.strictEqual(
			setSyncedTag('☐ @issue5 Fix the build @synced(20260101 00:00:00)', '20260920 09:00:00'),
			'☐ @issue5 Fix the build @synced(20260920 09:00:00)',
		);
	});

	test('Many: other tags on the line are preserved and synced still ends up last', () => {
		assert.strictEqual(
			setSyncedTag('☐ @issue5 @hp2 Fix the build @synced(20260101 00:00:00)', '20260920 09:00:00'),
			'☐ @issue5 @hp2 Fix the build @synced(20260920 09:00:00)',
		);
	});

	test('Boundaries: calling it twice with the same stamp is idempotent', () => {
		const once = setSyncedTag('☐ @issue5 Fix the build', '20260920 09:00:00');
		assert.strictEqual(setSyncedTag(once, '20260920 09:00:00'), once);
	});
});

suite('renderDescriptionBlockLines - Zero/One/Many/Boundaries', () => {
	test('Zero: an empty description renders no lines', () => {
		assert.deepStrictEqual(renderDescriptionBlockLines('', 0), []);
	});

	test('One: a single-line description renders one tab deeper than the item', () => {
		assert.deepStrictEqual(renderDescriptionBlockLines('Some details.', 0), ['\tSome details.']);
	});

	test('Many: a multi-paragraph description keeps its blank-line paragraph break', () => {
		assert.deepStrictEqual(renderDescriptionBlockLines('First paragraph.\n\nSecond paragraph.', 0), [
			'\tFirst paragraph.',
			'',
			'\tSecond paragraph.',
		]);
	});

	test('Boundaries: markdown syntax is written verbatim', () => {
		assert.deepStrictEqual(renderDescriptionBlockLines('# Heading\n- bullet', 1), ['\t\t# Heading', '\t\t- bullet']);
	});
});

suite('renderIssueLine - Zero/One/Many/Boundaries', () => {
	test('Zero: an open issue with no tags has no done tag but has a synced tag', () => {
		assert.strictEqual(
			renderIssueLine(0, { issueId: 5, name: 'Fix the build', status: 'open', syncedAt: '20260920 09:00:00' }),
			'☐ @issue5 Fix the build @synced(20260920 09:00:00)',
		);
	});

	test('One: a done status adds a @done tag before the @synced tag', () => {
		assert.strictEqual(
			renderIssueLine(0, { issueId: 5, name: 'Fix the build', status: 'done', statusDate: '20260920 09:00:00', syncedAt: '20260920 09:00:00' }),
			'✔ @issue5 Fix the build @done(20260920 09:00:00) @synced(20260920 09:00:00)',
		);
	});

	test('One: a cancelled status adds a @cancelled tag before the @synced tag', () => {
		assert.strictEqual(
			renderIssueLine(0, {
				issueId: 5,
				name: 'Fix the build',
				status: 'cancelled',
				statusDate: '20260920 09:00:00',
				syncedAt: '20260920 09:00:00',
			}),
			'✘ @issue5 Fix the build @cancelled(20260920 09:00:00) @synced(20260920 09:00:00)',
		);
	});

	test('Many: preserved tags render in order right after the issue tag', () => {
		assert.strictEqual(
			renderIssueLine(0, { issueId: 5, tags: ['hp2', 'value5'], name: 'Ship it', status: 'open', syncedAt: '20260920 09:00:00' }),
			'☐ @issue5 @hp2 @value5 Ship it @synced(20260920 09:00:00)',
		);
	});

	test('Boundaries: a nonzero depth indents with that many tabs', () => {
		assert.strictEqual(
			renderIssueLine(2, { issueId: 5, name: 'Fix the build', status: 'open', syncedAt: '20260920 09:00:00' }),
			'\t\t☐ @issue5 Fix the build @synced(20260920 09:00:00)',
		);
	});

	test('Boundaries: a non-open status with no statusDate adds no date tag', () => {
		assert.strictEqual(
			renderIssueLine(0, { issueId: 5, name: 'Fix the build', status: 'done', syncedAt: '20260920 09:00:00' }),
			'✔ @issue5 Fix the build @synced(20260920 09:00:00)',
		);
	});
});

suite('findDescriptionBlockExtent - Zero/One/Many/Boundaries', () => {
	test('Zero: the item is the last line, so the block is empty at EOF', () => {
		assert.deepStrictEqual(findDescriptionBlockExtent(['☐ @issue5 Fix the build'], 0), { start: 1, end: 1 });
	});

	test('One: a single description line is covered by the block', () => {
		assert.deepStrictEqual(findDescriptionBlockExtent(['☐ @issue5 Fix the build', '\tSome details.'], 0), { start: 1, end: 2 });
	});

	test('Many: a multi-paragraph description with an interior blank line is covered in full', () => {
		const lines = ['☐ @issue5 Fix the build', '\tFirst.', '', '\tSecond.'];
		assert.deepStrictEqual(findDescriptionBlockExtent(lines, 0), { start: 1, end: 4 });
	});

	test('Boundaries: a same-depth sibling immediately following gives an empty block', () => {
		assert.deepStrictEqual(findDescriptionBlockExtent(['☐ @issue5 Fix the build', '☐ Sibling task'], 0), { start: 1, end: 1 });
	});

	test('Boundaries: a dedent to a shallower depth ends the block immediately', () => {
		const lines = ['\t☐ @issue5 Fix the build', '\t\tSome details.', 'Shallow line'];
		assert.deepStrictEqual(findDescriptionBlockExtent(lines, 0), { start: 1, end: 2 });
	});

	test('Boundaries: a description followed immediately by a child issue stops before the child', () => {
		const lines = ['☐ @issue4 Make the final Alpha Build', '\tThis needs to happen someday.', '\t☐ @issue6 Fix the build on Windows'];
		assert.deepStrictEqual(findDescriptionBlockExtent(lines, 0), { start: 1, end: 2 });
	});
});

suite('applyIssuePull - Zero/One/Many/Boundaries', () => {
	test('Zero: a title-only change rewrites just the name', () => {
		const issue = makeIssue(5, 'New title');
		assert.strictEqual(
			applyIssuePull('☐ @issue5 Old title', {}, 0, issue, '20260920 09:00:00'),
			'☐ @issue5 New title @synced(20260920 09:00:00)',
		);
	});

	test('One: a status change to done inserts a @done tag using the issue close time', () => {
		const closedAt = '2026-09-20T09:15:00.000Z';
		const issue = makeIssue(5, 'Fix the build', { state: 'closed', stateReason: 'completed', closedAt, updatedAt: closedAt });
		const expectedDate = formatSyncedStamp(new Date(closedAt));
		assert.strictEqual(
			applyIssuePull('☐ @issue5 Fix the build', {}, 0, issue, '20260920 09:30:00'),
			`✔ @issue5 Fix the build @done(${expectedDate}) @synced(20260920 09:30:00)`,
		);
	});

	test('Many: a description is pulled into a previously-empty block', () => {
		const issue = makeIssue(5, 'Fix the build', { body: 'New description.' });
		assert.strictEqual(
			applyIssuePull('☐ @issue5 Fix the build', {}, 0, issue, '20260920 09:00:00'),
			'☐ @issue5 Fix the build @synced(20260920 09:00:00)\n\tNew description.',
		);
	});

	test('Boundaries: an existing description block is fully replaced', () => {
		const issue = makeIssue(5, 'Fix the build', { body: 'New description.' });
		assert.strictEqual(
			applyIssuePull('☐ @issue5 Fix the build\n\tOld description.', {}, 0, issue, '20260920 09:00:00'),
			'☐ @issue5 Fix the build @synced(20260920 09:00:00)\n\tNew description.',
		);
	});

	test('Boundaries: an issue with a child issue gets its description pulled without touching the child', () => {
		const text = '☐ @issue4 Make the final Alpha Build\n\tOld info.\n\t☐ @issue6 Fix the build on Windows';
		const issue = makeIssue(4, 'Make the final Alpha Build', { body: 'New info.' });
		assert.strictEqual(
			applyIssuePull(text, {}, 0, issue, '20260920 09:00:00'),
			'☐ @issue4 Make the final Alpha Build @synced(20260920 09:00:00)\n\tNew info.\n\t☐ @issue6 Fix the build on Windows',
		);
	});

	test('Boundaries: an undefined body removes an existing description block', () => {
		const issue = makeIssue(5, 'Fix the build');
		assert.strictEqual(
			applyIssuePull('☐ @issue5 Fix the build\n\tOld description.', {}, 0, issue, '20260920 09:00:00'),
			'☐ @issue5 Fix the build @synced(20260920 09:00:00)',
		);
	});

	test('Boundaries: other tags on the item are preserved when the line is rewritten', () => {
		const issue = makeIssue(5, 'New title');
		assert.strictEqual(
			applyIssuePull('☐ @issue5 @hp2 Old title', { tags: ['hp2'] }, 0, issue, '20260920 09:00:00'),
			'☐ @issue5 @hp2 New title @synced(20260920 09:00:00)',
		);
	});
});

suite('applyStampOnly - Zero/One/Many/Boundaries', () => {
	test('Zero: no existing tag is appended', () => {
		assert.strictEqual(applyStampOnly('☐ @issue5 Fix the build', 0, '20260920 09:00:00'), '☐ @issue5 Fix the build @synced(20260920 09:00:00)');
	});

	test('One: an existing tag is replaced, the rest of the line untouched', () => {
		assert.strictEqual(
			applyStampOnly('☐ @issue5 Fix the build @synced(20260101 00:00:00)', 0, '20260920 09:00:00'),
			'☐ @issue5 Fix the build @synced(20260920 09:00:00)',
		);
	});

	test('Many: only the targeted line is touched, others are byte-identical', () => {
		const text = '☐ First\n☐ @issue5 Fix the build\n☐ Third';
		assert.strictEqual(applyStampOnly(text, 1, '20260920 09:00:00'), '☐ First\n☐ @issue5 Fix the build @synced(20260920 09:00:00)\n☐ Third');
	});
});
