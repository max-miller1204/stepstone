# stepstone: the renamed package as an end user meets it

Every command below ran against the publishable tarball (`npm pack`) installed on its own into a scratch
directory with `--omit=dev --omit=peer`, so no Pi package is present - the same install that
`npx -y stepstone@latest` produces for a Codex, Cursor, or Claude Code user.

## The tarball installs a `stepstone` bin, and nothing from Pi

```console
$ npm install stepstone-0.1.0.tgz --omit=dev --omit=peer --no-audit --no-fund
added 5 packages

$ ls node_modules/.bin
stepstone

$ ls node_modules/@earendil-works
ls: cannot access 'node_modules/@earendil-works': No such file or directory
```

## The CLI names itself in its own help

```console
$ stepstone project help
Usage: stepstone project <action> [arguments] [flags]

Actions:
  list                                     Show a compact bounded list of project goals
  show <id>                                Show one goal with its full description
  find <text...>                           List the goals whose title or description contains the text
  next                                     Show the one goal to start next, the first ready goal in file order
  ready                                    List every unblocked, unclaimed open goal: the whole parallel frontier
  waves                                    Print unfinished goals in dependency layers, earliest first
  ui                                       Open the interactive goal board for a human at the keyboard
  add <title...> [--description <text> | -- <description...>]
                                           Add an open goal
  apply-plan <plan.json>                   Validate and atomically add every goal in a JSON plan
  update <id> [title...] [--description <text> | -- <description...>]
                                           Edit a goal's title or description
  move <id> up|down|before <id>|after <id> Reorder a goal in the roadmap's canonical file order
  set_active <id>                          Make a goal the single active goal
  complete <id> --confirm                  Mark a goal done
  reopen <id> --confirm                    Reopen a done or archived goal
  archive <id> --confirm                   Archive a goal
  delete <id> --confirm                    Delete a goal permanently
  migrate_ids --confirm                    Rewrite randomly generated goal IDs as title-derived ones
  help                                     Print this help

Flags:
  --json                           Print the deterministic result envelope as JSON (stdout on success, stderr on failure)
  --confirm                        Acknowledge an action that requires confirmation; pass it only for an explicit user request
  --cwd <dir>                      Resolve the git root from this directory instead of the working directory
  --description <text>             Set the whole description from one argv token; order-independent and preferred for agents and scripts; a new update title must come before it, and an add title must not straddle it; only for project add and update
  --append-description <text>      Add one argv token as a new description paragraph without replacing stored prose; cannot be combined with a title change; only for project update
  --append                         Interactive compatibility form that adds the text after -- as a new paragraph; cannot be combined with a title change; only for project update
  --group <name>                   Put the goal in a free-form section, such as Foundation; an empty name clears it; only for project add and update
  --depends-on <id>                Require that goal to land first; repeat it to name several, and pass an empty id alone to clear every edge; only for project add and update
  --expect-updated-at <timestamp>  Refuse the change as a conflict unless the goal's updatedAt still matches this value; only for project update, set_active, complete, reopen, archive, and delete
  --dry-run                        Validate and report an apply-plan projection or ID migration without writing; only for project apply-plan and migrate_ids

Exit codes: 0 success, 1 error, 2 usage error, 3 confirmation required, 4 conflict.
[exit 0]

```

## A goal lifecycle from the installed bin, including the diagnostics that spell the command

```console
$ stepstone project add Cross the first stone --description Each goal is reachable only from the one before it.
Added project goal cross-the-first-stone: Cross the first stone
[exit 0]

$ stepstone project list
[open] cross-the-first-stone: Cross the first stone
[exit 0]

$ stepstone project complete cross-the-first-stone
Project complete requires explicit confirmation. Pass --confirm only when the user explicitly requested this action.
[exit 3]

$ stepstone project complete cross-the-first-stone --confirm
Project goal cross-the-first-stone is now done
[exit 0]

$ stepstone project set_active cross-the-first-stone
A done or archived Project Goal must be reopened with confirm=true before activation. Reopen it first: stepstone project reopen cross-the-first-stone --confirm
[exit 1]

$ stepstone project ui
project ui needs an interactive terminal. Use 'stepstone project list --json' in scripts and agents.
[exit 1]

$ stepstone project list --json
{
  "ok": true,
  "scope": "project",
  "action": "list",
  "result": {
    "scope": "project",
    "action": "list",
    "goals": [
      {
        "id": "cross-the-first-stone",
        "title": "Cross the first stone",
        "description": "Each goal is reachable only from the one before it.",
        "status": "done",
        "createdAt": "2026-08-09T21:15:31.851Z",
        "updatedAt": "2026-08-09T21:15:32.043Z",
        "completedAt": "2026-08-09T21:15:32.043Z"
      }
    ]
  },
  "meta": {
    "changed": false,
    "semanticNoOp": false,
    "changedFields": [],
    "revisions": {
      "project": "2"
    },
    "cliVersion": "0.1.0"
  }
}
[exit 0]

```

## The goal that asked for this rename, read back through the renamed bin

```console
$ stepstone project show harness-identity-rename-off-the-pi --cwd <repo>
harness-identity-rename-off-the-pi: harness-identity: rename off the Pi-specific package name
status: done
group: Harness
created: 2026-08-08T23:53:23.024Z
updated: 2026-08-09T20:55:04.099Z
completed: 2026-08-09T19:10:07.766Z
blocks:
  worklist-path-move-the-goal-file-out-of
  ... (description omitted)
```
