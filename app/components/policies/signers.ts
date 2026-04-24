import type { Signer, SignerKey } from "./types";

export const SIGNERS: Record<SignerKey, Signer> = {
  fd2e: { role: "Operator · primary", addr: "0xFd2EAE2043…Fd6519", initials: "FD", hue: 150 },
  "9a13": { role: "Operator · co-sign", addr: "0x9A13F7B0c4…9f0cb2", initials: "9A", hue: 200 },
  b70c: { role: "Treasury lead", addr: "0xB70cA9e281…4c7a03", initials: "B7", hue: 30 },
  "3e42": { role: "Verifier handler", addr: "0x3E42d10fAa…08d1e7", initials: "3E", hue: 260 },
  c8f1: { role: "Governance council", addr: "0xC8F1b60e12…ae5144", initials: "C8", hue: 340 },
  "5d09": { role: "Compliance observer", addr: "0x5D09a221e7…22ff90", initials: "5D", hue: 90 },
};
