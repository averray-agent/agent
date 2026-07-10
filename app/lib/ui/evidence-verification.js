import {
  getAddress,
  isAddress,
  keccak256,
  stringToBytes,
  verifyMessage,
} from "viem";

export const RECEIPT_SIGNATURE_ENVELOPE_TYPE = "averray.receipt.signature.v1";
export const RECEIPT_MANIFEST_TYPE = "averray.receipts.manifest.v1";
export const AUDIT_MANIFEST_TYPE = "averray.audit.manifest.v1";
export const SESSION_MANIFEST_TYPE = "averray.sessions.manifest.v1";
export const MANIFEST_ENVELOPE_TYPE = "averray.manifest.v1";

export function canonicalJson(value) {
  return JSON.stringify(sortCanonical(value));
}

export function hashCanonicalJson(value) {
  return keccak256(stringToBytes(canonicalJson(value)));
}

export function parseEvidencePreview(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") {
    throw new Error("Evidence must be a JSON object or JSON string.");
  }

  const lines = value.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  while (lines.length > 0) {
    const trimmed = lines[0].trim();
    if (trimmed === "" || trimmed.startsWith("//")) {
      lines.shift();
      continue;
    }
    break;
  }

  try {
    return JSON.parse(lines.join("\n"));
  } catch (error) {
    throw new Error("Evidence preview is not valid JSON.", { cause: error });
  }
}

export function hashEvidencePreview(value) {
  return hashCanonicalJson(parseEvidencePreview(value));
}

export function buildEvidenceSignatureMessage({ receiptId, payloadHash }) {
  const normalizedHash = normalizeHex32(payloadHash, "payloadHash");
  const normalizedReceipt = text(receiptId, "unknown-receipt");
  return [
    "Averray receipt evidence",
    `receiptId: ${normalizedReceipt}`,
    `payloadHash: ${normalizedHash}`,
  ].join("\n");
}

export async function verifyEvidenceSignature({
  receiptId,
  evidenceJson,
  envelope,
}) {
  try {
    const parsedEnvelope = parseJsonInput(envelope, "Signature envelope");
    if (
      parsedEnvelope.type &&
      parsedEnvelope.type !== RECEIPT_SIGNATURE_ENVELOPE_TYPE
    ) {
      throw new Error(
        `Unsupported envelope type "${String(parsedEnvelope.type)}". Expected ${RECEIPT_SIGNATURE_ENVELOPE_TYPE}.`
      );
    }

    const signer = text(parsedEnvelope.signer, "");
    if (!isAddress(signer)) {
      throw new Error("Envelope signer must be an EVM address.");
    }

    const signature = text(parsedEnvelope.signature, "");
    if (!/^0x[0-9a-fA-F]+$/u.test(signature)) {
      throw new Error("Envelope signature must be a hex ECDSA signature.");
    }

    const payloadHash = hashEvidencePreview(evidenceJson);
    const declaredHash = normalizeHex32(parsedEnvelope.payloadHash, "payloadHash");
    if (declaredHash !== payloadHash) {
      throw new Error(
        `Evidence hash mismatch. Current evidence is ${payloadHash}, envelope declares ${declaredHash}.`
      );
    }

    const effectiveReceiptId = text(parsedEnvelope.receiptId, text(receiptId, "unknown-receipt"));
    if (receiptId && parsedEnvelope.receiptId && effectiveReceiptId !== receiptId) {
      throw new Error(
        `Receipt id mismatch. Current receipt is ${receiptId}, envelope declares ${effectiveReceiptId}.`
      );
    }

    const expectedMessage = buildEvidenceSignatureMessage({
      receiptId: effectiveReceiptId,
      payloadHash,
    });
    const declaredMessage = text(parsedEnvelope.message, "");
    if (declaredMessage && declaredMessage !== expectedMessage) {
      throw new Error("Envelope message does not match the canonical Averray receipt message.");
    }

    const ok = await verifyMessage({
      address: getAddress(signer),
      message: expectedMessage,
      signature,
    });

    if (!ok) {
      throw new Error("Signature recovery did not match the declared signer.");
    }

    return {
      ok: true,
      signer: getAddress(signer),
      payloadHash,
      receiptId: effectiveReceiptId,
      message: expectedMessage,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Signature verification failed.",
    };
  }
}

export function buildReceiptManifestPayload(rows) {
  return {
    type: RECEIPT_MANIFEST_TYPE,
    entries: (Array.isArray(rows) ? rows : []).map((row, index) => ({
      index,
      id: text(row?.id, ""),
      kind: text(row?.kind, ""),
      subject: text(row?.subject, ""),
      sessionId: text(row?.sessionId, ""),
      evidenceHash: text(row?.evidenceHash, ""),
      chainJobId: text(row?.chainJobId, ""),
      policy: text(row?.policy, ""),
      signedAt: text(row?.signedAt, ""),
      signers: (Array.isArray(row?.signers) ? row.signers : []).map((signer) => ({
        role: text(signer?.role, ""),
        address: text(signer?.address, ""),
      })),
    })),
  };
}

export function buildAuditManifestPayload(events) {
  return {
    type: AUDIT_MANIFEST_TYPE,
    entries: (Array.isArray(events) ? events : []).map((event, index) => ({
      index,
      id: text(event?.id, ""),
      at: text(event?.at, ""),
      day: text(event?.day, ""),
      source: text(event?.source, ""),
      category: text(event?.category, ""),
      action: text(event?.action, ""),
      actor: {
        handle: text(event?.actor?.handle, ""),
        address: text(event?.actor?.address, ""),
      },
      target: text(event?.target, ""),
      hash: text(event?.hash, ""),
      link: event?.link
        ? {
            label: text(event.link.label, ""),
            href: text(event.link.href, ""),
          }
        : undefined,
    })),
  };
}

export function buildSessionManifestPayload(rows) {
  return {
    type: SESSION_MANIFEST_TYPE,
    entries: (Array.isArray(rows) ? rows : []).map((row, index) => ({
      index,
      id: text(row?.id, ""),
      runRef: text(row?.runRef, ""),
      source: text(row?.source, ""),
      state: text(row?.state, ""),
      job: {
        title: text(row?.job?.title, ""),
        meta: text(row?.job?.meta, ""),
      },
      worker: {
        handle: text(row?.worker?.handle, ""),
        address: text(row?.worker?.address, ""),
      },
      escrow: {
        amount: text(row?.escrow?.amount, ""),
        asset: text(row?.escrow?.asset, ""),
      },
      verifierMode: text(row?.verifierMode, ""),
      openedAt: text(row?.openedAt, ""),
      policy: text(row?.policy, ""),
      receipt: text(row?.receipt, ""),
      lastEvent: {
        text: text(row?.lastEvent?.text, ""),
        meta: text(row?.lastEvent?.meta, ""),
      },
      timestamps: row?.timestamps
        ? {
            claimedAt: text(row.timestamps.claimedAt, ""),
            submittedAt: text(row.timestamps.submittedAt, ""),
            settledAt: text(row.timestamps.settledAt, ""),
            updatedAt: text(row.timestamps.updatedAt, ""),
          }
        : undefined,
    })),
  };
}

export function buildManifestEnvelope(payload) {
  return {
    type: MANIFEST_ENVELOPE_TYPE,
    manifestType: text(payload?.type, "unknown"),
    manifestHash: hashCanonicalJson(payload),
    entryCount: Array.isArray(payload?.entries) ? payload.entries.length : 0,
    payload,
  };
}

export function verifyManifestEnvelope(input) {
  try {
    const envelope = parseJsonInput(input, "Manifest");
    const payload = envelope.payload ?? envelope;
    const manifestHash = hashCanonicalJson(payload);
    const declaredHash = envelope.manifestHash
      ? normalizeHex32(envelope.manifestHash, "manifestHash")
      : manifestHash;

    if (declaredHash !== manifestHash) {
      throw new Error(
        `Manifest hash mismatch. Current payload is ${manifestHash}, envelope declares ${declaredHash}.`
      );
    }

    return {
      ok: true,
      manifestHash,
      manifestType: text(payload.type, text(envelope.manifestType, "unknown")),
      entryCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Manifest verification failed.",
    };
  }
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;

  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      const next = value[key];
      if (next !== undefined) acc[key] = sortCanonical(next);
      return acc;
    }, {});
}

function parseJsonInput(value, label) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be JSON.`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function normalizeHex32(value, label) {
  const raw = text(value, "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(raw)) {
    throw new Error(`${label} must be a 32-byte hex value.`);
  }
  return raw;
}

function text(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value : fallback;
}
