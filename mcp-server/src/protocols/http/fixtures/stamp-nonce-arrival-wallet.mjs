// Test-only preload. Stamps request._arrivalWallet from a header so the HTTP
// finish hook's nonce exclusion is load-bearing: reverting it stitches the
// unsigned wallet. Production never reads this header.
import { Server } from "node:http";

const emit = Server.prototype.emit;
Server.prototype.emit = function (event, request, ...rest) {
  if (event === "request") {
    const stamped = request?.headers?.["x-test-arrival-wallet"];
    if (typeof stamped === "string" && stamped) request._arrivalWallet = stamped;
  }
  return emit.call(this, event, request, ...rest);
};
