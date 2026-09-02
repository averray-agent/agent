#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (!options.chain) fail("missing --chain <hub|bifrost>.");
  if (!options.eventsJson) fail("missing --events-json <path>.");
  if (!options.requestId) fail("missing --request-id <0x...>.");

  const chain = normalizeChain(options.chain);
  const requestId = assertHex32(options.requestId, "requestId");
  const inputPath = path.resolve(options.eventsJson);
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const extraction = extractEventEvidence({
    input,
    chain,
    requestId,
    overrides: options
  });

  if (options.output) {
    const outputPath = path.resolve(options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(extraction, null, 2)}\n`, "utf8");
    console.log(`Saved ${chain} native XCM evidence input to ${outputPath}`);
  } else {
    console.log(JSON.stringify(extraction, null, 2));
  }
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

export function extractEventEvidence({ input, chain, requestId, overrides = {} }) {
  const normalizedChain = normalizeChain(chain);
  const normalizedRequestId = assertHex32(requestId, "requestId");
  const allowMissingTopic = Boolean(overrides.allowMissingTopic);
  const root = normalizeRoot(input);
  const events = collectEventCandidates(root);
  const matched = findMatchingEvent(events, normalizedRequestId);

  if (!matched && !allowMissingTopic) {
    fail(`No decoded event in ${overrides.eventsJson ?? "input"} contains requestId ${normalizedRequestId}.`);
  }

  const source = matched?.event ?? root;
  const blockNumber = pickString(
    overrides.blockNumber,
    pickDeep(source, BLOCK_NUMBER_KEYS),
    pickDeep(root, BLOCK_NUMBER_KEYS)
  );
  const blockHash = pickString(
    overrides.blockHash,
    pickDeep(source, BLOCK_HASH_KEYS),
    pickDeep(root, BLOCK_HASH_KEYS)
  );
  const eventIndex = pickString(
    overrides.eventIndex,
    pickDeep(source, EVENT_INDEX_KEYS),
    matched ? `${blockNumber || "block"}-${matched.index}` : ""
  );

  if (!blockNumber) fail("blockNumber is required; pass --block-number or include it in the decoded event JSON.");
  if (!blockHash) fail("blockHash is required; pass --block-hash or include it in the decoded event JSON.");
  if (!eventIndex) fail("eventIndex is required; pass --event-index or include it in the decoded event JSON.");

  const messageTopic = pickTopic(source);
  if (!messageTopic && !allowMissingTopic) {
    fail(
      "messageTopic is required unless --allow-missing-topic is set. " +
      "The extractor will not infer SetTopic proof from requestId text outside an explicit topic/message-id field."
    );
  }

  if (normalizedChain === "hub") {
    return stripUndefined({
      chain: "polkadot-hub",
      blockNumber: String(blockNumber),
      blockHash: assertHex32(blockHash, "blockHash"),
      extrinsicHash: normalizeOptionalHex32(pickString(
        overrides.extrinsicHash,
        pickDeep(source, EXTRINSIC_HASH_KEYS),
        pickDeep(root, EXTRINSIC_HASH_KEYS)
      ), "extrinsicHash"),
      messageHash: normalizeOptionalHex32(pickString(
        overrides.messageHash,
        pickDeep(source, MESSAGE_HASH_KEYS),
        pickDeep(root, MESSAGE_HASH_KEYS)
      ), "messageHash"),
      messageTopic: messageTopic ? assertHex32(messageTopic, "messageTopic") : undefined,
      eventIndex: String(eventIndex)
    });
  }

  const assetLocation = parseJsonOption(overrides.assetLocationJson)
    ?? pickDeep(source, ASSET_LOCATION_KEYS)
    ?? pickDeep(root, ASSET_LOCATION_KEYS)
    ?? null;

  return stripUndefined({
    chain: "bifrost-polkadot",
    blockNumber: String(blockNumber),
    blockHash: assertHex32(blockHash, "blockHash"),
    eventIndex: String(eventIndex),
    messageTopic: messageTopic ? assertHex32(messageTopic, "messageTopic") : undefined,
    assetLocation,
    amount: pickString(
      overrides.amount,
      pickDeep(source, AMOUNT_KEYS),
      pickDeep(root, AMOUNT_KEYS),
      "0"
    )
  });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--allow-missing-topic") {
      parsed.allowMissingTopic = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/gu, (_, char) => char.toUpperCase());
      parsed[key] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/extract-native-xcm-event.mjs [options]

Normalizes decoded PAPI, Chopsticks, Polkadot.js, or block-explorer event JSON
into the raw hub.json / bifrost.json files consumed by
capture-native-xcm-evidence.mjs.

Required:
  --chain <hub|bifrost>       Which evidence input to emit.
  --events-json <path>        Decoded event/block JSON from PAPI or replay.
  --request-id <0x...>        Averray request id / expected SetTopic value.

Common options:
  --block-number <n>          Override block number.
  --block-hash <0x...>        Override block hash.
  --event-index <n-m>         Override event index.
  --extrinsic-hash <0x...>    Hub extrinsic hash override.
  --message-hash <0x...>      Hub message hash override.
  --amount <integer>          Bifrost amount override.
  --asset-location-json <json>
                              Bifrost asset location override.
  --allow-missing-topic       Allow emitting evidence without a Bifrost topic
                              for remote_ref fallback investigation.
  --output <path>             Write JSON to path. Prints to stdout if omitted.
  --help
`);
}

function normalizeRoot(input) {
  if (input && typeof input === "object") return input;
  fail("events JSON must decode to an object or array.");
}

function collectEventCandidates(root) {
  const candidates = [];
  const seen = new WeakSet();

  function visit(value, keyHint = "", indexHint = undefined) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, keyHint, index));
      return;
    }

    if (looksLikeEvent(value) || keyHint.toLowerCase().includes("event")) {
      candidates.push({ event: value, index: indexHint ?? candidates.length });
    }

    for (const [key, child] of Object.entries(value)) {
      visit(child, key, Array.isArray(child) ? undefined : indexHint);
    }
  }

  visit(root);
  return candidates.length ? candidates : [{ event: root, index: 0 }];
}

function looksLikeEvent(value) {
  return Boolean(
    value.event ||
    value.phase ||
    value.section ||
    value.method ||
    value.pallet ||
    value.eventIndex ||
    value.event_index ||
    value.messageTopic ||
    value.topic ||
    value.setTopic
  );
}

function findMatchingEvent(events, requestId) {
  const normalizedRequestId = String(requestId).toLowerCase();
  return events.find(({ event }) => {
    const topic = pickTopic(event);
    return topic && String(topic).toLowerCase() === normalizedRequestId;
  }) ?? events.find(({ event }) => containsString(event, requestId));
}

function containsString(value, needle) {
  const normalizedNeedle = String(needle).toLowerCase();
  if (typeof value === "string") {
    return value.toLowerCase().includes(normalizedNeedle);
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsString(entry, needle));
  return Object.values(value).some((entry) => containsString(entry, needle));
}

const BLOCK_NUMBER_KEYS = ["blockNumber", "block_number", "number", "height"];
const BLOCK_HASH_KEYS = ["blockHash", "block_hash"];
const EVENT_INDEX_KEYS = ["eventIndex", "event_index", "index"];
const EXTRINSIC_HASH_KEYS = ["extrinsicHash", "extrinsic_hash", "txHash", "transactionHash"];
const MESSAGE_HASH_KEYS = ["messageHash", "message_hash"];
const TOPIC_KEYS = ["messageTopic", "message_topic", "topic", "setTopic", "set_topic", "messageId", "message_id"];
const ASSET_LOCATION_KEYS = ["assetLocation", "asset_location", "location", "asset"];
const AMOUNT_KEYS = ["amount", "settledAssets", "settled_assets", "assets", "value"];

function pickTopic(source) {
  const explicit = pickDeep(source, TOPIC_KEYS);
  if (explicit) return explicit;
  return "";
}

function pickDeep(value, keys) {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = pickDeep(entry, keys);
      if (found) return found;
    }
    return "";
  }

  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") {
      return value[key];
    }
  }
  for (const child of Object.values(value)) {
    const found = pickDeep(child, keys);
    if (found) return found;
  }
  return "";
}

function pickString(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") continue;
    return String(value).trim();
  }
  return "";
}

function parseJsonOption(value) {
  if (!value) return undefined;
  return JSON.parse(value);
}

function normalizeChain(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["hub", "polkadot-hub", "polkadothub"].includes(normalized)) return "hub";
  if (["bifrost", "bifrost-polkadot", "bifrostpolkadot"].includes(normalized)) return "bifrost";
  fail(`chain must be hub or bifrost; got ${JSON.stringify(value)}.`);
}

function assertHex32(value, label) {
  const normalized = pickString(value);
  if (!/^0x[a-fA-F0-9]{64}$/u.test(normalized)) {
    fail(`${label} must be a 0x-prefixed 32-byte hex string.`);
  }
  return normalized;
}

function normalizeOptionalHex32(value, label) {
  const normalized = pickString(value);
  if (!normalized) return undefined;
  return assertHex32(normalized, label);
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

if (isMain()) {
  await main();
}

function fail(message) {
  throw new Error(message);
}
