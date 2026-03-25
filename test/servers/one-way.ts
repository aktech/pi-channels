import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const mcp = new Server(
	{ name: "one-way", version: "0.0.1" },
	{
		capabilities: { experimental: { "claude/channel": {} } },
		instructions: 'One-way test channel. Events arrive as <channel source="one-way">.',
	},
);

await mcp.connect(new StdioServerTransport());

setTimeout(async () => {
	await mcp.notification({
		method: "notifications/claude/channel",
		params: { content: "hello from one-way", meta: { severity: "info" } },
	});
}, 500);
