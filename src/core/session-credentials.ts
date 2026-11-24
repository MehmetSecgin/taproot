import { isNonEmpty } from './text-presence.js';

const SESSION_ID_CREDENTIAL_KEY = '__sessionId';

export function sessionIdOf(credentials: Record<string, string>): string | undefined {
  return credentials[SESSION_ID_CREDENTIAL_KEY];
}

export function withSessionId(credentials: Record<string, string>, sessionId: string | undefined): Record<string, string> {
  return isNonEmpty(sessionId) ? { ...credentials, [SESSION_ID_CREDENTIAL_KEY]: sessionId } : credentials;
}
