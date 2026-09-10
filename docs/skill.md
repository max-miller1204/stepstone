<!-- markdownlint-disable MD013 -->

# The Agent Skill

The Agent Skill is the primary Stepstone setup for harnesses that support skills.
A skill in `.claude/skills/stepstone/` teaches coding agents to drive the CLI under the same guardrails, so a session manages goals correctly without being walked through it each time.
The main skill contains common reads, safe mutation rules, the approved-plan workflow, and error handling.
It keeps confirmation, concurrency, and dispatch authorization rules in the initial context.
It does not list every action or flag.

The installed `references/guide.md` contains the full command and workflow reference.
The skill links to its plan and dispatch sections for requests that need those details.
Reference paths resolve from the skill directory, not the target repository.
Agents can also run `project help` to check command syntax.
Stepstone prepares workspaces but never launches or supervises agents.

## Install

```sh
npx skills add max-miller1204/stepstone --skill stepstone -g
```

Drop `-g` to install it for the current project only, or add `-a claude-code` to target one agent instead of choosing interactively.
The [`skills` CLI](https://github.com/vercel-labs/skills) reads `.claude/skills/` directly from this repository, symlinks it into each agent's skill directory, and refreshes it later with `npx skills update`.

Installing the npm package does not install the skill.
The tarball carries `.claude/skills/stepstone/SKILL.md` so the published package stays self-describing, but `node_modules` is not a directory agents scan for skills.

The skill installs no code and pins no version: it invokes the published CLI as `npx -y stepstone@latest` and the workspace-preparation driver as `npx -y -p stepstone@latest stepstone-dispatch`, so an agent that loads it is always driving the current release.

## How it is produced

`SKILL.md` and `references/guide.md` are generated from `src/cli-contract.ts` by `scripts/generate-docs.ts`.
The same contract renders the CLI help and [docs/cli.md](cli.md).
Never hand-edit it: run `npm run docs` and commit the result, which `npm run docs:check` and the test suite both enforce.

The generated skill is deliberately repository-neutral, because one file serves every checkout and must never assume it was installed alongside this source tree.
Tests check portable paths, `@latest` invocations, required safety rules, and examples without `--confirm`.
They also check that reference links resolve, the package includes the reference, and the main skill stays below 6,500 bytes.
Full action and flag coverage belongs to the reference tests, not the main skill tests.

Working on the skill itself is the one case for symlinking `.claude/skills/stepstone` into `~/.claude/skills/`, which makes the installed skill track your working tree.
