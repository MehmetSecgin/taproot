import { fetchTshDatabases, tshDbAllowedUsers, tshDbName } from './tsh-databases.js';
import type { DatasourceProfile } from '../../types/datasource.js';
import { firstNonEmpty } from '../../core/text-presence.js';

const allowedUsersByTarget = new Map<string, string[]>();

async function tshAllowedUsers(target: string): Promise<string[]> {
  if (!allowedUsersByTarget.has(target)) {
    const { databases } = await fetchTshDatabases();
    for (const database of databases) {
      allowedUsersByTarget.set(tshDbName(database), tshDbAllowedUsers(database));
    }
  }
  return allowedUsersByTarget.get(target) ?? [];
}

export async function resolveDbUser(datasource: DatasourceProfile, credentials: Record<string, string>): Promise<string> {
  const hints = datasource.resolverHints ?? {};
  const explicitUser = (firstNonEmpty(credentials.dbUser, credentials.user, hints.dbUser, hints.user) ?? '').trim();
  const target = (datasource.connection.target ?? '').trim();
  if (explicitUser !== '' || target === '') {
    return explicitUser;
  }
  const users = await tshAllowedUsers(target);
  if (users.length > 1) {
    throw new Error(
      `teleport-mysql found several allowed db users for '${target}' in 'tsh db ls': ${users.join(', ')}. ` +
        `Pick one with 'taproot creds set --ref ${datasource.credentialRef} --db-user <user>' ` +
        `or 'taproot datasource add --name ${datasource.name} ... --hint dbUser=<user>'.`,
    );
  }
  return users[0] ?? '';
}
