import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { WorklistOperation } from "../application-service.ts";
import { WorklistApplicationService } from "../application-service.ts";
import { findGoalByStoredId } from "../goal-selection.ts";
import { createEmptyWorklist } from "../project-store.ts";
import type { RevisionedProjectWorklist } from "../types.ts";
import { transaction } from "./database.ts";
import {
	assertImportRequest,
	assertProjectId,
	assignImportedIdentities,
	parseImportWorklist,
	type WorklistImportInput,
	worklistFingerprint,
} from "./import.ts";
import type { Command, Principal, Receipt, Role, Scope } from "./protocol.ts";
import { canonical, hash, parseCommand, ServiceError } from "./protocol.ts";

interface ImportSource {
	fingerprint: string;
	fileRevision: number;
}
interface State {
	worklist: RevisionedProjectWorklist;
	/** Includes deleted tasks. Identity can never be reused. */
	identities: Record<string, string>;
	/** Last file accepted by operator import. Domain commands leave it in place. */
	importSource?: ImportSource;
}
export interface WorklistImportResult {
	projectId: string;
	revision: number;
	changed: boolean;
	resolution: "unchanged" | "initial" | "replace-with-file";
	fingerprint: string;
	fileRevision: number;
	taskCount: number;
	dryRun: boolean;
}
export interface Snapshot {
	version: 1;
	projectId: string;
	revision: number;
	cursor: number;
	worklist: RevisionedProjectWorklist;
	tasks: { taskId: string; reference: string }[];
}
function projection(projectId: string, state: State): Snapshot {
	return {
		version: 1,
		projectId,
		revision: state.worklist.revision,
		cursor: state.worklist.revision,
		worklist: state.worklist,
		tasks: state.worklist.goals.map((goal) => ({ taskId: state.identities[goal.id], reference: goal.id })),
	};
}
function active(principal: Principal): void {
	if (principal.expiresAt <= Date.now())
		throw new ServiceError("UNAUTHORIZED", "Credential has expired.", 401);
}

export class AuthoritativeService {
	readonly pool: Pool;
	constructor(pool: Pool) {
		this.pool = pool;
	}

	/** Caller holds the project lock through authorization and data access. */
	private async authorize(
		client: PoolClient,
		projectId: string,
		principal: Principal,
		scope: Scope,
		owner = false,
	): Promise<Role> {
		active(principal);
		let role: Role | undefined;
		if (principal.credential) {
			const row = (
				await client.query("SELECT * FROM stepstone_credentials WHERE id=$1 AND project_id=$2", [
					principal.credential.id,
					projectId,
				])
			).rows[0];
			if (
				!row ||
				row.revoked ||
				row.token_hash !== principal.credential.hash ||
				new Date(row.expires_at).getTime() <= Date.now()
			)
				throw new ServiceError("UNAUTHORIZED", "Service credential is invalid or revoked.", 401);
			if (!row.scopes.includes(scope))
				throw new ServiceError("FORBIDDEN", "Service credential does not grant this scope.", 403);
			role = row.role;
		} else {
			role = (
				await client.query("SELECT role FROM stepstone_members WHERE project_id=$1 AND actor_id=$2", [
					projectId,
					principal.actorId,
				])
			).rows[0]?.role;
		}
		if (
			!role ||
			(owner && role !== "owner") ||
			((scope === "write" || scope === "delete") && role === "reader")
		)
			throw new ServiceError("FORBIDDEN", "Project membership does not grant this operation.", 403);
		return role;
	}
	private async lock(
		client: PoolClient,
		projectId: string,
		write: boolean,
	): Promise<{ state: State; projection: Snapshot; revision: string }> {
		const row = (
			await client.query(
				`SELECT state, projection, revision FROM stepstone_projects WHERE id=$1 FOR ${write ? "UPDATE" : "SHARE"}`,
				[projectId],
			)
		).rows[0];
		if (!row) throw new ServiceError("NOT_FOUND", "Project was not found.", 404);
		return row;
	}
	async snapshot(principal: Principal, projectId: string): Promise<Snapshot> {
		return transaction(this.pool, async (client) => {
			const row = await this.lock(client, projectId, false);
			await this.authorize(client, projectId, principal, "read");
			return row.projection;
		});
	}
	async events(principal: Principal, projectId: string, after: number): Promise<Receipt[]> {
		return transaction(this.pool, async (client) => {
			const row = await this.lock(client, projectId, false);
			await this.authorize(client, projectId, principal, "subscribe");
			if (!Number.isSafeInteger(after) || after < 0 || after > Number(row.revision))
				throw new ServiceError("SNAPSHOT_REQUIRED", "Fetch a snapshot to establish a valid cursor.", 409);
			return (
				await client.query(
					"SELECT event FROM stepstone_events WHERE project_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100",
					[projectId, after],
				)
			).rows.map((row) => row.event);
		});
	}
	async access(principal: Principal, projectId: string): Promise<unknown> {
		return transaction(this.pool, async (client) => {
			await this.lock(client, projectId, false);
			await this.authorize(client, projectId, principal, "read", true);
			return {
				members: (
					await client.query(
						"SELECT actor_id, role FROM stepstone_members WHERE project_id=$1 ORDER BY actor_id",
						[projectId],
					)
				).rows,
				credentials: (
					await client.query(
						"SELECT id, role, scopes, expires_at, revoked FROM stepstone_credentials WHERE project_id=$1 ORDER BY id",
						[projectId],
					)
				).rows,
			};
		});
	}
	async execute(principal: Principal, input: unknown): Promise<Receipt> {
		const command = parseCommand(input);
		active(principal);
		return transaction(this.pool, async (client) => {
			const { operation, projectId } = command;
			if (operation.action === "create_project") {
				if (!principal.administrator || principal.credential)
					throw new ServiceError("FORBIDDEN", "Project creation requires an instance administrator.", 403);
				if (command.expectedRevision !== 0)
					throw new ServiceError("REVISION_CONFLICT", "Project creation requires revision zero.", 409);
				// The advisory lock also serializes retries before the project row exists.
				await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [projectId]);
				const state: State = { worklist: createEmptyWorklist(), identities: {} };
				const created = await client.query(
					"INSERT INTO stepstone_projects(id,revision,state,projection) VALUES($1,0,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
					[projectId, state, projection(projectId, state)],
				);
				if (created.rowCount)
					await client.query("INSERT INTO stepstone_members VALUES($1,$2,'owner')", [
						projectId,
						principal.actorId,
					]);
			}
			const row = await this.lock(client, projectId, true);
			const owner = [
				"configure",
				"delete",
				"migrate_ids",
				"set_member",
				"grant_service",
				"revoke_service",
			].includes(operation.action);
			await this.authorize(
				client,
				projectId,
				principal,
				operation.action === "delete" ? "delete" : "write",
				owner,
			);
			const fingerprint = hash(canonical(command));
			const prior = (
				await client.query(
					"SELECT actor_id,fingerprint,result FROM stepstone_receipts WHERE project_id=$1 AND command_id=$2",
					[projectId, command.commandId],
				)
			).rows[0];
			if (prior) {
				if (prior.actor_id !== principal.actorId || prior.fingerprint !== fingerprint)
					throw new ServiceError(
						"IDEMPOTENCY_CONFLICT",
						"Command ID was already used by another actor or with different content.",
						409,
					);
				return prior.result;
			}
			if (Number(row.revision) !== command.expectedRevision)
				throw new ServiceError("REVISION_CONFLICT", `Current project revision is ${row.revision}.`, 409);
			if (!Number.isSafeInteger(command.expectedRevision + 1))
				throw new ServiceError("REVISION_EXHAUSTED", "Project revision cannot advance.", 409);
			const state = row.state;
			let taskIds: string[] = [];
			if (operation.action === "set_member") {
				if (operation.role === null)
					await client.query("DELETE FROM stepstone_members WHERE project_id=$1 AND actor_id=$2", [
						projectId,
						operation.actorId,
					]);
				else
					await client.query(
						"INSERT INTO stepstone_members VALUES($1,$2,$3) ON CONFLICT(project_id,actor_id) DO UPDATE SET role=excluded.role",
						[projectId, operation.actorId, operation.role],
					);
				const owners = await client.query(
					"SELECT 1 FROM stepstone_members WHERE project_id=$1 AND role='owner'",
					[projectId],
				);
				if (!owners.rowCount) throw new ServiceError("LAST_OWNER", "A project must retain an owner.", 409);
			} else if (operation.action === "grant_service") {
				if (Date.parse(operation.expiresAt) <= Date.now())
					throw new ServiceError("VALIDATION_FAILED", "Service credential expiry must be in the future.");
				const inserted = await client.query(
					"INSERT INTO stepstone_credentials(id,project_id,token_hash,role,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",
					[
						operation.credentialId,
						projectId,
						operation.tokenHash,
						operation.role,
						JSON.stringify(operation.scopes),
						operation.expiresAt,
					],
				);
				if (!inserted.rowCount)
					throw new ServiceError(
						"CREDENTIAL_EXISTS",
						"Credential identity is already in use or retired.",
						409,
					);
			} else if (operation.action === "revoke_service") {
				const changed = await client.query(
					"UPDATE stepstone_credentials SET revoked=true WHERE id=$1 AND project_id=$2",
					[operation.credentialId, projectId],
				);
				if (!changed.rowCount) throw new ServiceError("NOT_FOUND", "Service credential was not found.", 404);
			} else {
				taskIds = await this.domain(state, command);
			}
			state.worklist.revision = command.expectedRevision + 1;
			const receipt: Receipt = {
				version: 1,
				projectId,
				commandId: command.commandId,
				actorId: principal.actorId,
				revision: state.worklist.revision,
				cursor: state.worklist.revision,
				action: operation.action,
				taskIds,
			};
			await client.query("UPDATE stepstone_projects SET revision=$2,state=$3,projection=$4 WHERE id=$1", [
				projectId,
				receipt.revision,
				state,
				projection(projectId, state),
			]);
			await client.query(
				"INSERT INTO stepstone_events(project_id,sequence,command_id,actor_id,event) VALUES($1,$2,$3,$4,$5)",
				[projectId, receipt.cursor, command.commandId, principal.actorId, receipt],
			);
			await client.query(
				"INSERT INTO stepstone_receipts(project_id,command_id,actor_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)",
				[projectId, command.commandId, principal.actorId, fingerprint, receipt],
			);
			return receipt;
		});
	}
	private async domain(state: State, command: Command): Promise<string[]> {
		const { taskId, ...fields } = command.operation as Command["operation"] & { taskId?: string };
		const task = taskId
			? state.worklist.goals.find((goal) => state.identities[goal.id] === taskId)
			: undefined;
		if (taskId && !task) throw new ServiceError("NOT_FOUND", "Task identity was not found.", 404);
		const operation = { ...fields, scope: "project", ...(task ? { id: task.id } : {}) } as WorklistOperation;
		if (operation.action === "create_project") operation.action = "configure";
		const before = structuredClone(state.worklist);
		const result = await new WorklistApplicationService({ projectStore: state }).execute(operation, {
			source: "cli",
		});
		if (!result.ok)
			throw new ServiceError(
				result.error.code,
				result.error.message,
				result.error.code === "APPROVAL_REQUIRED" ? 403 : 400,
			);
		const affected: string[] = [];
		for (const goal of state.worklist.goals) {
			const previous = before.goals.find((old) => old.id === goal.id || goal.previousIds?.includes(old.id));
			if (!Object.hasOwn(state.identities, goal.id))
				state.identities = {
					...state.identities,
					[goal.id]: previous ? state.identities[previous.id] : randomUUID(),
				};
			if (
				!previous ||
				canonical(previous) !== canonical(goal) ||
				result.meta.changedEntities?.projectGoalIds.includes(goal.id)
			)
				affected.push(state.identities[goal.id]);
		}
		for (const old of before.goals)
			if (!findGoalByStoredId(state.worklist.goals, old.id, state.worklist.retiredIds ?? []))
				affected.push(state.identities[old.id]);
		return [...new Set(affected)];
	}
	/**
	 * Install a validated worklist snapshot as one command.
	 *
	 * Replaying the file through goal mutations would mint new references and
	 * timestamps. Import keeps the stored history and only borrows the same
	 * schema, identity, and cycle checks those mutations already enforce.
	 * The caller reads the file. This method never writes it.
	 */
	async importWorklist(input: WorklistImportInput): Promise<WorklistImportResult> {
		assertImportRequest(input.projectId, input.actorId);
		const worklist = parseImportWorklist(input.worklist);
		const fingerprint = worklistFingerprint(worklist);
		const fileRevision = worklist.revision;
		const outcome = (
			resolution: WorklistImportResult["resolution"],
			revision: number,
			changed: boolean,
		): WorklistImportResult => ({
			projectId: input.projectId,
			revision,
			changed,
			resolution,
			fingerprint,
			fileRevision,
			taskCount: worklist.goals.length,
			dryRun: input.dryRun,
		});
		return transaction(this.pool, async (client) => {
			await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.projectId]);
			const row = (
				await client.query("SELECT state, revision FROM stepstone_projects WHERE id=$1 FOR UPDATE", [
					input.projectId,
				])
			).rows[0] as { state: State; revision: string } | undefined;
			if (!row) {
				if (input.dryRun) return outcome("initial", 1, true);
				const imported = this.importedState(worklist, fingerprint, fileRevision, {
					worklist: createEmptyWorklist(),
					identities: {},
				});
				await this.writeImport(client, input.projectId, input.actorId, 0, imported, true);
				return outcome("initial", 1, true);
			}
			const member = (
				await client.query("SELECT role FROM stepstone_members WHERE project_id=$1 AND actor_id=$2", [
					input.projectId,
					input.actorId,
				])
			).rows[0];
			if (member?.role !== "owner") {
				throw new ServiceError("FORBIDDEN", "Worklist import requires a project owner.", 403);
			}
			const current = Number(row.revision);
			if (worklistFingerprint(row.state.worklist) === fingerprint)
				return outcome("unchanged", current, false);
			if (!input.replace) {
				const serverFingerprint = worklistFingerprint(row.state.worklist).slice(0, 12);
				throw new ServiceError(
					"DIVERGENT_HISTORY",
					`Server project ${input.projectId} revision ${current} does not match this worklist ` +
						`(server ${serverFingerprint}, file ${fingerprint.slice(0, 12)}). ` +
						"Pass --replace to accept the file as the canonical projection. " +
						"Matching stored goal IDs keep their task identities. The source file is left unchanged.",
					409,
				);
			}
			if (!Number.isSafeInteger(current + 1)) {
				throw new ServiceError("REVISION_EXHAUSTED", "Project revision cannot advance.", 409);
			}
			if (input.dryRun) return outcome("replace-with-file", current + 1, true);
			const imported = this.importedState(worklist, fingerprint, fileRevision, row.state);
			await this.writeImport(client, input.projectId, input.actorId, current, imported, false);
			return outcome("replace-with-file", current + 1, true);
		});
	}
	private importedState(
		worklist: RevisionedProjectWorklist,
		fingerprint: string,
		fileRevision: number,
		previous: State,
	): State {
		const stored = structuredClone(worklist);
		const identities = assignImportedIdentities(
			previous.worklist.goals,
			previous.worklist.retiredIds ?? [],
			previous.identities,
			stored,
		);
		return {
			worklist: stored,
			identities,
			importSource: { fingerprint, fileRevision },
		};
	}
	private async writeImport(
		client: PoolClient,
		projectId: string,
		actorId: string,
		currentRevision: number,
		state: State,
		create: boolean,
	): Promise<void> {
		const revision = currentRevision + 1;
		state.worklist.revision = revision;
		const receipt: Receipt = {
			version: 1,
			projectId,
			commandId: randomUUID(),
			actorId,
			revision,
			cursor: revision,
			action: "import_worklist",
			taskIds: state.worklist.goals.map((goal) => state.identities[goal.id]),
		};
		const projected = projection(projectId, state);
		if (create) {
			await client.query("INSERT INTO stepstone_projects(id,revision,state,projection) VALUES($1,$2,$3,$4)", [
				projectId,
				revision,
				state,
				projected,
			]);
			await client.query("INSERT INTO stepstone_members VALUES($1,$2,'owner')", [projectId, actorId]);
		} else {
			await client.query("UPDATE stepstone_projects SET revision=$2,state=$3,projection=$4 WHERE id=$1", [
				projectId,
				revision,
				state,
				projected,
			]);
		}
		await client.query(
			"INSERT INTO stepstone_events(project_id,sequence,command_id,actor_id,event) VALUES($1,$2,$3,$4,$5)",
			[projectId, revision, receipt.commandId, actorId, receipt],
		);
		await client.query(
			"INSERT INTO stepstone_receipts(project_id,command_id,actor_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)",
			[projectId, receipt.commandId, actorId, hash(canonical(receipt)), receipt],
		);
	}
	async exportWorklist(projectId: string): Promise<RevisionedProjectWorklist> {
		assertProjectId(projectId);
		return transaction(this.pool, async (client) => {
			const row = await this.lock(client, projectId, false);
			return structuredClone(row.state.worklist);
		});
	}
	async verify(): Promise<void> {
		await transaction(this.pool, async (client) => {
			await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
			const projects = (await client.query("SELECT id, revision, state, projection FROM stepstone_projects"))
				.rows;
			for (const row of projects) {
				const state = row.state as State;
				if (
					state.worklist.revision !== Number(row.revision) ||
					canonical(projection(row.id, state)) !== canonical(row.projection)
				)
					throw new Error("Project projection is inconsistent.");
				const identities = state.worklist.goals.map((goal) => state.identities[goal.id]);
				if (identities.some((id) => !id) || new Set(identities).size !== identities.length)
					throw new Error("Task identities are inconsistent.");
				const counts = (
					await client.query(
						`SELECT
 (SELECT count(*) FROM stepstone_events WHERE project_id=$1) AS events,
 (SELECT count(*) FROM stepstone_receipts WHERE project_id=$1) AS receipts,
 (SELECT coalesce(max(sequence),0) FROM stepstone_events WHERE project_id=$1) AS last,
 (SELECT count(*) FROM stepstone_members WHERE project_id=$1 AND role='owner') AS owners`,
						[row.id],
					)
				).rows[0];
				if (
					counts.events !== row.revision ||
					counts.receipts !== row.revision ||
					counts.last !== row.revision ||
					Number(counts.owners) === 0
				)
					throw new Error("Project history or owner membership is inconsistent.");
				const invalid = await client.query(
					`SELECT 1 FROM stepstone_events e LEFT JOIN stepstone_receipts r
 ON r.project_id=e.project_id AND r.command_id=e.command_id
 WHERE e.project_id=$1 AND (r.command_id IS NULL OR e.event<>r.result OR e.actor_id<>r.actor_id
 OR e.event->>'cursor'<>e.sequence::text OR e.event->>'revision'<>e.sequence::text
 OR e.event->>'projectId'<>e.project_id::text OR e.event->>'commandId'<>e.command_id::text) LIMIT 1`,
					[row.id],
				);
				if (invalid.rowCount) throw new Error("Events and command receipts disagree.");
			}
		});
	}
	async storage(): Promise<unknown> {
		return (
			await this.pool.query(`SELECT p.id, p.revision, pg_column_size(p.state) AS state_bytes,
 pg_column_size(p.projection) AS projection_bytes,
 (SELECT count(*) FROM stepstone_events e WHERE e.project_id=p.id) AS events,
 (SELECT coalesce(sum(pg_column_size(e)),0) FROM stepstone_events e WHERE e.project_id=p.id) AS event_bytes,
 (SELECT count(*) FROM stepstone_receipts r WHERE r.project_id=p.id) AS receipts,
 (SELECT coalesce(sum(pg_column_size(r)),0) FROM stepstone_receipts r WHERE r.project_id=p.id) AS receipt_bytes
 FROM stepstone_projects p ORDER BY p.id`)
		).rows;
	}
}
