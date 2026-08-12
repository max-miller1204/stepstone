<!-- markdownlint-disable MD013 -->

# The agent skill

A skill in `.claude/skills/stepstone/` teaches coding agents to drive the CLI under the same guardrails, so a session manages goals correctly without being walked through it each time.
It carries the action and flag surface, the description-input rules, the sequencing reads, the exit-code meanings, the brainstorm-to-approved-plan capture workflow, and the rule that a lifecycle action needs an explicit request from the user.

## Install

```sh
npx skills add max-miller1204/stepstone --skill stepstone -g
```

Drop `-g` to install it for the current project only, or add `-a claude-code` to target one agent instead of choosing interactively.
The [`skills` CLI](https://github.com/vercel-labs/skills) reads `.claude/skills/` directly from this repository, symlinks it into each agent's skill directory, and refreshes it later with `npx skills update`.

Installing the npm package does not install the skill.
The tarball carries `.claude/skills/stepstone/SKILL.md` so the published package stays self-describing, but `node_modules` is not a directory agents scan for skills.

The skill installs no code and pins no version: it invokes the published CLI as `npx -y stepstone@latest`, so an agent that loads it is always driving the current release.

## Claude Code plugin versus the standalone skill

Claude Code users can instead install the complete Stepstone plugin:

```text
/plugin marketplace add max-miller1204/stepstone
/plugin install stepstone@stepstone
```

The plugin includes the same generated skill bytes plus a cache-local MCP server and five namespaced commands: the read-only `/stepstone:list`, `/stepstone:next`, `/stepstone:ready`, and `/stepstone:waves`, and the human-only interactive `/stepstone:ui`.
It intentionally includes no slash commands for mutations, `show`, or `find`.
Use the `npx skills add` command above when you want only portable guidance for one or more supported agents.
Use the Claude Code plugin when you also want the bundled protocol server and namespaced commands.

## How it is produced

`SKILL.md` is generated from `src/cli-contract.ts` by `scripts/generate-docs.ts`, the same contract that renders the CLI help and [docs/cli.md](cli.md).
Never hand-edit it: run `npm run docs` and commit the result, which `npm run docs:check` and the test suite both enforce.

The generated skill is deliberately repository-neutral, because one file serves every checkout and must never assume it was installed alongside this source tree.
The tests enforce that too: no absolute path may appear in it, every invocation must use the cache-safe `npx -y stepstone@latest` form, and its examples may never hand an agent a copy-paste lifecycle command or a `--confirm` flag.

Working on the skill itself is the one case for symlinking `.claude/skills/stepstone` into `~/.claude/skills/`, which makes the installed skill track your working tree.
