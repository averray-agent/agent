import base from "../content/llms.txt?raw";
import { buildVerifySiteSignalsLlmsSection } from "../../../mcp-server/src/core/verify-pricing.js";

export function GET() {
  return new Response(base.replace("## Start from zero", `${buildVerifySiteSignalsLlmsSection()}\n## Start from zero`), {
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
