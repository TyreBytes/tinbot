# tinbot

`tinbot` is a VS Code extension. It reads `task_list.todo` and writes its
structure into `tasks.json`. This file defines the vocabulary for that
parsed structure.

## Language

**Item**:
A node parsed from one line of `task_list.todo`. An Item is a section, a
task, or an Issue, nested by indentation under its parent Item.
_Avoid_: Section, Task (as a tree-node name), Node, Entry

**kind**:
The field that says what an Item is: a header line (`section`), a plain
checkbox line (`task`), or a checkbox line tagged `@issue` (`issue`).
_Avoid_: type, category

**Issue**:
A task Item whose line carries an `@issue` tag, meant to sync to a
GitHub repository. Its `kind` is `'issue'`, and it keeps every task field.
_Avoid_: ticket, GitHub task

**issueId**:
The GitHub issue number on an Issue Item, taken from an `@issueN` tag.
Left unset until the task is synced and gains a number.
_Avoid_: issueNumber, ticketId

**marker**:
The leading character or characters that show an Item's kind. `☐`, `✔`,
or `✘` for a task, or one or more `#` characters for a section.
_Avoid_: symbol, prefix

**status**:
The field on a task Item that records whether it is done or cancelled,
set by which checkbox character started its line. Left unset for an open
(`☐`) task, and never set on a section.
_Avoid_: done, complete, state

**Depth**:
The nesting level of an Item, set only by the count of leading tab
characters on its line. The `#` count on a section line does not change
its Depth.
_Avoid_: level, indentation level

**Description**:
The plain-text content among an Item's children that carries no marker. An
Item can have more than one Description block, joined into one string in
file order.
_Avoid_: notes, body text

**completedDate**:
The raw text inside an Item's `@done(...)` token, stored exactly as
written, with no date format conversion.
_Avoid_: doneDate, finishedAt

**cancelledDate**:
The raw text inside an Item's `@cancelled(...)` token, stored exactly as
written, with no date format conversion.
_Avoid_: cancelDate, droppedAt

**tags**:
The list of `@word` tokens on an Item's line, other than `@done(...)`, in
the order they appear.
_Avoid_: labels

**syncedAt**:
The raw text inside an Item's `@synced(...)` token. Tinbot writes this
tag always as the last tag on the line. It records the time of tinbot's
last reconciliation of this Issue against GitHub. It stays unset until
an Issue's first reconciliation.
_Avoid_: lastSynced, syncDate
