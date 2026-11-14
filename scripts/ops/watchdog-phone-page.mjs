import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function selectWatchdogPage({ issue, failing, now = Date.now(), since = now }) {
  if (!issue) return null;
  if (!failing) {
    if (issue.state !== "CLOSED" || Date.parse(issue.closedAt) < since) return null;
    return { number: issue.number, url: issue.url, priority: 3, recovery: true };
  }
  if (issue.state !== "OPEN") return null;
  const ageHours = Math.max(0, (now - Date.parse(issue.createdAt)) / 3_600_000);
  const page = ageHours >= 12 ? 3 + Math.floor(ageHours / 12) - 1
    : ageHours >= 4 ? 2 : ageHours >= 1 ? 1 : 0;
  const sent = (issue.comments ?? []).flatMap((comment) => {
    if (!["github-actions[bot]", "github-actions"].includes(comment.author?.login)) return [];
    return [...String(comment.body ?? "").matchAll(/<!-- page:(\d+) -->/g)]
      .map((match) => Number(match[1]));
  });
  if (sent.some((previous) => previous >= page)) return null;
  return { number: issue.number, url: issue.url, page, priority: page === 0 ? 5 : 4,
    recovery: false, marker: `<!-- page:${page} -->` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [issueFile, failing, since] = process.argv.slice(2);
  const issue = JSON.parse(readFileSync(issueFile, "utf8"));
  console.log(JSON.stringify(selectWatchdogPage({ issue, failing: failing === "yes",
    since: Date.parse(since) })));
}
