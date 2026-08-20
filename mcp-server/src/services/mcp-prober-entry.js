import { assertMcpProberEnvironment, McpProberService } from "./mcp-prober-service.js";

assertMcpProberEnvironment(process.env);
const service = new McpProberService({ proxyUrl: process.env.MCP_EGRESS_PROXY_URL, logger: console });
const port = Number(process.env.PORT ?? 8080);
service.listen({ port });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await service.close();
    process.exit(0);
  });
}
