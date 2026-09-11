export interface ApiIdentity { userId: string; sessionId: string; role: 'admin' | 'editor' }
let identity: ApiIdentity | null = null;
export function setApiIdentity(value: ApiIdentity) { identity = value; }
export function getApiIdentity() { return identity; }
