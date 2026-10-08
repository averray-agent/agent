import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as work from "../work/human-work.js";
import * as readiness from "../work/claim-readiness.js";
import { flattenMarkdownLead } from "./markdown-lead.js";

const root = new URL("../../", import.meta.url);
const require = createRequire(new URL("../../package.json", import.meta.url));
const read = (path) => readFileSync(new URL(path, root), "utf8");
function load(path, modules = {}) {
  const exports = {};
  const code = ts.transpileModule(read(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022
  } }).outputText;
  vm.runInNewContext(code, { exports, require: (name) => modules[name] ?? require(name), console });
  return exports;
}
const { IssueMarkdown } = load("components/runs/IssueMarkdown.tsx", {
  "react-markdown": { default: ReactMarkdown }, "remark-gfm": { default: remarkGfm },
  "@/lib/utils/cn": { cn: (...parts) => parts.filter(Boolean).join(" ") },
  "@/lib/ui/markdown-lead.js": { flattenMarkdownLead }
});
const description = "### Problem\n\n**Preserve** the issue terms.\n\n- [ ] Add tests\n\n| Path | Result |\n| --- | --- |\n| first | passing |\n\n<script>unsafe()</script>";
const job = { id: "pr-techgendm-openfield-2", title: "Fixture: preserve terms", description, verifierMode: "github_pr",
  agentInstructions: ["**Read** the issue"], acceptanceCriteria: ["- [x] Tests pass"], claimable: true };
const box = ({ children }) => React.createElement("div", null, children);

function detail(authenticated) {
  const hooks = { useHumanWorkJobs: () => ({ data: { jobs: [job] } }), useJobDefinition: () => ({ data: job }),
    ...Object.fromEntries(["useJobPreflight", "useJobEligibility", "useJobNetReward", "useBoundedApi"].map((key) => [key, () => ({ data: {} })])) };
  return load("components/work/WorkJobDetail.tsx", {
    "@/components/runs/IssueMarkdown": { IssueMarkdown },
    "lucide-react": Object.fromEntries(["ArrowLeft", "Check", "CheckCircle2", "Copy", "ExternalLink"].map((key) => [key, () => null])),
    "@/components/ui/button": { Button: box }, "@/components/ui/card": { Card: box, CardContent: box },
    "@/components/ui/skeleton": { Skeleton: box }, "@/components/ui/toast": { toast: {} },
    "@/lib/api/hooks": hooks, "@/lib/api/client": {}, "@/lib/api/claim-job": {},
    "@/lib/auth/use-auth": { useAuth: () => ({ authenticated }) },
    "@/lib/auth/use-wallet-provider": { useWalletProvider: () => "available" },
    "@/lib/work/claim-readiness.js": readiness, "@/lib/ui/app-performance.js": {},
    "@/components/auth/WalletSignInFlow": { WalletSignInFlow: () => null },
    "@/lib/work/human-work.js": work, "./ClaimHonestyPanel": { ClaimHonestyPanel: () => null },
    "./SchemaPreview": { SchemaPreview: () => null }, "./types": load("components/work/types.ts")
  }).WorkJobDetail;
}

test("job lead is rendered then flattened in static HTML, signed-out and signed-in detail paths", () => {
  for (const authenticated of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(detail(authenticated), { jobId: job.id }));
    const lead = html.match(/<div[^>]*data-job-lead="true"[^>]*>([\s\S]*?)<\/div>/u)?.[1];
    assert.ok(lead, "actual WorkJobDetail uses the shared lead renderer");
    assert.match(lead, /Problem Preserve the issue terms\. Add tests/u);
    assert.doesNotMatch(lead, /###|\*\*|- \[ \]|<h\d|<strong|<table|unsafe/u);
    assert.match(html, /aria-label="Full task description"/u);
    assert.match(html, /<strong[^>]*>Preserve<\/strong>/u);
    assert.match(html, /<table/u);
    assert.match(html, /type="checkbox"/u);
    assert.doesNotMatch(html, /<script|unsafe\(\)/u);
  }
});

test("client-navigation summaries reuse the same GFM lead and keep full terms separate", () => {
  const first = renderToStaticMarkup(React.createElement(IssueMarkdown, { lead: true }, description));
  const next = renderToStaticMarkup(React.createElement(IssueMarkdown, { lead: true }, "## Next\n\n~~old~~ **new**"));
  assert.doesNotMatch(first + next, /###|\*\*|~~|- \[ \]/u);
  assert.match(next, /Next old new/u);
  assert.match(read("components/work/WorkJobList.tsx"), /<IssueMarkdown lead[^>]*>[\s\S]*?job.successCriteria \|\| job.summary/u);
  assert.match(read("components/work/WorkJobDetail.tsx"), /<IssueMarkdown>\{item\}<\/IssueMarkdown>/u);
});

test("claimed session JobNotes renders instruction and success-criteria GFM without raw HTML", () => {
  const { WorkSessionWorkspace } = load("components/work/WorkSessionWorkspace.tsx", {
    "@/components/runs/IssueMarkdown": { IssueMarkdown },
    "lucide-react": { ArrowLeft: () => null, Clock3: () => null },
    "@/components/ui/badge": { Badge: box },
    "@/components/ui/card": { Card: box, CardContent: box },
    "@/components/ui/skeleton": { Skeleton: box },
    "@/lib/api/hooks": {
      useSession: () => ({ data: { sessionId: "claimed", jobId: job.id, status: "claimed" } }),
      useJobDefinition: () => ({ data: { ...job, agentInstructions: [description] } }),
      useBoundedApi: () => ({ data: {} })
    },
    "@/lib/api/client": {}, "@/lib/auth/use-auth": { useAuth: () => ({ authenticated: true }) },
    "@/components/auth/WalletSignInFlow": { WalletSignInFlow: () => null },
    "@/lib/work/human-work.js": work,
    "./SchemaGuidedEditor": { SchemaGuidedEditor: () => null },
    "./VerificationWatchPanel": { VerificationWatchPanel: () => null },
    "./types": load("components/work/types.ts")
  });
  const html = renderToStaticMarkup(React.createElement(WorkSessionWorkspace, { sessionId: "claimed" }));
  assert.match(html, /<strong[^>]*>Preserve<\/strong>/u);
  assert.match(html, /<table/u);
  assert.match(html, /type="checkbox"[^>]*checked/u);
  assert.doesNotMatch(html, /\*\*Preserve\*\*|- \[x\]|<script|unsafe\(\)/u);
});

test("built static export and pretty-job route use the shared detail shell without raw Markdown", {
  skip: process.env.ASSERT_APP_EXPORT !== "1" ? "run after build:frontend with ASSERT_APP_EXPORT=1" : false
}, () => {
  const html = read("out/work/job/index.html");
  assert.match(html, /<!DOCTYPE html>/iu);
  assert.doesNotMatch(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ""), /### Problem|\*\*Preserve\*\*|- \[ \]/u);
  const caddy = readFileSync(new URL("../../../deploy/Caddyfile.averray", import.meta.url), "utf8");
  assert.match(caddy, /work\/job/u);
  assert.match(read("app/(worker)/work/job/page.tsx"), /<WorkJobDetail jobId=\{jobId\}/u);
});
