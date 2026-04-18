#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);

let apiUrl = process.env.API_URL ?? "";
let token = process.env.ADMIN_JWT ?? process.env.TOKEN ?? "";
let filePath = "docs/ready-to-post-jobs.json";
let onlyIds = [];
let dryRun = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--api") {
    apiUrl = args[index + 1] ?? "";
    index += 1;
    continue;
  }
  if (arg === "--token") {
    token = args[index + 1] ?? "";
    index += 1;
    continue;
  }
  if (arg === "--file") {
    filePath = args[index + 1] ?? filePath;
    index += 1;
    continue;
  }
  if (arg === "--only") {
    onlyIds = String(args[index + 1] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    index += 1;
    continue;
  }
  if (arg === "--dry-run") {
    dryRun = true;
    continue;
  }
  if (arg === "-h" || arg === "--help") {
    printHelp();
    process.exit(0);
  }
  fail(`unknown flag: ${arg}`);
}

if (!apiUrl) {
  fail("missing API URL. Pass --api https://api.averray.com or set API_URL.");
}
if (!token) {
  fail("missing admin token. Pass --token <jwt> or set ADMIN_JWT.");
}

const absoluteFilePath = resolve(process.cwd(), filePath);
const payloads = JSON.parse(await readFile(absoluteFilePath, "utf8"));
if (!Array.isArray(payloads)) {
  fail(`expected ${absoluteFilePath} to contain a JSON array`);
}

const selectedPayloads = onlyIds.length
  ? payloads.filter((payload) => onlyIds.includes(String(payload?.id ?? "").trim()))
  : payloads;

if (!selectedPayloads.length) {
  fail("no jobs selected from the bundle");
}

const existingJobs = await readJson(`${trimTrailingSlash(apiUrl)}/jobs`);
const existingIds = new Set(
  Array.isArray(existingJobs)
    ? existingJobs.map((job) => String(job?.id ?? "").trim()).filter(Boolean)
    : []
);

const alreadyPresent = [];
const toCreate = [];
for (const payload of selectedPayloads) {
  const id = String(payload?.id ?? "").trim();
  if (!id) {
    fail("bundle contains a job with no id");
  }
  if (existingIds.has(id)) {
    alreadyPresent.push(id);
    continue;
  }
  toCreate.push(payload);
}

console.log(`Bundle: ${absoluteFilePath}`);
console.log(`Selected: ${selectedPayloads.length}`);
console.log(`Already present: ${alreadyPresent.length}`);
console.log(`To create: ${toCreate.length}`);

if (alreadyPresent.length) {
  console.log(`Skipping existing jobs: ${alreadyPresent.join(", ")}`);
}

if (dryRun) {
  if (toCreate.length) {
    console.log(`Dry run only. Would create: ${toCreate.map((payload) => payload.id).join(", ")}`);
  }
  process.exit(0);
}

for (const payload of toCreate) {
  const created = await postJson(`${trimTrailingSlash(apiUrl)}/admin/jobs`, payload, token);
  console.log(`Created ${created.id}`);
}

console.log("Done.");

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

async function readJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });
  if (!response.ok) {
    fail(`GET ${url} failed: ${response.status} ${response.statusText}\n${await response.text()}`);
  }
  return response.json();
}

async function postJson(url, body, bearerToken) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    fail(`POST ${url} failed: ${response.status} ${response.statusText}\n${await response.text()}`);
  }
  return response.json();
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Post a job bundle to the admin API.

Usage:
  node scripts/post_job_bundle.mjs --api https://api.averray.com --token <admin-jwt>

Optional flags:
  --file <path>      JSON bundle to post (default: docs/ready-to-post-jobs.json)
  --only <ids>       Comma-separated job ids to post
  --dry-run          Show what would be created without posting

Environment:
  API_URL            Base API URL
  ADMIN_JWT          Admin-scoped JWT
`);
}
