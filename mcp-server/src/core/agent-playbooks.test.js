import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MCP_TOOLS } from "../protocols/mcp/tools.js";
import { AGENT_PLAYBOOK_URLS, buildDiscoveryManifest } from "./discovery-manifest.js";

const REPO_ROOT = new URL("../../../", import.meta.url);
const PLAYBOOKS = Object.freeze([
  {
    id: "worker",
    path: "skills/averray-worker/SKILL.md",
    url: AGENT_PLAYBOOK_URLS.worker
  },
  {
    id: "poster",
    path: "skills/averray-poster/SKILL.md",
    url: AGENT_PLAYBOOK_URLS.poster
  }
]);

test("every agent playbook tool resolves against the served MCP manifest, including mutation failure", async () => {
  const contents = await readPlaybooks();
  const servedToolNames = new Set(MCP_TOOLS.map(({ name }) => name));

  assertPlaybookToolsResolve(contents, servedToolNames);

  const mutated = new Map(contents);
  const worker = mutated.get("worker");
  const renamed = worker.replace("`listJobs`", "`listJabs`");
  assert.notEqual(renamed, worker, "mutation drill must rename an existing tool reference");
  mutated.set("worker", renamed);

  assert.throws(
    () => assertPlaybookToolsResolve(mutated, servedToolNames),
    /worker playbook names missing MCP tool listJabs/u
  );
});

test("agent playbooks contain no price literal", async () => {
  const contents = await readPlaybooks();
  const priceLiterals = [
    /\$\s*\d/iu,
    /\b\d+(?:\.\d+)?\s*(?:USDC|DOT)\b/iu,
    /\b(?:USDC|DOT)\s*[:=]?\s*\d+(?:\.\d+)?\b/iu
  ];

  for (const [id, content] of contents) {
    for (const pattern of priceLiterals) {
      assert.doesNotMatch(content, pattern, `${id} playbook must read prices from live discovery`);
    }
  }
});

test("agent playbooks never pair x402 with Hub USDC or asset 1337", async () => {
  const contents = await readPlaybooks();
  const hubMoney = /\bHub\s+USDC\b|\basset\s+`?1337`?|\beip155:420420419\b/iu;

  for (const [id, content] of contents) {
    assert.match(content, /\beip155:420420419\b/u, `${id} playbook must identify the jobs chain`);
    assert.match(content, /\basset\s+`1337`/u, `${id} playbook must identify the jobs asset`);
    assert.match(content, /\beip155:8453\b/u, `${id} playbook must identify the Verify chain`);
    assert.match(content, /\bx402\b/iu, `${id} playbook must explain the live Verify discovery boundary`);

    const statements = content.split(/(?:[.!?](?:\s+|$)|\n)/u).filter(Boolean);
    for (const statement of statements) {
      if (/\bx402\b/iu.test(statement)) {
        assert.doesNotMatch(
          statement,
          hubMoney,
          `${id} playbook must never associate x402 with Hub job money`
        );
      }
    }
  }
});

test("both agent playbooks are reachable from llms.txt, builders, and discovery", async () => {
  const [llms, builders] = await Promise.all([
    readFile(new URL("site/llms.txt", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/src/pages/builders.astro", REPO_ROOT), "utf8")
  ]);
  const manifest = buildDiscoveryManifest();

  for (const playbook of PLAYBOOKS) {
    await assert.doesNotReject(readFile(new URL(playbook.path, REPO_ROOT), "utf8"));
    assert.match(llms, new RegExp(escapeRegExp(playbook.url), "u"), `${playbook.id} playbook missing from llms.txt`);
    assert.match(builders, new RegExp(escapeRegExp(playbook.url), "u"), `${playbook.id} playbook missing from builders`);
    assert.equal(
      manifest.docs[`${playbook.id}Playbook`],
      playbook.url,
      `${playbook.id} playbook missing from discovery docs`
    );
  }
});

async function readPlaybooks() {
  return new Map(await Promise.all(PLAYBOOKS.map(async ({ id, path }) => [
    id,
    await readFile(new URL(path, REPO_ROOT), "utf8")
  ])));
}

function assertPlaybookToolsResolve(contents, servedToolNames) {
  for (const [id, content] of contents) {
    const references = [...content.matchAll(/`([a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)`/gu)]
      .map((match) => match[1]);
    assert.ok(references.length > 0, `${id} playbook must name its MCP tools`);
    for (const name of references) {
      assert.ok(servedToolNames.has(name), `${id} playbook names missing MCP tool ${name}`);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
