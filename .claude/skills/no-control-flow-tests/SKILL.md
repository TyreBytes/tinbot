---
name: no-control-flow-tests
description: Use when writing or editing test code in this repo (files under src/test/, *.test.ts). Enforces two rules - no control-flow statements (if/else, for, while, switch) inside a test body, and every try block in a test must have its own catch that fails the test with a clear message. Trigger on "write a test", "add a test case", "test this function", or any edit to a *.test.ts file.
---

# Tests without control statements

Two rules apply to every test body (the function passed to `test(...)`) and to `setup`/`teardown` hooks in this repo's test files (mocha `tdd` style, Node `assert`, see `src/test/suite/extension.test.ts`).

## Rule 1: no control-flow statements in a test body

Do not use `if`, `else`, `for`, `while`, `do`, or `switch` inside a `test(...)` callback or a `setup`/`teardown` hook. A test body is a straight line: arrange, act, assert. Branching inside a test means the test is silently covering more than one scenario, and a failure will not say which branch failed.

Consequences of this rule:

- One scenario per `test(...)`. Do not loop over a table of cases inside one test with a `for` loop and assertions in the loop body. Write one `test(...)` call per case instead (this is what the ZOMBIES suites in `extension.test.ts` do: one `test` per Zero/One/Many/Boundary case).
- Do not guard cleanup with `if (thing) { ... }` in `teardown`. Arrange the test so the resource always exists by the time `teardown` runs, and clean it up unconditionally. If TypeScript still types the variable as possibly `undefined`, use a non-null assertion (`thing!`) rather than an `if`.

Before:
```ts
teardown(async () => {
	if (fixtureDir) {
		await cleanupTaskListFixture(fixtureDir);
		fixtureDir = undefined;
	}
});
```

After:
```ts
teardown(async () => {
	await cleanupTaskListFixture(fixtureDir!);
});
```

A ternary used purely to compute a value passed to an assertion (not to change which statements run) is not a control-flow statement and is fine, but prefer a plain value or a second test over a ternary that hides a branch.

## Rule 2: every `try` in a test must have its own `catch` that fails the test

A `try`/`finally` with no `catch` lets an exception from the `try` block propagate past cleanup with mocha's own (often unclear) failure report. Add a `catch` that calls `assert.fail(...)` with a message naming what was being attempted and the caught error, so a failure in that block is always attributable at a glance. Keep any `finally` for cleanup that must run either way.

Before:
```ts
try {
	await vscode.commands.executeCommand('tinbot.todoSyncGithub');
	assert.deepStrictEqual(actual, expected);
} finally {
	await vscode.workspace.fs.delete(outputUri, { useTrash: false });
}
```

After:
```ts
try {
	await vscode.commands.executeCommand('tinbot.todoSyncGithub');
	assert.deepStrictEqual(actual, expected);
} catch (err) {
	assert.fail(`tinbot.todoSyncGithub command threw: ${err}`);
} finally {
	await vscode.workspace.fs.delete(outputUri, { useTrash: false });
}
```

`assert.rejects(...)` and `assert.doesNotReject(...)` already produce an attributable failure on their own; a bare `await somePromise` inside a `try` does not, so wrap it in `try`/`catch`/`assert.fail` per this rule, or replace it with `assert.rejects`/`assert.doesNotReject` where the shape fits.
