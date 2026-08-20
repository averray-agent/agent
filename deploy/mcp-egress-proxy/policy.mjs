import net from "node:net";

export function normalizeConnectAuthority(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.includes("/") || raw.includes("@")) throw new Error("invalid_authority");
  const parsed = new URL(`https://${raw}`);
  if (!parsed.hostname || parsed.username || parsed.password) throw new Error("invalid_authority");
  const port = Number(parsed.port || 443);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_authority");
  return { authority: `${parsed.hostname.toLowerCase()}:${port}`, hostname: parsed.hostname, port };
}

export function publicTargetAllowed(address, { allowPrivateFixtures = false } = {}) {
  if (allowPrivateFixtures) return net.isIP(address) !== 0;
  if (net.isIPv4(address)) return isPublicIpv4(address);
  if (net.isIPv6(address)) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address) {
  const [a, b] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function isPublicIpv6(address) {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return false;
  if (lower.startsWith("fc") || lower.startsWith("fd") || /^fe[89ab]/u.test(lower)) return false;
  if (lower.startsWith("ff")) return false;
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    return net.isIPv4(mapped) && isPublicIpv4(mapped);
  }
  return true;
}

export function extractBearer(header) {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(String(header ?? ""));
  if (!match) throw new Error("missing_grant");
  return match[1];
}
