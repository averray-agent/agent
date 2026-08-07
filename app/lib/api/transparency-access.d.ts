export interface TransparencyGatedSection {
  readonly title: string;
  readonly meta: string;
}

export const TRANSPARENCY_GATED_SECTIONS: ReadonlyArray<TransparencyGatedSection>;

export interface AuthorizationRequirement {
  /** 401 or 403 — the only statuses that produce a requirement. */
  status: number;
  /** Backend error code, e.g. `missing_token` / `missing_capability`. */
  code: string;
  capabilities: string[];
  missingCapabilities: string[];
  requiredAction: string;
  requiredRole: string;
}

export interface TransparencyUnauthorizedState extends AuthorizationRequirement {
  kind: "unauthorized";
  /** True when a wallet session is present locally. */
  signedIn: boolean;
  /** Full signed-in address, or "" when none is readable. */
  wallet: string;
  /** Resolved roles joined, or "worker" when the backend resolved none. */
  role: string;
}

export type TransparencyAccessState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unavailable" }
  | TransparencyUnauthorizedState;

export interface TransparencyAuthorizationNotice {
  headline: string;
  capabilitySentence: string;
  identitySentence: string;
  boundarySentence: string;
  nextStep: string;
  gatedSections: ReadonlyArray<TransparencyGatedSection>;
}

export function authorizationRequirement(error: unknown): AuthorizationRequirement | null;

export function transparencyAccessState(input?: {
  request?: { data?: unknown; error?: unknown; isLoading?: boolean } | null;
  auth?: { authenticated?: boolean; wallet?: string; roles?: string[] } | null;
}): TransparencyAccessState;

export function transparencyAuthorizationNotice(state?: {
  capabilities?: string[];
  role?: string;
  wallet?: string;
  signedIn?: boolean;
  requiredRole?: string;
}): TransparencyAuthorizationNotice;

export function signedInRoleLabel(roles: unknown): string;
