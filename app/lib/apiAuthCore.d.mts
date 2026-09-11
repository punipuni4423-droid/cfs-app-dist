export interface AuthKeys { version: number; secret: string }
export interface AccessSession { kind: 'session'; role: 'admin' | 'editor'; userId: string; sessionId: string; exp: number }
export const COOKIE_NAME: string;
export const SESSION_SECONDS: number;
export function authFile(): string;
export function readAuthKeys(): Promise<AuthKeys>;
export function createGrant(keys: AuthKeys, role?: 'admin' | 'editor'): string;
export function exchangeGrant(grant: string, keys: AuthKeys): string | null;
export function readSession(token: string, keys: AuthKeys): AccessSession | null;
export function sessionToken(request: Request): string;
