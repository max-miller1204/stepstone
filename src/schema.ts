import { StringEnum } from "@earendil-works/pi-ai";
import { type TUnsafe, Type } from "typebox";

const ScopeSchema: TUnsafe<"session" | "project"> = StringEnum(["session", "project"] as const, {
	description: "Whether to operate on session tasks or project goals.",
});

const ActionSchema: TUnsafe<
	| "list"
	| "add"
	| "apply-plan"
	| "move"
	| "update"
	| "set_status"
	| "delete"
	| "complete"
	| "reopen"
	| "archive"
	| "set_active"
> = StringEnum(
	[
		"list",
		"add",
		"apply-plan",
		"move",
		"update",
		"set_status",
		"delete",
		"complete",
		"reopen",
		"archive",
		"set_active",
	] as const,
	{
		description:
			"Action to perform. 'apply-plan' validates or atomically adds a project plan. 'move' reorders a Session Task in its queue or a Project Goal in the roadmap. 'complete', 'reopen', 'archive', and 'delete' on project goals require confirm=true.",
	},
);

export const SessionTaskStatusSchema: TUnsafe<"todo" | "doing" | "done"> = StringEnum([
	"todo",
	"doing",
	"done",
] as const);

export const ProjectGoalStatusSchema: TUnsafe<"open" | "active" | "done" | "archived"> = StringEnum([
	"open",
	"active",
	"done",
	"archived",
] as const);

const StatusSchema: TUnsafe<"todo" | "doing" | "done" | "open" | "active" | "archived"> = StringEnum(
	["todo", "doing", "done", "open", "active", "archived"] as const,
	{
		description:
			"Target status for set_status. Project set_status only accepts active; lifecycle actions use complete, reopen, and archive.",
	},
);

const ProjectGoalPlanEntrySchema = Type.Object(
	{
		title: Type.String({ description: "Required non-empty Project Goal title." }),
		description: Type.Optional(Type.String({ description: "Optional full goal description." })),
		group: Type.Optional(Type.String({ description: "Optional free-form goal section." })),
		dependsOn: Type.Optional(
			Type.Array(Type.String(), {
				description: "Exact pre-collision batch slugs or exact current/former IDs of existing goals.",
			}),
		),
	},
	{ additionalProperties: false },
);

export const WorklistParamsSchema = Type.Object({
	scope: ScopeSchema,
	action: ActionSchema,
	id: Type.Optional(
		Type.String({
			description:
				"Task or goal ID (for move, update, set_status, delete, complete, reopen, archive, set_active). A project goal also accepts a unique prefix of its ID, or an ID it answered to before an ID migration.",
		}),
	),
	title: Type.Optional(Type.String({ description: "Title for add/update." })),
	description: Type.Optional(
		Type.String({
			description: "Description for project goal add/update. Session tasks do not support descriptions.",
		}),
	),
	group: Type.Optional(
		Type.String({
			description:
				"Free-form section for project goal add/update, such as Foundation or Later. Pass an empty string to clear it. Session tasks do not support groups.",
		}),
	),
	dependsOn: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Existing project goal IDs that must land before this one, for project goal add/update. Add resolves these before minting the new goal ID, so read IDs back instead of guessing the new slug; update rejects the goal's own ID as a dependency cycle. Replaces the whole set, so send every edge the goal should end up with; an empty array clears them. An edge means must-land-before, whether the reason is logical or two goals colliding in the same files.",
		}),
	),
	links: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Informational absolute HTTP or HTTPS URLs for project goal add/update. Replaces the whole set; an empty array clears it. Accepted URLs are stored in canonical form and duplicates collapse. Session tasks do not support links.",
		}),
	),
	plan: Type.Optional(
		Type.Array(ProjectGoalPlanEntrySchema, {
			description:
				"Plain JSON goal array for project apply-plan. Batch references resolve by exact pre-collision slug before exact existing current/former IDs.",
		}),
	),
	dryRun: Type.Optional(
		Type.Boolean({
			description: "For project apply-plan, validate and project the batch without writing it.",
		}),
	),
	status: Type.Optional(StatusSchema),
	goalId: Type.Optional(
		Type.String({
			description: "Associate a session task with a project goal ID.",
		}),
	),
	beforeId: Type.Optional(
		Type.String({
			description:
				"Insert or move a Session Task immediately before this stable task ID, or move a Project Goal immediately before this goal ID.",
		}),
	),
	afterId: Type.Optional(
		Type.String({
			description:
				"Insert or move a Session Task immediately after this stable task ID, or move a Project Goal immediately after this goal ID.",
		}),
	),
	confirm: Type.Optional(
		Type.Boolean({
			description:
				"Required boolean for destructive project-goal actions: complete, reopen, archive, delete. Set to true ONLY when the user explicitly requested the action.",
		}),
	),
});
