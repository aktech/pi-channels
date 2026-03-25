#!/usr/bin/env npx tsx
/**
 * Minimal fakechat channel server for testing.
 * - Exposes an HTTP endpoint on port 8787
 * - POST / sends a message into the channel
 * - Has a reply tool that logs replies to stderr
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "http";

const mcp = new Server(
	{ name: "fakechat", version: "0.0.1" },
	{
		capabilities: {
			experimental: { "claude/channel": {} },
			tools: {},
		},
		instructions:
			'Messages arrive as <channel source="fakechat" chat_id="...">. ' +
			"Reply with the channel_fakechat_reply tool, passing the chat_id from the tag.",
	},
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "reply",
			description: "Send a reply back to the fakechat user",
			inputSchema: {
				type: "object" as const,
				properties: {
					chat_id: { type: "string", description: "Chat ID to reply in" },
					text: { type: "string", description: "Message text" },
				},
				required: ["chat_id", "text"],
			},
		},
	],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name === "reply") {
		const { chat_id, text } = req.params.arguments as { chat_id: string; text: string };
		console.error(`[fakechat] Reply to ${chat_id}: ${text}`);
		return { content: [{ type: "text", text: "sent" }] };
	}
	throw new Error(`unknown tool: ${req.params.name}`);
});

await mcp.connect(new StdioServerTransport());

// HTTP server for sending test messages
const httpServer = createServer(async (req, res) => {
	if (req.method === "POST") {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = Buffer.concat(chunks).toString("utf-8");

		let content = body;
		let chatId = "test-user";
		try {
			const parsed = JSON.parse(body);
			content = parsed.text || parsed.content || body;
			chatId = parsed.chat_id || "test-user";
		} catch {
			// Use raw body as content
		}

		await mcp.notification({
			method: "notifications/claude/channel",
			params: {
				content,
				meta: { chat_id: chatId },
			},
		});

		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok\n");
	} else {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("POST a message to send it to the channel\n");
	}
});

httpServer.listen(8787, "127.0.0.1", () => {
	console.error("[fakechat] HTTP server listening on http://127.0.0.1:8787");
});
