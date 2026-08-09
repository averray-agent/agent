import {
  MCP_SERVER_INFO,
  MODERN_MCP_VERSION
} from "../../mcp-server/src/protocols/mcp/handler.js";
import { MCP_TOOLS } from "../../mcp-server/src/protocols/mcp/tools.js";

export const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_AGENT_CARD_SCHEMA_VERSION = "1.0";
export const A2A_MCP_PROTOCOL_BINDING =
  `https://modelcontextprotocol.io/specification/${MODERN_MCP_VERSION}`;

const API_BASE_URL = "https://api.averray.com";
const AUTH_META_KEY = "com.averray/auth";

/**
 * A2A v1.0 Agent Card discovery format only. The declared bindings are the
 * protocols those URLs actually speak; this does not advertise an A2A task
 * endpoint or an A2A JSON-RPC implementation.
 */
export function buildProductionA2aAgentCard({
  serverInfo = MCP_SERVER_INFO,
  tools = MCP_TOOLS
} = {}) {
  return {
    name: serverInfo.title,
    description:
      "Discovery card for Averray's existing MCP tool endpoint and HTTP+JSON REST API. This card uses the A2A Agent Card format only; Averray does not serve A2A JSON-RPC or A2A task methods.",
    supportedInterfaces: [
      {
        url: `${API_BASE_URL}/mcp`,
        protocolBinding: A2A_MCP_PROTOCOL_BINDING,
        protocolVersion: A2A_AGENT_CARD_SCHEMA_VERSION
      },
      {
        url: API_BASE_URL,
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_AGENT_CARD_SCHEMA_VERSION
      }
    ],
    version: serverInfo.version,
    capabilities: {},
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: tools.map(toolToAgentSkill)
  };
}

export function buildProductionA2aAgentCardContent(options = {}) {
  return `${JSON.stringify(buildProductionA2aAgentCard(options), null, 2)}\n`;
}

function toolToAgentSkill(tool) {
  const auth = tool?._meta?.[AUTH_META_KEY];
  return {
    id: tool.name,
    name: tool.title,
    description: tool.description,
    tags: [
      "mcp-tool",
      tool.name,
      tool.annotations?.readOnlyHint === true ? "read-only" : "state-changing",
      auth?.required === true ? "authentication-required" : "anonymous"
    ]
  };
}
