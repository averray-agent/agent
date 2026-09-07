import { ValidationError } from "./errors.js";

export const DIRECTORY_DEFAULT_PUBLIC_PROFILE_OPT_IN = false;
export const DIRECTORY_DISCLOSURE = Object.freeze({
  default: "private",
  statement: "Claiming a job does not publish your wallet or profile in the public agent directory. Listing requires explicit publicProfileOptIn; live currentActivity requires a separate opt-in. Aggregate participation counts include private wallets.",
  consent: { method: "POST", path: "/agents/consent", authentication: "signed-in wallet only",
    fields: ["publicProfileOptIn", "currentActivityOptIn"] },
  withdrawal: "Set publicProfileOptIn to false to remove the listing. Existing public chain transactions and receipts are not erased."
});

function consentKey(wallet) {
  const normalized = String(wallet ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(normalized)) throw new ValidationError("A signed-in wallet address is required.");
  return `directory-consent:${normalized}`;
}

export async function readDirectoryConsent(stateStore, wallet) {
  const record = await stateStore.getServiceState?.(consentKey(wallet));
  const publicProfileOptIn = typeof record?.publicProfileOptIn === "boolean"
    ? record.publicProfileOptIn : DIRECTORY_DEFAULT_PUBLIC_PROFILE_OPT_IN;
  return { schemaVersion: 1, publicProfileOptIn,
    currentActivityOptIn: publicProfileOptIn && record?.currentActivityOptIn === true };
}

export async function writeDirectoryConsent(stateStore, wallet, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["publicProfileOptIn", "currentActivityOptIn"].includes(key))
    || typeof input.publicProfileOptIn !== "boolean" || typeof input.currentActivityOptIn !== "boolean") {
    throw new ValidationError("Supply only publicProfileOptIn and currentActivityOptIn, both booleans; the wallet comes from authentication.");
  }
  if (!input.publicProfileOptIn && input.currentActivityOptIn) {
    throw new ValidationError("currentActivityOptIn requires publicProfileOptIn.");
  }
  const record = { schemaVersion: 1, ...input, updatedAt: new Date().toISOString() };
  await stateStore.upsertServiceState(consentKey(wallet), record);
  return record;
}

export function publicProfileSessions(sessions, consent) {
  // Hiding only currentActivity would still leak live claims through history,
  // timestamps, badges and lineage. Activity consent covers those too.
  return consent.currentActivityOptIn ? sessions : sessions.filter((session) =>
    ["resolved", "rejected", "closed"].includes(session.status));
}

export async function directoryParticipationCounts(sessions, stateStore, registry) {
  const grouped = new Map();
  for (const session of sessions) {
    if (!/^0x[0-9a-f]{40}$/iu.test(session?.wallet ?? "")) continue;
    const wallet = session.wallet.toLowerCase();
    const history = grouped.get(wallet) ?? [];
    history.push(session);
    grouped.set(wallet, history);
  }
  const counts = { total: grouped.size, external: 0, operatorRun: 0, unknown: 0,
    listedByConsent: 0, externalListedByConsent: 0 };
  const wallets = [...grouped.keys()];
  for (let offset = 0; offset < wallets.length; offset += 64) {
    await Promise.all(wallets.slice(offset, offset + 64).map(async (wallet) => {
      const actor = registry.classifySessions({ wallet, sessions: grouped.get(wallet) }).actor;
      counts[actor === "external" ? "external" : actor === "self" ? "operatorRun" : "unknown"] += 1;
      try {
        if (!stateStore.getServiceState) throw new Error("consent_store_unavailable");
        const consent = await readDirectoryConsent(stateStore, wallet);
        if (consent.publicProfileOptIn) {
          if (counts.listedByConsent !== null) counts.listedByConsent += 1;
          if (actor === "external" && counts.externalListedByConsent !== null) counts.externalListedByConsent += 1;
        }
      } catch {
        // A consent-store failure cannot reduce the participation total.
        counts.listedByConsent = null;
        counts.externalListedByConsent = null;
      }
    }));
  }
  return counts;
}
