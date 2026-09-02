import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { id } from "ethers";
const canon = (v) => {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  throw new Error("unsupported");
};
const specHashOf = (def) => "0x" + createHash("sha256").update(canon(def)).digest("hex");
const draftIdOf = (wallet, specHash) => id(canon({ contentHash: specHash.toLowerCase(), domain: "averray.external-quote.v2", poster: wallet.toLowerCase() }));
const jobIdOf   = (wallet, specHash) => id(canon({ contentHash: specHash.toLowerCase(), domain: "averray.external-job.v2",   poster: wallet.toLowerCase() }));

const q = JSON.parse(readFileSync(process.argv[2], "utf8"));
const W = "0xA287a52bb9624a4c2fE97E60D59B0de584A37bf6";
const sh = specHashOf(q.definition);
console.log(JSON.stringify({
  specHash:  { derived: sh,                 actual: q.specHash, match: sh.toLowerCase() === q.specHash.toLowerCase() },
  draftId:   { derived: draftIdOf(W, sh),   actual: q.draftId,  match: draftIdOf(W, sh) === q.draftId },
  jobId:     { derived: jobIdOf(W, sh),     actual: q.jobId,    match: jobIdOf(W, sh)   === q.jobId }
}, null, 2));
