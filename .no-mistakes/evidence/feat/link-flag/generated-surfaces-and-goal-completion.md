# The agent-facing surfaces the change regenerates, and the goal it closes

Each block is real output from this worktree.

## The block `stepstone project init` writes into a repository's AGENTS.md

This is the guidance every coding agent in a consuming repository reads. It is
rendered from the CLI contract, so the new flag reaches it without a hand edit.

```console
$ stepstone project init && sed -n '/^Flags:/p' AGENTS.md
Flags: `--json`, `--confirm`, `--cwd <dir>`, `--file <path>`, `--description <text>`, `--append-description <text>`, `--append`, `--group <name>`, `--depends-on <id>`, `--link <url>`, `--expect-updated-at <timestamp>`, `--dry-run`.
```

## Every generated file matches its generator

The repository's own drift check over docs/cli.md, the two SKILL.md renders,
AGENTS.md, and docs/ROADMAP.md.

```console
$ npm run docs:check
Generated files are up to date.
```

## The canonical goal this change closes, read back through the CLI

```console
$ stepstone project show link-flag-write-the-reserved-links | head -8
link-flag-write-the-reserved-links: link-flag: write the reserved links field from add and update
status: done
group: Foundation
created: 2026-08-05T15:33:01.104Z
updated: 2026-08-12T04:52:47.734Z
completed: 2026-08-12T04:52:47.734Z
depends on:
  description-flag-order-independent [done]
```

## The regenerated roadmap page carries the same status and the new totals

```console
$ grep -n 'goals: .* open' docs/ROADMAP.md; grep -n 'link-flag: write the reserved links field' docs/ROADMAP.md
10:45 goals: 13 open, 29 done, 3 archived.
109:- **[done]** link-flag: write the reserved links field from add and update - `link-flag-write-the-reserved-links`
```
