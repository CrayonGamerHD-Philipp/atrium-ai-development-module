/**
 * Konto gelöscht: Projekte, Aufträge und Chat sind Daten der Organisation und bleiben – nur der Personenbezug
 * entfällt. Offene Terminals der Person werden geschlossen (nach dem Commit).
 */
import { sql } from 'drizzle-orm';
import { rowsOf, type ModuleDefinition } from '$lib/sdk/server';
import { sendToRunner, terminalClosed } from './live';

export const onUserDeleted: NonNullable<ModuleDefinition['onUserDeleted']> = async (
	tx,
	{ userId }
) => {
	await tx.execute(sql`UPDATE project SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE task SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(
		sql`UPDATE chat_message SET author_user_id = NULL WHERE author_user_id = ${userId}`
	);
	const open = await rowsOf(
		tx,
		sql`UPDATE workspace_session SET closed_at = COALESCE(closed_at, now()), user_id = NULL
			WHERE user_id = ${userId}
			RETURNING id, runner_id, (closed_at = now()) AS just_closed`
	);
	return {
		afterCommit: async () => {
			for (const s of open.filter((r) => r.just_closed === true)) {
				if (s.runner_id)
					sendToRunner(String(s.runner_id), { type: 'pty-close', sid: String(s.id) });
				terminalClosed(String(s.id), { type: 'revoked' });
			}
		}
	};
};
