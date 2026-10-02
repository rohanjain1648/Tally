/**
 * Tally as an MCP server (stdio).
 *
 * Exposes Tally's PayPal tools to any MCP client (Claude Desktop, Claude Code, Cursor…). It does not talk to
 * PayPal itself: every call goes through the running Tally API, so external agents get the same guardrails as
 * the built-in one. Reads run; writes inside your limits run; everything else lands in Tally's approval queue
 * and the agent is told to wait for the owner.
 *
 *   TALLY_URL=http://localhost:8787 npm run mcp
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TALLY = (process.env.TALLY_URL ?? "http://localhost:8787").replace(/\/$/, "");

async function tally<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${TALLY}/api${path}`, { ...init, headers: { "Content-Type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Tally returned ${res.status}`);
  return data as T;
}

const server = new Server({ name: "tally-paypal", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: (await tally<{ name: string; description?: string; input_schema: Record<string, unknown> }[]>("/mcp/tools")).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema as { type: "object" },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const res = await tally<{ status: string; ok?: boolean; content?: string; message?: string }>("/mcp/call", {
      method: "POST",
      body: JSON.stringify({ name: req.params.name, input: req.params.arguments ?? {} }),
    });
    if (res.status === "pending_approval") return { content: [{ type: "text", text: res.message ?? "Waiting for owner approval." }] };
    return { content: [{ type: "text", text: res.content ?? "" }], isError: res.ok === false };
  } catch (err) {
    return { content: [{ type: "text", text: `Tally is unreachable at ${TALLY}: ${(err as Error).message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error(`[tally-mcp] connected, bridging to ${TALLY}`);
