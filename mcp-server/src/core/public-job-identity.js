import { id as hashJobId } from "ethers";

export function matchesPublicJobId(job, requested) {
  if (job.id === requested) return true;
  if (!/^0x[0-9a-f]{64}$/iu.test(requested) || typeof job.id !== "string") return false;
  const chainId = /^0x[0-9a-f]{64}$/iu.test(job.id) ? job.id : hashJobId(job.id);
  return chainId.toLowerCase() === requested.toLowerCase();
}
