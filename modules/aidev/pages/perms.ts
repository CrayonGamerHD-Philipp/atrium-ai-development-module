/** Rechte im Browser – nur zum Ein-/Ausblenden, der Server prüft selbst. In reaktiven Kontexten aufrufen. */
import { page } from '$app/state';
import { can } from '$lib/sdk/client';
import { PERM } from '../schemas';

export function permissions(): string[] {
	return ((page.data as { permissions?: string[] }).permissions ?? []) as string[];
}

export const has = (key: string) => can(permissions(), key);

export { PERM };
