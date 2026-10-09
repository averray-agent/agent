/** Display-only distinction between the job's reward and an upstream promise. */
export function bountyDisclosure(title, amount, asset, verifierMode) {
  if (verifierMode !== "github_pr") return null;
  if (typeof title !== "string" || !/(?:\[[^\]\r\n]*\bbounty\b[^\]\r\n]*\]|\bbounty\s*:)/iu.test(title)) return null;
  if (!["number", "string"].includes(typeof amount) || String(amount).trim() === ""
    || !Number.isFinite(Number(amount)) || Number(amount) < 0 || typeof asset !== "string" || !asset.trim()) {
    return "Averray reward unavailable; any upstream bounty is the maintainer's.";
  }
  return `Averray pays ${String(amount).trim()} ${asset.trim()} on merge; any upstream bounty is the maintainer's.`;
}
