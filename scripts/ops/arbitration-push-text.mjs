export const SIGN_ALL_LIVE = false;
const shortId = (id) => `${id.slice(0, 6)}…${id.slice(-4)}`;
const time = (seconds) => {
  const date = new Date(seconds * 1000);
  return `${date.toISOString()} (${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich",
    dateStyle: "medium", timeStyle: "short" }).format(date)} Europe/Zurich)`;
};

export function arbitrationPushText({ jobs, now, unknown = false, digest = false, parityWarnings = [], drill = false, runUrl = "" }) {
  const lines = [`On your Mac: ${drill ? "[DRILL] " : ""}${unknown ? "Deadline status unknown: chain read failed." : digest
    ? `Daily arbitration check: ${jobs.length} open ruling${jobs.length === 1 ? "" : "s"} from chain.`
    : `${jobs.length} arbitration ruling${jobs.length === 1 ? "" : "s"} need attention (from chain).`}`];
  for (const job of jobs) {
    const deadline = job.disputedAt + job.sla;
    const hours = Math.ceil((deadline - now) / 3600);
    lines.push(`Job ${shortId(job.jobId)}: target ${time(job.disputedAt + 3 * 86400)}; hard deadline ${time(deadline)}; ${Math.max(0, hours)} hours remaining.`);
    if (now >= job.disputedAt + 3 * 86400) lines.push("The three-day ruling target has passed.");
    if (hours <= 0) lines.push(`Deadline passed ${time(deadline)}. A full ruling is still possible while the escrow stays Disputed; from now anyone can close it at half pay.`);
  }
  for (const warning of parityWarnings) lines.push(`Chain ${warning.kind === "log_parity" ? "log" : "state"} parity warning: job ${shortId(warning.jobId)} differs between providers.`);
  if (jobs.length) {
    lines.push(SIGN_ALL_LIVE ? "app.averray.com/disputes → Rulings to sign → Sign all"
      : "Open app.averray.com/disputes, select the dispute and rule it in the drawer (Prepare, then Sign).");
    lines.push("You approve each ruling on the arbitrator phone. Nothing is paid until you approve and the chain confirms.");
  }
  if (runUrl) lines.push(runUrl);
  lines.push("A push is a pointer; check the app.");
  return lines.join("\n");
}
