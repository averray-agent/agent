import { Interface } from "ethers";

import { XCM_WRAPPER_ABI } from "./abis.js";

const xcmWrapperInterface = new Interface(XCM_WRAPPER_ABI);

export function decodeXcmWrapperRevert(error) {
  const data = firstHexRevertData(
    error?.data,
    error?.error?.data,
    error?.info?.error?.data,
    error?.info?.error?.data?.data,
    error?.cause?.data
  );
  if (!data) return undefined;
  try {
    const decoded = xcmWrapperInterface.parseError(data);
    if (!decoded) return undefined;
    return {
      name: decoded.name,
      reason: `XcmWrapperV22.${decoded.name}(${[...decoded.args].map(formatCustomErrorArgument).join(", ")})`
    };
  } catch {
    return undefined;
  }
}

function firstHexRevertData(...values) {
  for (const value of values) {
    if (typeof value === "string" && /^0x[a-fA-F0-9]{8,}$/u.test(value)) return value;
    if (typeof value?.data === "string" && /^0x[a-fA-F0-9]{8,}$/u.test(value.data)) return value.data;
  }
  return undefined;
}

function formatCustomErrorArgument(value) {
  return typeof value === "bigint" ? value.toString() : String(value);
}
