<!-- markdownlint-disable MD013 -->

# Storage and concurrency

Project Goals live in a schema-versioned JSON file at `.worklist/worklist.json` in the canonical Git root, a directory rather than a bare dotfile so later local state has somewhere to live beside the committed roadmap.
The file is human-readable and meant to be committed.

## Which file a repository has

One resolution order applies everywhere, in the CLI, the MCP server, the terminal board, and a live Pi session: an explicit `--file <path>` or `$STEPSTONE_WORKLIST` first, then `.worklist/worklist.json`, then the legacy `.pi/worklist.json`.
`--file` and `$STEPSTONE_WORKLIST` are resolved from the process working directory, independently of `--cwd`, which only selects the target Git repository.
`--file` is a CLI flag, so an interface that takes no flags, such as the MCP server, overrides the location through `$STEPSTONE_WORKLIST` alone.

Reads fall back to the legacy path and writes go to whichever path resolved, so a repository holding only `.pi/worklist.json` keeps using it untouched rather than silently splitting into two roadmaps.
A repository with neither file writes `.worklist/worklist.json`.

When both files exist, the current path wins and every goal operation warns, because quietly ignoring a populated legacy file would look exactly like data loss.
Merge them by hand; no command picks a winner for you.
A caller that reads envelopes rather than prose, `--json` on the CLI or any MCP response, gets that warning as `meta.shadowedWorklistPath`, naming the file being passed over, because stderr carries the failure envelope and prose in front of it would leave nothing to parse.

Nothing remembers where that resolution landed: every operation asks again.
A second worklist arriving mid-session, from a branch checkout, a merge, or a colleague on an older release, is therefore picked up rather than missed, and a long-lived reader such as an open board or a live session warns about it the first time it appears rather than on every turn.

```sh
npx -y stepstone@latest project migrate_path --dry-run
npx -y stepstone@latest project migrate_path --confirm
```

`migrate_path` moves a legacy file to `.worklist/worklist.json` under the same cross-process lock and atomic replacement as any other write, reporting both paths.
It is a location change and nothing else: the goals, their IDs, and the schema version are carried across untouched.
It needs an explicit request of its own because it names no goal and moves the whole repository's roadmap, and `--dry-run` reports the move without writing and without `--confirm`.
It refuses to run against an explicitly overridden path, which names a file rather than a repository to migrate.

Leave the file where it is unless its owner asks to move it: a repository still on the legacy path works untouched.

## Keep formatters out of it

The file is written by the store rather than by hand, so exclude `.worklist` from any repository-wide formatter.
A formatter that reindents it will fight every mutation, and reformatting is not a change any goal asked for.

## Writes

Every interface writes through one application service, which serializes physical writes behind a cross-process lock and replaces the file atomically.
A CLI call, an MCP client, an open board, and a live Pi session may therefore all be working on one repository without corrupting the file or losing an edit.

A malformed or unsupported file is reported and never overwritten automatically, so a corrupt roadmap is a question for its owner rather than something a tool silently replaces.
Project Goal operations are unavailable outside a Git repository; in a Pi session, Session Tasks continue to work normally there.

## The committed roadmap has one writer

The roadmap is committed, so every worktree of a repository has its own copy of it, and a change made in a linked worktree lands on that branch alone.
Two people working in two worktrees would each end up with a roadmap the other never sees, which reads as goals disappearing rather than as two files.
So the main worktree is the roadmap's sole writer: a mutation that would change `.worklist/worklist.json` or the legacy `.pi/worklist.json` from a linked worktree is refused as `UNAVAILABLE` with `resolution: run-from-main-worktree` and the main worktree's path, and the CLI maps that to exit code 1.

Reading is unrestricted, and so is anything that cannot fork the roadmap: a `--dry-run`, and a semantic no-op, which writes no bytes.
An explicit `--file` or `$STEPSTONE_WORKLIST` store outside those two committed locations is not the committed roadmap and stays writable from any worktree.

Two repositories cannot answer the question at all, and each says so in its own way rather than under the refusal above.
A repository whose main worktree holds no checkout, which every worktree of a bare clone is, has no checkout to send anyone to: it is refused with `resolution: create-main-worktree-checkout`, naming the Git directory, because a bare directory holds no file anyone can commit.
A `git worktree list` that does not answer leaves the question open, and the write is refused rather than let through: `resolution: retry-main-worktree-lookup` when Git was killed before it answered and the same call may answer next time, `repair-main-worktree-lookup` when Git returned a verdict of its own, carrying what Git said in `details.gitError`.

## Revisions and preconditions

The file carries a monotonic numeric revision, which application callers receive as an opaque string.
Legacy files without a revision remain readable at revision `0` and gain revision `1` on their next mutation.

Optional expected-revision checks run under the same cross-process lock as persistence and return a typed conflict without rewriting stale state.
A Project Goal mutation can also carry the target goal's `updatedAt` as a precondition, checked under that same lock, which guards exactly one goal where the file-wide revision would reject every unrelated concurrent change instead.
Appending to a description resolves against the stored text under the lock, so an added note composes with a concurrent edit rather than replaying the caller's baseline over it.

A semantic no-op preserves the file's bytes, every goal's timestamps, and the revision, so a mutation that asks for the state a goal is already in costs nothing and reports `meta.semanticNoOp`.

Conflicts arrive as the `CONFLICT` error code, with details naming whether the file-wide revision or one goal's `updatedAt` moved, and the CLI maps that to exit code 4.
See [docs/usage.md](usage.md#concurrency-and-conflicts) for how a caller should recover.
