// Read-only: dry-run the wrapper dispatchLeg(laneRequestId, 2, fee) exactly as
// the runtime's dryRunMessage does, for several candidate fees; dump failures.
import { Interface } from "ethers";
const { ApiPromise, WsProvider } = await import("@polkadot/api");
const api = await ApiPromise.create({ provider: new WsProvider("wss://asset-hub-polkadot-rpc.n.dwellir.com", 5000), noInitWarn: true, throwOnConnect: true });
try {
  const operator = (await api.call.reviveApi.accountId("0x5a6836c6D4d293F6E5377E6c28054F4171915813")).toHex();
  const iface = new Interface(["function dispatchLeg(bytes32,uint8,uint256)"]);
  const LANE = "0x14672fbc224ef19fd91548763d2cbf7b88b4e00e74f77d48698a49dbe241dd85";
  const WRAPPER = "0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc";
  const HIGH_WEIGHT = { refTime: 50_000_000_000n, proofSize: 1_500_000n };
  for (const fee of [40000n, 20000n, 6000n]) {
    const data = iface.encodeFunctionData("dispatchLeg", [LANE, 2, fee]);
    const call = api.tx.revive.call(WRAPPER, 0n, HIGH_WEIGHT, 500_000_000_000n, data);
    const result = await api.call.dryRunApi.dryRunCall({ system: { signed: operator } }, call, 5);
    const json = result.toJSON();
    const ok = Boolean(json?.ok?.executionResult?.ok);
    console.log("fee=" + fee, "ok=" + ok);
    if (!ok) {
      console.log("  failure:", JSON.stringify(json?.ok?.executionResult ?? json).slice(0, 600));
      const events = result.toHuman()?.Ok?.emittedEvents ?? [];
      for (const e of events) if (e.section === "revive" || e.section === "system") console.log("  ", e.section + "." + e.method, JSON.stringify(e.data).slice(0, 300));
    }
  }
} finally { await api.disconnect(); }
