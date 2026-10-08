import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROFILE_BLOCKCHAIN_SIGNER, PROFILE_JWT_SIGNER, PROFILE_BADGE_RECEIPT_SIGNER } from "./aws-credentials.js";

const profiles = [PROFILE_BLOCKCHAIN_SIGNER, PROFILE_JWT_SIGNER, PROFILE_BADGE_RECEIPT_SIGNER];

// Read only certificate paths from the SDK config; never execute credential_process
// or read private keys. Cache file reads, but evaluate expiry against every request.
export function createCredentialsHealthProvider({ gateway, badgeReceiptSigner, env = process.env,
  now = () => new Date(), read = readFile, ttlMs = 60_000 } = {}) {
  let certificates, expires = 0, pending;
  async function readCertificates() {
    const config = await read(env.AWS_CONFIG_FILE || join(homedir(), ".aws/config"), "utf8");
    return Promise.all(profiles.map(async (profile) => {
      const section = config.split(/^\[profile /mu).find((entry) => entry.startsWith(profile + "]"));
      const command = section?.split(/^\[/mu)[0]?.match(/^credential_process\s*=\s*(.+)$/mu)?.[1];
      const path = command?.match(/(?:^|\s)--certificate\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u);
      if (!path) throw new Error("certificate_unconfigured");
      const cert = new X509Certificate(await read(path[1] ?? path[2] ?? path[3]));
      return { from: Date.parse(cert.validFrom), until: Date.parse(cert.validTo) };
    }));
  }
  return async () => {
    if (!certificates || +now() >= expires) {
      if (!pending) pending = readCertificates().catch(() => []).then((value) => {
        certificates = value; expires = +now() + ttlMs;
      }).finally(() => { pending = undefined; });
      await pending;
    }
    const complete = certificates.length === profiles.length;
    const notAfter = complete ? new Date(Math.min(...certificates.map((cert) => cert.until))).toISOString() : null;
    return {
      rolesAnywhere: { notAfter, ok: complete && certificates.every((cert) => cert.from <= +now() && +now() < cert.until) },
      badgeReceiptSigner: badgeReceiptSigner?.getHealth?.() ?? { kid: null, ok: false },
      kms: gateway?.signer?.getHealth?.() ?? { ok: false, lastSignAt: null }
    };
  };
}
