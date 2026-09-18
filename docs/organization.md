# Projects, milestones, and tasks

A **project** is a larger effort. It owns one worklist. A project can have no repository, one repository, or several repository links. Repository links identify related code. They do not select storage, create checkouts, or grant access to code.

A **milestone** is a meaningful outcome within a project. Its title describes the outcome. Its description can state acceptance criteria. A milestone has a stable ID and can exist before it has tasks.

A **task** is actionable work within a project. A task can belong to one milestone or have no milestone. It keeps its own status, dependencies, branch claim, links, and identity history. Membership does not imply a dependency. Tasks can depend on tasks in other milestones in the same project.

Session Tasks remain a separate Pi session queue. They are not project tasks. Their `goalId` references continue to identify project tasks.

## Create a project

Use an explicit store for an effort that has no repository:

```sh
npx -y stepstone@latest project configure "Release preparation" --file ./release.json --confirm --json
npx -y stepstone@latest project add_milestone "Documentation is ready" --file ./release.json --json
npx -y stepstone@latest project add "Review the installation guide" --file ./release.json --json
npx -y stepstone@latest project assign_milestone review-the-installation-guide --milestone documentation-is-ready --file ./release.json --json
npx -y stepstone@latest project structure --file ./release.json --json
```

Read IDs from command results. The example IDs assume that those titles have no collisions.

Run the same commands in a repository without `--file` to use its existing worklist. `STEPSTONE_WORKLIST` can also select an explicit store. The process directory must exist. An explicit store does not need Git discovery.

`configure` requires confirmation because its first call upgrades the storage format. It creates a frozen project ID from the title. Later calls keep that ID. Use repeated `--repository` arguments to replace the complete repository set. Use `--repository ''` to clear it. Each link must be an absolute HTTP or HTTPS URL. No repository is inferred from the current checkout.

```sh
npx -y stepstone@latest project configure "Release preparation" --file ./release.json --confirm \
  --repository https://github.com/example/client \
  --repository https://github.com/example/service
```

Use `update_milestone <id>` to change an outcome's title or description. Use `assign_milestone <task-id> --milestone ''` to remove membership. Milestone IDs are exact. Task selectors retain current IDs, former IDs, and unique prefixes.

## Existing Project Goals

Every existing Project Goal maps to one task. The upgrade retains the stored `goals` array as the single task collection. It does not copy tasks into a second stored array. `project structure` exposes that collection as `result.projectStructure.tasks`.

The upgrade preserves task IDs, `previousIds`, `retiredIds`, task order, dependencies, links, branch claims, timestamps, free-form groups, and historical fields. It creates no milestones from titles or groups. It changes no task status and infers no completion date. Old session references, pull request descriptions, and commit references keep the same meaning.

Task ID migration remains the separate `migrate_ids` action. It preserves former IDs and rewrites stored dependency references. Deleted task IDs remain reserved. Project and milestone IDs have separate namespaces and remain frozen after title edits. IDs are scoped to their worklist. A future service that holds several worklists must identify the worklist as well as the entity ID. Repository URLs are not identity keys.

## Storage and concurrency

Version 1 remains readable. Normal task edits keep it at version 1. `configure --confirm` explicitly upgrades it to version 2 and adds project metadata and a milestone array. Old clients that only support version 1 reject version 2. Do not use those clients to edit an upgraded store.

Version 2 validates project metadata, unique milestone IDs, repository links, and task membership. Invalid data fails before a write. Unknown versions fail. There is no downgrade or automatic repair. If a legacy file already uses the reserved `project`, `milestones`, or task `milestoneId` fields as opaque metadata, the upgrade refuses to replace them. Existing legacy reads and task edits preserve that metadata.

All writes use `WorklistApplicationService` and `project-mutations.ts`. The existing cross-process lock, atomic replacement, main-worktree restriction, and lifecycle confirmation apply. Use `--expect-revision` on the CLI or `expectedRevision` in application requests for project and milestone edits. Task assignment also accepts `expectedUpdatedAt`. A semantic no-op preserves file bytes and revision.

## Interface compatibility

| Interface | Contract |
| --- | --- |
| CLI | Existing `project` task commands and JSON envelopes remain supported. Organization adds `structure`, `configure`, `add_milestone`, `update_milestone`, and `assign_milestone`. |
| Agent tool | The same actions use `scope: "project"`. New fields are `repositories` and `milestoneId`. `configure` requires `confirm: true`. Existing goal and session result fields keep their meaning. |
| Browser | The existing board continues to edit project tasks. Its authenticated local API supports organization operations and a structure read. The board does not yet offer milestone controls. |
| Future server | Use the same application operations and versioned storage model. Resolve a store explicitly. Read `projectStructure` as one revision. Do not derive project identity from a repository or write storage directly. No hosted server protocol is introduced here. |

`configure` returns one `project`. Milestone edits return one `milestone`. These mutation receipts do not include the full task collection.

`structure` returns a complete project snapshot. Existing bounded agent `list` and single-task `show` reads remain available. The `goal`, `goals`, `goalId`, and `projectGoalIds` names remain compatibility fields for project tasks. The `tasks` field outside `projectStructure` still means Session Tasks.

Milestones have no independent status or lifecycle actions in this foundation. Task completion does not assert that a milestone outcome is achieved. Cross-project dependencies, project catalogs, hosted storage, and collaboration protocols are outside this change.
