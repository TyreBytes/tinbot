# Represent Parsed task_list.todo Entries As One Item Type

`task_list.todo` mixes header lines and checkbox lines, and both nest by
indentation. An earlier draft split them into two types, `Section` and
`Task`, each with its own children array and its own depth-tracking logic.
We changed this to one `Item` type, with a `kind: 'section' | 'task'`
field and a single `children: Item[]` array. The containment rule is the
same for both kinds of line. The two-type design carried duplicate
depth-tracking code, plus a special case for extracting `@tag` tokens from
a section title.

Consequences: When `kind` is `'task'`, fields such as `completedDate` and
`tags` for a `@done(...)` token apply. A reader of the `Item` interface
must check `kind` before relying on these fields, since the type does not
enforce that split.
