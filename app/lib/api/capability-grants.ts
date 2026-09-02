"use client";

/**
 * Operator-app helpers for the capability grant/revoke surface
 * introduced in roadmap §6. The backend exposes:
 *
 *   GET    /admin/capability-grants[?subject=&status=]
 *   POST   /admin/capability-grants               { subject, capabilities, scope?, note?, expiresAt?, idempotencyKey? }
 *   POST   /admin/capability-grants/:id/revoke    { note?, idempotencyKey? }
 *
 * Each grant is persisted alongside an audit-event mutation receipt
 * so /audit-log surfaces every change. Revocation has immediate
 * effect (next request after the 15s middleware cache lapses; the
 * UI invalidates the SWR cache so the panel reflects the new state
 * instantly).
 */

import { swrFetcher } from "./client";

export interface CapabilityGrant {
  id: string;
  subject: string;
  capabilities: string[];
  scope?: string;
  note?: string;
  issuedBy: string;
  issuedAt: string;
  expiresAt?: string;
  status: "active" | "revoked";
  revokedAt?: string;
  revokedBy?: string;
  revokeNote?: string;
}

export interface CapabilityGrantListResponse {
  items: CapabilityGrant[];
  limit: number;
  offset: number;
}

export interface CreateCapabilityGrantInput {
  subject: string;
  capabilities: string[];
  scope?: string;
  note?: string;
  expiresAt?: string;
  idempotencyKey?: string;
}

export async function createCapabilityGrant(
  input: CreateCapabilityGrantInput
): Promise<CapabilityGrant> {
  return swrFetcher<CapabilityGrant>([
    "/admin/capability-grants",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  ]);
}

export async function revokeCapabilityGrant(
  id: string,
  options: { note?: string; idempotencyKey?: string } = {}
): Promise<CapabilityGrant> {
  return swrFetcher<CapabilityGrant>([
    `/admin/capability-grants/${encodeURIComponent(id)}/revoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    },
  ]);
}
