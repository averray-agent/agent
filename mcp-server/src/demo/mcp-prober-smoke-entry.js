import { McpFailureSemanticsRunner } from "../services/mcp-failure-semantics-runner.js";
import { McpProberService } from "../services/mcp-prober-service.js";

new McpProberService({
  runner: new McpFailureSemanticsRunner({ allowInsecureHttp: true }),
  proxyUrl: process.env.MCP_EGRESS_PROXY_URL
}).listen({ port: Number(process.env.PORT ?? 8080) });
