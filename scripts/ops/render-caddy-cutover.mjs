#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

export const UPSTREAMS = {
  testnet: { backend: "backend:8787", indexer: "indexer:42069" },
  mainnet: { backend: "mainnet-backend:8787", indexer: "mainnet-indexer:42069" },
};

function hasUpstream(source, upstream) {
  const escaped = upstream.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|\\{|$)`, "mu").test(source);
}

export function routeState(source) {
  const hasTestnet = hasUpstream(source, UPSTREAMS.testnet.backend) || hasUpstream(source, UPSTREAMS.testnet.indexer);
  const hasMainnet = hasUpstream(source, UPSTREAMS.mainnet.backend) || hasUpstream(source, UPSTREAMS.mainnet.indexer);
  if (hasTestnet && hasMainnet) return "mixed";
  if (hasMainnet) return "mainnet";
  if (hasTestnet) return "testnet";
  return "unknown";
}

export function renderCutover(source, target) {
  if (!(target in UPSTREAMS)) throw new Error(`target must be testnet or mainnet (received ${target})`);
  const current = routeState(source);
  if (current === "mixed" || current === "unknown") {
    throw new Error(`refusing to transform Caddyfile in ${current} route state`);
  }
  const from = UPSTREAMS[current];
  if (!hasUpstream(source, from.backend) || !hasUpstream(source, from.indexer)) {
    throw new Error(`refusing to transform incomplete ${current} routes (backend and indexer are both required)`);
  }
  if (current === target) return source;
  const to = UPSTREAMS[target];
  const rendered = source.replaceAll(from.backend, to.backend).replaceAll(from.indexer, to.indexer);
  if (routeState(rendered) !== target) throw new Error(`failed to render a pure ${target} route state`);
  return rendered;
}

function main() {
  const [input, output, target] = process.argv.slice(2);
  if (!input || !output || !target) {
    console.error("Usage: render-caddy-cutover.mjs <input> <output> <testnet|mainnet>");
    process.exit(2);
  }
  const source = readFileSync(input, "utf8");
  const current = routeState(source);
  const rendered = renderCutover(source, target);
  writeFileSync(output, rendered, { mode: 0o600 });
  console.log(JSON.stringify({ current, target, changed: source !== rendered }));
}

if (process.argv[1]?.endsWith("render-caddy-cutover.mjs")) main();
