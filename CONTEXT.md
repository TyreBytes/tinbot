# tinbot

`tinbot` is a VS Code extension. It reads `task_list.todo` and writes its
structure into `tasks.json`. This file defines the vocabulary for that
parsed structure.

## Language

**Item**:
A node parsed from one line of `task_list.todo`. An Item is either a
section or a task, nested by indentation under its parent Item.
_Avoid_: Section, Task (as a tree-node name), Node, Entry

**kind**:
The field on an Item that says whether it came from a header line
(`section`) or a checkbox line (`task`).
_Avoid_: type, category

**marker**:
The leading character or characters that show an Item's kind. `☐` or `✔`
for a task, or one or more `#` characters for a section.
_Avoid_: symbol, prefix

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

**tags**:
The list of `@word` tokens on an Item's line, other than `@done(...)`, in
the order they appear.
_Avoid_: labels
