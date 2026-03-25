#!/usr/bin/env npx tsx
/**
 * Telegram channel server for pi-channels.
 *
 * Uses Telegram Bot API long polling to receive messages,
 * and pushes them into pi via the MCP channel protocol.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN  - Your bot token from @BotFather
 *   TELEGRAM_CHAT_ID    - (Optional) Restrict to a single chat ID
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
	console.error("[telegram] TELEGRAM_BOT_TOKEN is required");
	process.exit(1);
}

const ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID
	? String(process.env.TELEGRAM_CHAT_ID)
	: undefined;

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Telegram Bot API helpers ────────────────────────────────────────

async function tgRequest(method: string, body?: Record<string, unknown>) {
	const res = await fetch(`${API}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = (await res.json()) as { ok: boolean; result?: any; description?: string };
	if (!json.ok) throw new Error(`Telegram API error: ${json.description}`);
	return json.result;
}

async function sendMessage(chatId: string, text: string) {
	return tgRequest("sendMessage", {
		chat_id: chatId,
		text,
		parse_mode: "Markdown",
	});
}

// ── MCP Server ──────────────────────────────────────────────────────

const mcp = new Server(
	{ name: "telegram", version: "0.0.1" },
	{
		capabilities: {
			experimental: { "claude/channel": {} },
			tools: {},
		},
		instructions:
			'Telegram messages arrive as <channel source="telegram" chat_id="..." username="..." first_name="...">. ' +
			"Reply with the channel_telegram_reply tool, passing the chat_id from the tag. " +
			"Keep replies concise and conversational. Use Markdown formatting supported by Telegram.",
	},
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "reply",
			description: "Send a reply message to a Telegram chat",
			inputSchema: {
				type: "object" as const,
				properties: {
					chat_id: { type: "string", description: "Telegram chat ID to reply in" },
					text: { type: "string", description: "Message text (Markdown supported)" },
				},
				required: ["chat_id", "text"],
			},
		},
	],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name === "reply") {
		const { chat_id, text } = req.params.arguments as { chat_id: string; text: string };
		try {
			await sendMessage(chat_id, text);
			console.error(`[telegram] Sent reply to ${chat_id}`);
			return { content: [{ type: "text", text: "sent" }] };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[telegram] Failed to send: ${msg}`);
			return { content: [{ type: "text", text: `Failed to send: ${msg}` }], isError: true };
		}
	}
	throw new Error(`unknown tool: ${req.params.name}`);
});

await mcp.connect(new StdioServerTransport());

// ── Long polling loop ───────────────────────────────────────────────

let offset = 0;

async function poll() {
	while (true) {
		try {
			const updates = await tgRequest("getUpdates", {
				offset,
				timeout: 30,
				allowed_updates: ["message"],
			});

			for (const update of updates) {
				offset = update.update_id + 1;
				const msg = update.message;
				if (!msg?.text) continue;

				const chatId = String(msg.chat.id);

				// Filter to allowed chat if configured
				if (ALLOWED_CHAT_ID && chatId !== ALLOWED_CHAT_ID) {
					console.error(`[telegram] Ignoring message from chat ${chatId} (not ${ALLOWED_CHAT_ID})`);
					continue;
				}

				const username = msg.from?.username || "unknown";
				const firstName = msg.from?.first_name || "";

				console.error(`[telegram] Message from @${username} (${chatId}): ${msg.text}`);

				await mcp.notification({
					method: "notifications/claude/channel",
					params: {
						content: msg.text,
						meta: {
							chat_id: chatId,
							username,
							first_name: firstName,
							message_id: String(msg.message_id),
						},
					},
				});
			}
		} catch (err) {
			console.error("[telegram] Polling error:", err instanceof Error ? err.message : err);
			// Back off on error
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
}

console.error("[telegram] Starting long polling...");
poll();
