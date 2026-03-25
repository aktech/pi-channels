import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const mcp = new Server(
	{ name: "two-way", version: "0.0.1" },
	{
		capabilities: { experimental: { "claude/channel": {} }, tools: {} },
		instructions: "Two-way test channel. Reply with the reply tool.",
	},
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "reply",
			description: "Send a reply",
			inputSchema: {
				type: "object" as const,
				properties: {
					chat_id: { type: "string", description: "Chat ID" },
					text: { type: "string", description: "Message" },
				},
				required: ["chat_id", "text"],
			},
		},
	],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name === "reply") {
		const { chat_id, text } = req.params.arguments as { chat_id: string; text: string };
		return { content: [{ type: "text", text: `sent:${chat_id}:${text}` }] };
	}
	throw new Error("unknown tool");
});

await mcp.connect(new StdioServerTransport());
