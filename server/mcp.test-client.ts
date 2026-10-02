/** Manual smoke test: npm run mcp:test (needs Tally running). Lists tools, reads cash, tries a refund. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "server/mcp.ts"], env: { ...process.env } as Record<string, string>}));

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "").slice(0, 160);
console.log("get_cash_summary →", text(await client.callTool({ name: "get_cash_summary", arguments: {} })));
console.log("refund_payment   →", text(await client.callTool({ name: "refund_payment", arguments: { payment_id: "NOT-A-REAL-ID", amount: 10, reason: "smoke test" } })));
await client.close();
