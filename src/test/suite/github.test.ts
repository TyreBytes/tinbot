import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { addIssuesToStaging, buildStagingForest, patchIssueLine, readProjectSettings } from '../../github';
import { parseItems } from '../../extension';
import { cleanupTaskListFixture, createTaskListFixture } from '../testUtils';

suite('readProjectSettings - Zero/One/Many/Boundaries', () => {
	let fixtureDir: string | undefined;

	teardown(async () => {
		await cleanupTaskListFixture(fixtureDir!);
	});

	test('Zero: a missing project_settings.secret resolves to undefined', async () => {
		const { uri, dir } = await createTaskListFixture(undefined);
		fixtureDir = dir;
		assert.strictEqual(await readProjectSettings(uri), undefined);
	});

	test('One: a valid file resolves to the parsed settings', async () => {
		const { uri, dir } = await createTaskListFixture(undefined);
		fixtureDir = dir;
		const content = JSON.stringify({ github: { token: 'ghp_abc', owner: 'tyre-bytes', repo: 'tinbot' } });
		await fs.promises.writeFile(path.join(dir, 'project_settings.secret'), content, 'utf8');

		assert.deepStrictEqual(await readProjectSettings(uri), {
			github: { token: 'ghp_abc', owner: 'tyre-bytes', repo: 'tinbot' },
		});
	});

	test('Boundaries: invalid JSON rejects with a clear message', async () => {
		const { uri, dir } = await createTaskListFixture(undefined);
		fixtureDir = dir;
		await fs.promises.writeFile(path.join(dir, 'project_settings.secret'), '{ not valid json', 'utf8');

		await assert.rejects(readProjectSettings(uri), (err: Error) => err.message.includes('not valid JSON'));
	});

	test('Boundaries: a file missing github.token rejects naming that field', async () => {
		const { uri, dir } = await createTaskListFixture(undefined);
		fixtureDir = dir;
		const content = JSON.stringify({ github: { owner: 'tyre-bytes', repo: 'tinbot' } });
		await fs.promises.writeFile(path.join(dir, 'project_settings.secret'), content, 'utf8');

		await assert.rejects(readProjectSettings(uri), (err: Error) => err.message.includes('github.token'));
	});

	test('Many: a file missing multiple fields rejects naming all of them', async () => {
		const { uri, dir } = await createTaskListFixture(undefined);
		fixtureDir = dir;
		const content = JSON.stringify({ github: { token: 'ghp_abc' } });
		await fs.promises.writeFile(path.join(dir, 'project_settings.secret'), content, 'utf8');

		await assert.rejects(
			readProjectSettings(uri),
			(err: Error) => err.message.includes('github.owner') && err.message.includes('github.repo'),
		);
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
		const text = '✔ @issue @hp2 Ship the feature @done(20260920 09:00)';
		assert.strictEqual(patchIssueLine(text, 0, 12), '✔ @issue12 @hp2 Ship the feature @done(20260920 09:00)');
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
		const forest = buildStagingForest([{ number: 5, title: 'Fix the build' }], new Map());
		assert.deepStrictEqual(forest, [{ number: 5, title: 'Fix the build', children: [] }]);
	});

	test('Many: an issue whose parent is also in the batch nests under that parent', () => {
		const issues = [
			{ number: 4, title: 'Make the final Alpha Build' },
			{ number: 6, title: 'Fix the build on Windows' },
		];
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
		const issues = [{ number: 6, title: 'Fix the build on Windows' }];
		const parentOf = new Map([[6, 4]]);
		assert.deepStrictEqual(buildStagingForest(issues, parentOf), [
			{ number: 6, title: 'Fix the build on Windows', children: [] },
		]);
	});

	test('Boundaries: an issue body becomes the node description', () => {
		const forest = buildStagingForest([{ number: 5, title: 'Fix the build', body: 'Some **markdown** body.' }], new Map());
		assert.deepStrictEqual(forest, [
			{ number: 5, title: 'Fix the build', description: 'Some **markdown** body.', children: [] },
		]);
	});

	test('Boundaries: an issue with no body has no description field', () => {
		const forest = buildStagingForest([{ number: 5, title: 'Fix the build' }], new Map());
		assert.ok(!Object.prototype.hasOwnProperty.call(forest[0], 'description'));
	});
});

suite('addIssuesToStaging - Zero/One/Many/Boundaries', () => {
	test('Zero: no issues to add returns the text unchanged', () => {
		const text = '☐ Existing task';
		assert.strictEqual(addIssuesToStaging(text, []), text);
	});

	test('One: creates the section at the top when it does not exist', () => {
		const result = addIssuesToStaging('☐ Existing task', [{ number: 5, title: 'New issue', children: [] }]);
		assert.strictEqual(result, '# Issue Staging:\n\t☐ @issue5 New issue\n\n☐ Existing task');
	});

	test('Many: nested children render one tab deeper than their parent', () => {
		const result = addIssuesToStaging('☐ Existing task', [
			{ number: 4, title: 'Parent issue', children: [{ number: 6, title: 'Child issue', children: [] }] },
		]);
		assert.strictEqual(result, '# Issue Staging:\n\t☐ @issue4 Parent issue\n\t\t☐ @issue6 Child issue\n\n☐ Existing task');
	});

	test('Boundaries: appends after existing staged issues when the section already exists', () => {
		const text = '# Issue Staging:\n\t☐ @issue5 Already staged\n\n☐ Existing task';
		const result = addIssuesToStaging(text, [{ number: 7, title: 'Another new issue', children: [] }]);
		assert.strictEqual(
			result,
			'# Issue Staging:\n\t☐ @issue5 Already staged\n\t☐ @issue7 Another new issue\n\n☐ Existing task',
		);
	});

	test('Boundaries: leaves every other line untouched when the section already exists', () => {
		const text = '# Issue Staging:\n\t☐ @issue5 Already staged\n\n☐ First\n☐ Second';
		const result = addIssuesToStaging(text, [{ number: 7, title: 'Another new issue', children: [] }]);
		assert.ok(result.endsWith('☐ First\n☐ Second'));
	});

	test('One: a single-line description renders one tab deeper than its issue', () => {
		const result = addIssuesToStaging('☐ Existing task', [
			{ number: 5, title: 'New issue', description: 'Some details.', children: [] },
		]);
		assert.strictEqual(result, '# Issue Staging:\n\t☐ @issue5 New issue\n\t\tSome details.\n\n☐ Existing task');
	});

	test('Many: a multi-paragraph description keeps its blank-line paragraph break', () => {
		const result = addIssuesToStaging('☐ Existing task', [
			{ number: 5, title: 'New issue', description: 'First paragraph.\n\nSecond paragraph.', children: [] },
		]);
		assert.strictEqual(
			result,
			'# Issue Staging:\n\t☐ @issue5 New issue\n\t\tFirst paragraph.\n\n\t\tSecond paragraph.\n\n☐ Existing task',
		);
	});

	test('Boundaries: markdown syntax in the description is written verbatim', () => {
		const description = '# Heading\n\n- bullet one\n- bullet two\n\n```js\ncode();\n```';
		const result = addIssuesToStaging('☐ Existing task', [{ number: 5, title: 'New issue', description, children: [] }]);
		assert.ok(result.includes('\t\t# Heading'));
		assert.ok(result.includes('\t\t- bullet one'));
		assert.ok(result.includes('\t\t- bullet two'));
		assert.ok(result.includes('\t\t```js'));
		assert.ok(result.includes('\t\tcode();'));
		assert.ok(result.includes('\t\t```'));
	});

	test('Boundaries: a description and nested children both render, description first', () => {
		const result = addIssuesToStaging('☐ Existing task', [
			{
				number: 4,
				title: 'Parent issue',
				description: 'Parent details.',
				children: [{ number: 6, title: 'Child issue', children: [] }],
			},
		]);
		assert.strictEqual(
			result,
			'# Issue Staging:\n\t☐ @issue4 Parent issue\n\t\tParent details.\n\t\t☐ @issue6 Child issue\n\n☐ Existing task',
		);
	});

	test('Boundaries: the written description round-trips through parseItems back into .description', () => {
		const text = addIssuesToStaging('☐ Existing task', [
			{ number: 5, title: 'New issue', description: 'First paragraph.\n\nSecond paragraph, with `code`.', children: [] },
		]);
		const items = parseItems(text);
		const staging = items.find((item) => item.name === 'Issue Staging')!;
		assert.strictEqual(staging.children[0].description, 'First paragraph.\n\nSecond paragraph, with `code`.');
	});
});
