"use client";

import { useState, type FormEvent } from "react";
import { useSWRConfig } from "swr";
import { useAuth } from "@/lib/auth/use-auth";
import { swrFetcher } from "@/lib/api/client";
import { DrawerSection } from "@/components/shell/DetailDrawer";

export function HumanVerdictPanel({ sessionId }: { sessionId: string }) {
  const { roles } = useAuth();
  const { mutate } = useSWRConfig();
  const [verdict, setVerdict] = useState<"approve" | "reject">("approve");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  if (!roles.includes("admin")) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      await swrFetcher(["/admin/sessions/human-verdict", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, verdict, rationale }) }]);
      setDone(true);
      setMessage("Human verdict confirmed. Refreshing the session receipt.");
      await mutate((key) => typeof key === "string" && (key.startsWith("/admin/sessions") || key.startsWith("/session") || key.startsWith("/agents")));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Human verdict failed. Check the session before retrying.");
    } finally { setBusy(false); }
  }

  return <DrawerSection title="Human verdict">
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-[10px] border border-[var(--avy-line)] p-4">
      <p>This fallback needs an admin decision, not arbitration. The server checks that escrow is still Submitted. Approval pays through the normal verifier; rejection retains the worker’s seven-day dispute window.</p>
      <label htmlFor="human-verdict">Decision</label>
      <select id="human-verdict" value={verdict} disabled={busy || done} onChange={(event) => setVerdict(event.target.value as "approve" | "reject")}>
        <option value="approve">Approve and pay</option><option value="reject">Reject — worker may dispute</option>
      </select>
      <label htmlFor="human-rationale">Public rationale (at least 20 characters)</label>
      <textarea id="human-rationale" value={rationale} minLength={20} required disabled={busy || done}
        onChange={(event) => setRationale(event.target.value)} className="min-h-28 rounded border border-[var(--avy-line)] p-2" />
      <p>The rationale and deciding wallet will be public. Submitting sends a settlement transaction through the verifier.</p>
      <button type="submit" disabled={busy || done || rationale.trim().length < 20} className="rounded border border-[var(--avy-line)] p-2 disabled:opacity-50">
        {busy ? "Confirming verdict…" : verdict === "approve" ? "Approve and pay worker" : "Reject submission"}
      </button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  </DrawerSection>;
}
