# Generated surfaces and the Pi-free install, under the new name

## `npm run no-pi-install:check` - packs, installs alone, drives the released bin

```console
$ npm run no-pi-install:check
> node ./scripts/no-pi-install-check.ts

Packing the publishable tarball
Installing stepstone-0.1.0.tgz with no dev dependencies and no Pi
  installed 5 packages, none from Pi
Driving the installed bin
  list, add, show, find
  next, ready, waves
  apply-plan --dry-run writes nothing
  guarded mutation refuses, then lands with --confirm
  typed failures instead of stack traces
stepstone 0.1.0 runs from a Pi-free install.
```

## `npm run docs:check` - the two published documents are generated, not hand-edited

```console
$ npm run docs:check
> node ./scripts/generate-docs.ts --check

Generated files are up to date.
```

## What those two generated documents now say

`docs/cli.md`:

````markdown
<!-- Generated from src/cli-contract.ts by scripts/generate-docs.ts. Do not edit manually. -->

# stepstone CLI

Manage repository-wide Project Goals in <git-root>/.pi/worklist.json through the same application service, cross-process lock, and atomic replacement as a live Pi session. Session Tasks live inside a Pi session and are deliberately out of scope.

## Invocation

Use the explicit `@latest` package specifier so a stale local npx cache cannot select an older CLI build:

```sh
npx -y stepstone@latest project <action> [arguments] [flags]
```
````

`.claude/skills/worklist/SKILL.md` - the description a Claude Code session matches against, and the pinned invocation:

```markdown
---
name: worklist
description: "Manage stepstone Project Goals (the shared roadmap in a repo's .pi/worklist.json) from any Claude session. Use when the user asks to add, list, find, update, activate, complete, reopen, archive, or delete a project goal; apply a JSON goal plan; migrate goal IDs; capture brainstormed ideas or future goals on a project's worklist or roadmap; or ask what to work on next, what is ready or unblocked, what can run in parallel, or how the roadmap's dependency order or waves look."
---
...
npx -y stepstone@latest project <action> [arguments] [flags]
npx -y stepstone@latest project list --json
npx -y stepstone@latest project add Support goal templates --description "Let teams share reusable goal outlines"
npx -y stepstone@latest project apply-plan plan.json --dry-run --json
```
