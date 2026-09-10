// Request-local only. Both doors share a single latest block and never repeat
// the number -> header round trip. Vesting retains its existing head cache.
export function createCreditReadContext(provider, timings = {}) {
  let pinned;
  return {
    timings,
    getBlock() {
      if (!provider) return undefined; // injected test/alternative reader owns its pin
      pinned ??= timeCreditRead(timings, "blockMs", async () => {
        const block = await provider.getBlock("latest");
        if (!Number.isSafeInteger(Number(block?.number)) || !block?.hash) {
          throw new Error("Credit snapshot block is unavailable.");
        }
        return { blockNumber: Number(block.number), block };
      });
      return pinned;
    }
  };
}

export async function timeCreditRead(timings, phase, read) {
  const start = performance.now();
  try { return await read(); }
  finally { if (timings) timings[phase] = Math.round((performance.now() - start) * 1000) / 1000; }
}
