import { execFileSync } from "node:child_process";

export const LEGAL_PAGE_PATHS = ["marketing/src/pages/terms.astro", "marketing/src/pages/privacy.astro"];

// First-parent history selects the merge/squash commit that published the text,
// not the author's earlier commit. Later unrelated deployments keep that date.
export function legalRevisionDate({ root = process.cwd(), env = process.env } = {}) {
  if (env.VERIFY_LEGAL_REVISION_DATE) {
    const date = env.VERIFY_LEGAL_REVISION_DATE;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw new Error("Invalid VERIFY_LEGAL_REVISION_DATE");
    }
    return date;
  }
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  if (git("rev-parse", "--is-shallow-repository") === "true") {
    throw new Error("Legal page dates require full Git history or VERIFY_LEGAL_REVISION_DATE from the deployment checkout");
  }
  const timestamp = git("log", "--first-parent", "-1", "--format=%cI", "--", ...LEGAL_PAGE_PATHS.map((path) => `:(top)${path}`));
  if (!timestamp) throw new Error("Legal page revision is missing from Git history");
  return new Date(timestamp).toISOString().slice(0, 10);
}
