"use client";

import { useMemo, useState } from "react";
import { mutate } from "swr";
import { useAuthSession, useCapabilityGrants } from "@/lib/api/hooks";
import { ApiError } from "@/lib/api/client";
import {
  buildAuthSession,
  canUseControl,
  type AuthSession,
} from "@/lib/auth/capabilities";
import {
  createCapabilityGrant,
  revokeCapabilityGrant,
  type CapabilityGrant,
} from "@/lib/api/capability-grants";

const GRANTS_PATH = "/admin/capability-grants?limit=200";

/*
 * Capability grants admin page (roadmap §6).
 *
 * Modelled after Polkadot's Staking Operator Proxy: an admin can
 * delegate a strict subset of platform capabilities to a service
 * wallet (an automation bot, a co-operator, etc.), and revoke the
 * grant at any time. Capability-management capabilities themselves
 * are reserved — the backend rejects any attempt to grant
 * `admin:capabilities:*`, preventing delegation chains.
 *
 * The page reads `/admin/capability-grants` and gates its controls
 * via `canUseControl(session, "admin.capabilities.*")`, so a viewer
 * without the relevant capability sees disabled buttons with a hint
 * instead of hitting a 403 from the backend.
 */
export default function CapabilitiesPage() {
  const sessionRequest = useAuthSession();
  const grantsRequest = useCapabilityGrants();
  const session = useMemo(() => buildAuthSession(sessionRequest.data), [sessionRequest.data]);

  const grants = extractGrants(grantsRequest.data);
  const known = useMemo(() => listKnownCapabilities(session), [session]);

  const viewGate = canUseControl(session, "admin.capabilities.view");
  const grantGate = canUseControl(session, "admin.capabilities.grant");
  const revokeGate = canUseControl(session, "admin.capabilities.revoke");

  const unauthorized =
    grantsRequest.error instanceof ApiError &&
    (grantsRequest.error.status === 401 || grantsRequest.error.status === 403);

  const [active, revoked] = useMemo(() => {
    const a: CapabilityGrant[] = [];
    const r: CapabilityGrant[] = [];
    for (const grant of grants) {
      if (grant.status === "active") a.push(grant);
      else r.push(grant);
    }
    return [a, r];
  }, [grants]);

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <span
          className="font-[family-name:var(--font-display)] text-[11.5px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Operator delegation
        </span>
        <h1 className="m-0 font-[family-name:var(--font-display)] text-[2.4rem] font-bold leading-none text-[var(--avy-ink)]">
          Capability grants
        </h1>
        <p className="m-0 mt-0.5 max-w-[62ch] font-[family-name:var(--font-body)] text-[16px] leading-[1.55] text-[var(--avy-muted)]">
          Issue scoped capabilities to a service wallet — automation
          bots, hosted operators, or co-signers — without granting
          full admin. Modelled after Polkadot&rsquo;s Staking Operator
          Proxy: a strict subset, no further delegation, revocable at
          any time. Every grant and revoke writes an audit event.
        </p>
      </header>

      {unauthorized ? (
        <Notice tone="warn">
          Sign in with an admin wallet to view and manage capability grants.
        </Notice>
      ) : null}

      {!unauthorized && session && !viewGate.allowed ? (
        <Notice tone="warn">
          {viewGate.reason ?? "Your wallet does not have the admin:capabilities:read capability."}
        </Notice>
      ) : null}

      <IssueGrantPanel
        gate={grantGate}
        knownCapabilities={known}
        onIssued={() => mutate(GRANTS_PATH)}
      />

      <GrantList
        title="Active grants"
        emptyHint="No active grants. Use the form above to issue one."
        grants={active}
        revokeGate={revokeGate}
        onRevoke={() => mutate(GRANTS_PATH)}
        showRevoke
      />

      <GrantList
        title="Revoked grants"
        emptyHint="No revoked grants on file."
        grants={revoked}
        revokeGate={revokeGate}
        onRevoke={() => mutate(GRANTS_PATH)}
        showRevoke={false}
      />

      <p
        className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        Capability merging takes effect on the next request after the
        15-second middleware cache lapses. The audit log
        (<span className="text-[var(--avy-accent)]">/audit-log</span>)
        records every grant and revoke with the issuing admin wallet.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Issue panel                                                        */
/* ------------------------------------------------------------------ */

function IssueGrantPanel({
  gate,
  knownCapabilities,
  onIssued,
}: {
  gate: ReturnType<typeof canUseControl>;
  knownCapabilities: string[];
  onIssued: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [scope, setScope] = useState("");
  const [note, setNote] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subjectValid = /^0x[a-fA-F0-9]{40}$/u.test(subject.trim());
  const canSubmit = gate.allowed && subjectValid && selected.length > 0 && !submitting;

  function toggle(capability: string) {
    setSelected((prev) =>
      prev.includes(capability)
        ? prev.filter((entry) => entry !== capability)
        : [...prev, capability]
    );
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await createCapabilityGrant({
        subject: subject.trim().toLowerCase(),
        capabilities: selected,
        scope: scope.trim() || undefined,
        note: note.trim() || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      setSubject("");
      setScope("");
      setNote("");
      setExpiresAt("");
      setSelected([]);
      onIssued();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not issue grant.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-5 shadow-[var(--shadow-sm)]">
      <header className="flex items-baseline justify-between gap-3">
        <span
          className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Issue grant
        </span>
        {!gate.allowed ? (
          <span
            className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
            title={gate.reason ?? ""}
          >
            {gate.reason ?? "Insufficient capability to issue grants"}
          </span>
        ) : null}
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Subject wallet (0x…)">
          <input
            type="text"
            spellCheck={false}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="0x0000000000000000000000000000000000000000"
            disabled={!gate.allowed}
            className="h-9 w-full rounded-[8px] border border-[var(--line)] bg-[var(--paper-solid)] px-3 font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[color:rgba(30,102,66,0.45)] focus:outline focus:outline-2 focus:outline-[color:rgba(30,102,66,0.22)] disabled:opacity-50"
            style={{ letterSpacing: 0 }}
          />
        </Field>

        <Field label="Scope label (optional)">
          <input
            type="text"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="ops-bot"
            maxLength={60}
            disabled={!gate.allowed}
            className="h-9 w-full rounded-[8px] border border-[var(--line)] bg-[var(--paper-solid)] px-3 font-[family-name:var(--font-body)] text-[13px] text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[color:rgba(30,102,66,0.45)] focus:outline focus:outline-2 focus:outline-[color:rgba(30,102,66,0.22)] disabled:opacity-50"
          />
        </Field>

        <Field label="Note (optional)">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why is this delegation in place?"
            maxLength={500}
            disabled={!gate.allowed}
            className="h-9 w-full rounded-[8px] border border-[var(--line)] bg-[var(--paper-solid)] px-3 font-[family-name:var(--font-body)] text-[13px] text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[color:rgba(30,102,66,0.45)] focus:outline focus:outline-2 focus:outline-[color:rgba(30,102,66,0.22)] disabled:opacity-50"
          />
        </Field>

        <Field label="Expires (optional)">
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            disabled={!gate.allowed}
            className="h-9 w-full rounded-[8px] border border-[var(--line)] bg-[var(--paper-solid)] px-3 font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--ink)] focus:border-[color:rgba(30,102,66,0.45)] focus:outline focus:outline-2 focus:outline-[color:rgba(30,102,66,0.22)] disabled:opacity-50"
            style={{ letterSpacing: 0 }}
          />
        </Field>
      </div>

      <Field label={`Capabilities (${selected.length} selected)`}>
        <div className="flex max-h-[16rem] flex-col gap-1 overflow-y-auto rounded-[8px] border border-[var(--line)] bg-[var(--paper)] p-2">
          {knownCapabilities.length === 0 ? (
            <p className="m-0 p-2 text-[12px] text-[var(--muted)]">
              Sign in to load the capability matrix.
            </p>
          ) : (
            knownCapabilities.map((capability) => {
              const on = selected.includes(capability);
              return (
                <label
                  key={capability}
                  className={`flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 transition-colors ${
                    on ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--paper-solid)]"
                  } ${gate.allowed ? "" : "cursor-not-allowed opacity-60"}`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(capability)}
                    disabled={!gate.allowed}
                    className="h-4 w-4 accent-[var(--avy-accent)]"
                  />
                  <code className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--ink)]">
                    {capability}
                  </code>
                </label>
              );
            })
          )}
        </div>
      </Field>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      <footer className="flex items-center justify-between gap-3 border-t border-[var(--line-soft)] pt-3">
        <span
          className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--muted)]"
          style={{ letterSpacing: 0 }}
        >
          {subjectValid
            ? `Granting ${selected.length} capabilit${selected.length === 1 ? "y" : "ies"} to ${shortWallet(subject)}.`
            : "Enter a 0x-prefixed 40-character wallet to enable issue."}
        </span>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          title={gate.allowed ? "" : (gate.reason ?? "")}
          className="inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
          style={{ letterSpacing: "0.04em" }}
        >
          {submitting ? "Issuing…" : "Issue grant"}
        </button>
      </footer>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Grant list                                                         */
/* ------------------------------------------------------------------ */

function GrantList({
  title,
  emptyHint,
  grants,
  revokeGate,
  onRevoke,
  showRevoke,
}: {
  title: string;
  emptyHint: string;
  grants: CapabilityGrant[];
  revokeGate: ReturnType<typeof canUseControl>;
  onRevoke: () => void;
  showRevoke: boolean;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-5 shadow-[var(--shadow-sm)]">
      <header className="flex items-baseline justify-between gap-3">
        <span
          className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          {title}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--muted)]"
          style={{ letterSpacing: 0 }}
        >
          {grants.length}
        </span>
      </header>

      {grants.length === 0 ? (
        <p
          className="m-0 font-[family-name:var(--font-body)] text-[13px] text-[var(--muted)]"
          style={{ letterSpacing: 0 }}
        >
          {emptyHint}
        </p>
      ) : (
        <ul className="flex flex-col gap-2 p-0" style={{ listStyle: "none" }}>
          {grants.map((grant) => (
            <GrantRow
              key={grant.id}
              grant={grant}
              revokeGate={revokeGate}
              onRevoke={onRevoke}
              showRevoke={showRevoke}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function GrantRow({
  grant,
  revokeGate,
  onRevoke,
  showRevoke,
}: {
  grant: CapabilityGrant;
  revokeGate: ReturnType<typeof canUseControl>;
  onRevoke: () => void;
  showRevoke: boolean;
}) {
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (!revokeGate.allowed) return;
    if (!window.confirm(`Revoke ${grant.id}? This takes effect immediately.`)) return;
    setRevoking(true);
    setError(null);
    try {
      await revokeCapabilityGrant(grant.id);
      onRevoke();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke grant.");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-[8px] border border-[var(--line)] bg-[var(--paper)] p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <code className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--ink)]">
            {grant.id}
          </code>
          <span className="font-[family-name:var(--font-body)] text-[12.5px] text-[var(--muted)]">
            {grant.scope ? `${grant.scope} · ` : ""}
            <code className="font-[family-name:var(--font-mono)] text-[11.5px]">
              {shortWallet(grant.subject)}
            </code>
          </span>
        </div>
        <StatusPill status={grant.status} />
      </header>

      <ul className="flex flex-wrap gap-1.5 p-0" style={{ listStyle: "none" }}>
        {grant.capabilities.map((capability) => (
          <li
            key={capability}
            className="rounded-full border border-[var(--line)] bg-[var(--paper-solid)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--ink)]"
          >
            {capability}
          </li>
        ))}
      </ul>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-[max-content_1fr]">
        <Detail label="Issued by">
          <code className="font-[family-name:var(--font-mono)] text-[11.5px]">
            {shortWallet(grant.issuedBy)}
          </code>
        </Detail>
        <Detail label="Issued at">{formatIso(grant.issuedAt)}</Detail>
        {grant.expiresAt ? <Detail label="Expires">{formatIso(grant.expiresAt)}</Detail> : null}
        {grant.note ? <Detail label="Note">{grant.note}</Detail> : null}
        {grant.status === "revoked" ? (
          <>
            <Detail label="Revoked at">{formatIso(grant.revokedAt)}</Detail>
            {grant.revokedBy ? (
              <Detail label="Revoked by">
                <code className="font-[family-name:var(--font-mono)] text-[11.5px]">
                  {shortWallet(grant.revokedBy)}
                </code>
              </Detail>
            ) : null}
            {grant.revokeNote ? <Detail label="Revoke note">{grant.revokeNote}</Detail> : null}
          </>
        ) : null}
      </dl>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      {showRevoke ? (
        <footer className="flex items-center justify-end gap-3 border-t border-[var(--line-soft)] pt-2">
          <button
            type="button"
            onClick={revoke}
            disabled={!revokeGate.allowed || revoking}
            title={revokeGate.allowed ? "" : (revokeGate.reason ?? "")}
            className="inline-flex h-8 items-center rounded-[8px] border border-[var(--line)] bg-[var(--paper-solid)] px-3 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--ink)] transition-colors hover:border-[color:rgba(167,97,34,0.35)] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ letterSpacing: "0.04em" }}
          >
            {revoking ? "Revoking…" : "Revoke"}
          </button>
        </footer>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span
        className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt
        className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--muted)]"
        style={{ letterSpacing: "0.12em" }}
      >
        {label}
      </dt>
      <dd className="m-0 font-[family-name:var(--font-body)] text-[12.5px] text-[var(--ink)]">
        {children}
      </dd>
    </>
  );
}

function StatusPill({ status }: { status: CapabilityGrant["status"] }) {
  const tone = status === "active"
    ? { bg: "var(--accent-soft)", color: "var(--avy-accent)" }
    : { bg: "rgba(167,97,34,0.12)", color: "#9a5d1b" };
  return (
    <span
      className="rounded-full px-2 py-0.5 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase"
      style={{ background: tone.bg, color: tone.color, letterSpacing: "0.1em" }}
    >
      {status}
    </span>
  );
}

function Notice({ tone, children }: { tone: "warn"; children: React.ReactNode }) {
  return (
    <p
      className="m-0 rounded-[8px] border p-3 font-[family-name:var(--font-body)] text-[12.5px] leading-[1.55]"
      style={
        tone === "warn"
          ? {
              borderColor: "rgba(167,97,34,0.35)",
              background: "rgba(244,227,207,0.35)",
              color: "var(--avy-muted)",
            }
          : undefined
      }
    >
      {children}
    </p>
  );
}

function shortWallet(value: string | undefined): string {
  if (!value) return "—";
  const v = String(value).trim();
  if (v.length <= 12) return v;
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

function formatIso(value: string | undefined): string {
  if (!value) return "—";
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return value;
  return new Date(t).toLocaleString("en-CH", { dateStyle: "medium", timeStyle: "short" });
}

function extractGrants(data: unknown): CapabilityGrant[] {
  if (!data || typeof data !== "object") return [];
  const items = (data as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items.filter((entry): entry is CapabilityGrant => {
    if (!entry || typeof entry !== "object") return false;
    const r = entry as Record<string, unknown>;
    return typeof r.id === "string" && typeof r.subject === "string" && Array.isArray(r.capabilities);
  });
}

/**
 * Build the list of capabilities the operator can offer in the form.
 * Sourced from the live capabilityMatrix so it always matches the
 * backend, with capability-management capabilities filtered out
 * (the backend rejects them anyway, but the UI shouldn't tempt
 * admins to try). When no session has loaded yet the list is empty —
 * the form disables itself in that state.
 */
function listKnownCapabilities(session: AuthSession | undefined): string[] {
  if (!session) return [];
  const matrix = session.capabilityMatrix;
  const all = new Set<string>(matrix.base);
  for (const expansion of Object.values(matrix.roles)) {
    for (const capability of expansion) {
      all.add(capability);
    }
  }
  return [...all]
    .filter((capability) => !capability.startsWith("admin:capabilities:"))
    .sort();
}
