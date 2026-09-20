# jira.md

Epic: TODO+ Hierarchical Sync

This file lists the stories for the `tinbot` extension. Each story adds one
part of a hierarchical parser for `task_list.todo`.

The parser must turn every line of `task_list.todo` into one `Item`. An
Item is either a section (a header line) or a task (a checkbox line). See
`CONTEXT.md` for the full glossary of these terms.

The `tinbot.todoSyncGithub` command must write the full Item tree into the
output JSON file. The command writes this file next to `task_list.todo`.
The file is named `tasks.json`, and `src/extension.ts` writes it today.

---

## TINBOT-101

Title: Parse The Item Tree From task_list.todo

Epic: TODO+ Hierarchical Sync

Description:
`task_list.todo` mixes two kinds of marked lines. A header line starts
with one or more `#` characters and ends with a colon, for example
`# Tin Bot Project:`. A checkbox line starts with `☐`, `✔`, or `✘`, for
example `☐ Buy milk`. Each checkbox character also sets a status: `☐`
marks an open task, `✔` marks a done task, and `✘` marks a cancelled
task. This story builds one `Item` type for all kinds, with a `kind`
field set to `section` or `task`. A new `status` field keeps this meaning
for a task.

Depth decides nesting, not the marker. Depth comes only from the count of
leading tab characters on a line. For example, `## Alpha Stage:` and `#
Pain Points of TurtleBrains:` both sit at the same depth in the real file.
Their `#` counts differ, but that does not matter. The parser must not
treat this as an error.

Acceptance criteria:
- A header line, one or more `#` characters ending in a colon, parses into an Item with `kind: 'section'`.
- A checkbox line, starting with `☐`, `✔`, or `✘`, parses into an Item with `kind: 'task'`.
- The `Item` interface gains an optional field `status: 'done' | 'cancelled'`, left unset for an open task and for every section.
- A task parsed from a `✔` line has `status: 'done'`.
- A task parsed from a `✘` line has `status: 'cancelled'`.
- Every Item's `name` field holds the line text, with its marker, its trailing colon (for a section), and outer whitespace removed.
- An Item's Depth comes only from its leading tab count. The `#` count on a section line has no effect on Depth.
- An Item with a Depth one tab deeper than the Item above it becomes a child of that Item, not a sibling.
- The flat lines at the top of `task_list.todo`, with no header above them, become top-level Items with no shared parent.
- A new unit test must show correct parsing of an open task, a done task, a cancelled task, and a section that holds tasks.

How to perform this task:
1. Open `src/extension.ts` and add an `Item` interface with fields `kind: 'section' | 'task'`, `name: string`, `status?: 'done' | 'cancelled'`, and `children: Item[]`.
2. Add a `parseItems(text: string): Item[]` function, separate from the existing `parseTasks()` function.
3. Count the leading tab characters on each line to find its Depth.
4. Match a line against `/^#+\s*(.+):$/` before you look for a `☐`/`✔`/`✘` marker, so header lines parse as sections first.
5. When a checkbox line starts with `✔`, set `status` to `'done'`. When it starts with `✘`, set `status` to `'cancelled'`. Leave `status` unset for `☐`.
6. Build the tree with a depth stack. Push a new Item onto the children array of the stack item one level shallower.
7. When a line's Depth is the same as or shallower than the stack top, pop the stack back to the matching Depth first.
8. Add a `readItems(baseUri: vscode.Uri): Promise<Item[]>` function that reads `task_list.todo` and calls `parseItems()`.
9. Add test cases to `src/test/suite/extension.test.ts`, in the style of the existing Zero/One/Many/Boundaries suites.

---

## TINBOT-102

Title: Attach Multi-Block Descriptions To An Item

Epic: TODO+ Hierarchical Sync

Description:
Some Items in `task_list.todo` have plain text among their children, with
no `☐`, `✔`, `✘`, or `#` marker. This text can sit before an Item's first
child, between two children, or after its last child. This story adds a
`description` field to `Item`. The parser must collect every one of these
plain-text blocks, not just the first.

A description block is a run of one or more plain-text lines at the same
Depth as the Item's own children. The parser must join every block for one
Item into a single `description` string, in file order, with a blank line
between each block.

Acceptance criteria:
- The `Item` interface gains an optional field `description: string`.
- A plain-text line at an Item's child Depth, with no marker, belongs to that Item's `description`, not to a sibling Item.
- A plain-text block that sits before the Item's first marked child still becomes part of `description`.
- A plain-text block that sits between two marked children still becomes part of `description`.
- A plain-text block that sits after the Item's last marked child still becomes part of `description`.
- Two or more description blocks for one Item join into one `description` string, in file order, separated by a blank line.
- An Item with no plain-text lines among its children keeps `description` as `undefined`, not as an empty string.
- A new unit test must show a task with description text before, between, and after two marked subtasks, joined into one `description` value.

How to perform this task:
1. Open `src/extension.ts` and add `description?: string` to the `Item` interface.
2. While `parseItems()` walks the lines at one Depth, sort each line into a marker line or a plain-text line.
3. Group consecutive plain-text lines, including blank lines between them, into one block.
4. Trim leading and trailing blank lines from each block.
5. Keep every block for an Item in the order the lines appear in the file, marker lines or not.
6. Join the Item's blocks with a blank line between each one, and store the result in `description`.
7. When an Item has no plain-text blocks among its children, leave `description` unset.
8. Add test cases to `src/test/suite/extension.test.ts` for one block, no blocks, and three blocks split by marked children.

---

## TINBOT-103

Title: Extract @tags And Completion Dates From Item Text

Epic: TODO+ Hierarchical Sync

Description:
Item lines in `task_list.todo` can carry metadata as `@tag` tokens, for
example `@done(25-11-05 20:01)`, `@hp2`, `@value5`, and `@api-break`. The
parser from TINBOT-101 leaves these tokens inside `name` today. This story
extracts the tokens into structured fields on `Item`, and removes them
from `name`.

The `@done(...)` token carries a date and time in parentheses.
`task_list.todo` already holds two different formats for this, for
example `25-11-05 20:01` and `20251025 06:55`. This story stores the raw
text of the token, with the parentheses stripped, in a `completedDate`
field. It does not convert either format to a common one.

A `✘` task can also carry an `@cancelled(...)` token, with the same date
and time format as `@done(...)`. This story stores its raw text, with the
parentheses stripped, in a `cancelledDate` field, in the same way as
`completedDate`.

Every other `@tag` token, with or without an attached word, must parse
into a `tags` array of strings. Because `kind` no longer separates
sections from tasks in a special way, this extraction runs on every Item,
section or task alike.

Acceptance criteria:
- The `Item` interface gains optional fields `completedDate?: string`, `cancelledDate?: string`, and `tags?: string[]`.
- An `@done(...)` token is removed from `name`. Its content is stored in `completedDate`, with the parentheses stripped and the text otherwise unchanged.
- An `@cancelled(...)` token is removed from `name`. Its content is stored in `cancelledDate`, with the parentheses stripped and the text otherwise unchanged.
- Every other `@tag` token is removed from `name` and added to `tags`, in the order it appears in the line.
- An Item with no `@tag` token keeps `tags`, `completedDate`, and `cancelledDate` as `undefined`.
- The remaining `name`, after tag removal, has no double space left where a tag used to sit.
- Tag extraction runs the same way for an Item with `kind: 'section'` as for one with `kind: 'task'`.
- A new unit test must show that a line with `@hp2 @value5` parses into `tags: ['hp2', 'value5']` and a clean `name`.
- A new unit test must show that `@done(25-11-05 20:01)` and `@done(20251025 06:55)` both store as-is in `completedDate`, unconverted.
- A new unit test must show that `@cancelled(20260920 09:34)` stores as-is in `cancelledDate`, unconverted.

How to perform this task:
1. Open `src/extension.ts` and add `completedDate?: string`, `cancelledDate?: string`, and `tags?: string[]` to the `Item` interface.
2. Write a regular expression that matches `@done\(([^)]+)\)`, and store the captured text in `completedDate`.
3. Write a regular expression that matches `@cancelled\(([^)]+)\)`, and store the captured text in `cancelledDate`.
4. Write a regular expression that matches remaining `@\w[\w-]*` tokens, and collect each match into `tags`.
5. Run this extraction on every Item's `name`, after the marker strip from TINBOT-101, regardless of `kind`.
6. Remove every matched token from `name`.
7. Collapse repeated spaces left by the removal into a single space.
8. Add test cases to `src/test/suite/extension.test.ts` for `@done(...)` alone, `@cancelled(...)` alone, other tags alone, all together, and no tags at all.

---

## TINBOT-104

Title: Write The Full Item Tree Into tasks.json, And Retire The Flat Parser

Epic: TODO+ Hierarchical Sync

Description:
The `tinbot.todoSyncGithub` command, registered in `src/extension.ts`,
calls `readTasks()` today. It writes the flat `Task[]` result to
`tasks.json`, next to `task_list.todo`, with `JSON.stringify(tasks, null,
2)`. Once TINBOT-101 through TINBOT-103 are done, the command must call
`readItems()` instead, and write the full Item tree to the same file.

No other code in the repository calls `parseTasks()` or `readTasks()`
outside the test suite. This story updates the tests to use `parseItems()`
and `readItems()`. This story must then delete `parseTasks()`,
`readTasks()`, and the old flat `Task` interface.

Acceptance criteria:
- The `tinbot.todoSyncGithub` command calls `readItems()` and writes its result to `tasks.json`, in place of `readTasks()`.
- `tasks.json` keeps its name and its location, next to `task_list.todo` in the same base directory.
- When the source line carries that data, each Item object in `tasks.json` includes `status`, `description`, `tags`, `completedDate`, and `cancelledDate`.
- When the source line carries no such data, `tasks.json` omits that field, instead of writing `null`.
- A section Item in `tasks.json` keeps `kind: 'section'` and its `children` array. A reader can then tell which entries are sections, and what sits under each one.
- The command still catches a read error, and shows the existing error message, `tinbot: could not sync tasks: ${err}`, unchanged.
- The write step still uses `vscode.workspace.fs.writeFile` and `JSON.stringify(..., null, 2)`, so the file stays readable.
- `src/extension.ts` no longer exports `parseTasks()`, `readTasks()`, or the flat `Task` interface, once this story is done.

How to perform this task:
1. Open `src/extension.ts` and change the command handler to call `readItems()`, in place of `readTasks()`.
2. Pass the `Item[]` result to `JSON.stringify(items, null, 2)`, in place of the current `tasks` variable.
3. Keep the existing `try`/`catch` block and error message text exactly as they are today.
4. Update every test in `src/test/suite/extension.test.ts` that calls `parseTasks()` or `readTasks()`, so it calls `parseItems()` or `readItems()` instead.
5. Remove the `parseTasks()` function, the `readTasks()` function, and the flat `Task` interface from `src/extension.ts`.
6. Run `npm run pretest` and `npm test` from the repository root, and make sure that every test passes.

---

## TINBOT-105

Title: Add Test Coverage For The Hierarchical Parser

Epic: TODO+ Hierarchical Sync

Description:
The `no-control-flow-tests` skill sets two rules for this repository. A
test body must not contain an `if`, `else`, `for`, `while`, or `switch`
statement. A `try` block inside a test must carry its own `catch` block,
and that block must fail the test with a clear message. The existing suite
in `src/test/suite/extension.test.ts` follows a Zero/One/Many/Boundaries
naming pattern. The file `src/test/testUtils.ts` already offers
`createTaskListFixture()` and `cleanupTaskListFixture()` helpers.

This story extends that suite to cover TINBOT-101 through TINBOT-104. Each
new test must follow both rules from the `no-control-flow-tests` skill.

Acceptance criteria:
- Every new test avoids an `if`, `else`, `for`, `while`, or `switch` statement inside the test body.
- Every new `try` block inside a test carries a matching `catch` block that calls `assert.fail()` with a clear message.
- New suites follow the existing Zero/One/Many/Boundaries naming pattern in `src/test/suite/extension.test.ts`.
- A test must show that `parseItems()`, from TINBOT-101, builds correct Depth-based nesting for a section, a task, and mixed children.
- A test must show that an open task, a done task, and a cancelled task, from TINBOT-101, get the correct `status` value.
- A test must show that an Item's `description`, from TINBOT-102, holds every block in file order. The Item must have blocks before, between, and after its children.
- A test must show correct `tags`, `completedDate`, and `cancelledDate` values, from TINBOT-103, for both `@done` date formats found in `task_list.todo`.
- A test must show the same correct values, from TINBOT-103, for the `@cancelled` format found in `task_list.todo`.
- The interface test for `tinbot.todoSyncGithub` must show that `tasks.json` matches the full Item tree from `readItems()`, from TINBOT-104.

How to perform this task:
1. Open `src/test/testUtils.ts`. Make sure that `createTaskListFixture()` accepts custom file content for the new nested cases.
2. Add fixture content strings for each new case, a section with children, a task with subtasks, and a task with description blocks.
3. Add new `suite()` blocks to `src/test/suite/extension.test.ts` for `parseItems`, in the style of the existing suites.
4. Write each test with `assert.deepStrictEqual()` against a full expected object, instead of separate assertions per field.
5. Run `npm run pretest` and `npm test` from the repository root.
6. Make sure that every test passes before you close the story.

---

## TINBOT-106

Title: Recognize @issue Tags As A Third Item Kind

Epic: TODO+ Hierarchical Sync

Description:
Some task lines in `task_list.todo` also carry an `@issue` tag, for
example `☐ @issue Fix sound issue and merge crusher`. This tag marks a
task the team plans to sync to a GitHub repository as an issue. Once
synced, the tag gains a number, for example `@issue1` for GitHub issue 1.

This story adds `'issue'` as a third `kind` value, alongside `'section'`
and `'task'`. A checkbox line with an `@issue` or `@issueN` tag gets
`kind: 'issue'` instead of `kind: 'task'`. It keeps every other task
field: `status`, `description`, `tags`, `completedDate`, `cancelledDate`,
and `children`.

A new `issueId` field holds the GitHub issue number once synced.
`@issue1` sets `issueId: 1`. A bare `@issue` tag, with no number yet,
leaves `issueId` unset.

Acceptance criteria:
- The `Item` interface's `kind` field gains a third value: `'section' | 'task' | 'issue'`.
- The `Item` interface gains an optional field `issueId?: number`.
- A checkbox line with an `@issue` or `@issueN` tag parses into an Item with `kind: 'issue'`, not `kind: 'task'`.
- An `@issueN` tag sets `issueId` to the number `N`, and is removed from `name`.
- A bare `@issue` tag, with no digits after it, is removed from `name` and leaves `issueId` unset.
- A checkbox line with no `@issue` tag keeps `kind: 'task'`, and `issueId` unset.
- An issue Item still gets `status`, `description`, `tags`, `completedDate`, and `cancelledDate` the same way a task Item does.
- A header line never becomes `kind: 'issue'`, not even one whose text contains `@issue`.
- A new unit test must show that `☐ @issue Fix sound issue and merge crusher` parses into `kind: 'issue'` with `issueId` unset.
- A new unit test must show that `☐ @issue1 Create a Rushcremental title/logo` parses into `kind: 'issue'` with `issueId: 1`.

How to perform this task:
1. Open `src/extension.ts` and widen the `Item` interface's `kind` field to `'section' | 'task' | 'issue'`, and add `issueId?: number`.
2. Write a regular expression that matches an `@issue` tag with an optional trailing number, for example `/@issue(\d+)?(?![\w-])/`.
3. In `applyTags()`, run this pattern on the raw name before the generic `@tag` pattern runs.
4. When the pattern matches with a number, set `issueId` to that number, parsed with `Number(...)`.
5. Remove the matched `@issue` token from `name`, whether or not it carried a number.
6. Only run this check for a checkbox line, never for a header line's title.
7. When the tag matched, set the Item's `kind` to `'issue'` before you push it onto its parent's `children` array.
8. Add test cases to `src/test/suite/extension.test.ts` for a bare `@issue` tag, an `@issueN` tag, and a task with neither.

---

## Story List

| Ticket     | Description                                                          | Epic                     |
|------------|------------------------------------------------------------------------|---------------------------|
| TINBOT-101 | Parse the Item tree from `task_list.todo`                              | TODO+ Hierarchical Sync |
| TINBOT-102 | Attach multi-block descriptions to an Item                             | TODO+ Hierarchical Sync |
| TINBOT-103 | Extract @tags and completion dates from Item text                      | TODO+ Hierarchical Sync |
| TINBOT-104 | Write the full Item tree into `tasks.json`, and retire the flat parser | TODO+ Hierarchical Sync |
| TINBOT-105 | Add test coverage for the hierarchical parser                          | TODO+ Hierarchical Sync |
| TINBOT-106 | Recognize @issue tags as a third Item kind                             | TODO+ Hierarchical Sync |
