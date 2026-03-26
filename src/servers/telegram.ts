#!/usr/bin/env node
/**
 * Telegram channel server for pi-channels.
 *
 * Uses Telegram Bot API long polling to receive messages,
 * and pushes them into pi via the MCP channel protocol.
 *
 * Security: only allowlisted chat IDs can push messages.
 * Unknown senders receive a pairing code; confirm it in pi
 * by calling the `pair` tool with the code.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN  - Your bot token from @BotFather (required)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
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

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// -- Allowlist persistence ---------------------------------------------------

const CONFIG_DIR = join(homedir(), ".pi", "channels", "telegram");
const ALLOWLIST_PATH = join(CONFIG_DIR, "allowlist.json");

function loadAllowlist(): Set<string> {
	try {
		if (existsSync(ALLOWLIST_PATH)) {
			const data = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf-8")) as string[];
			return new Set(data);
		}
	} catch {
		console.error("[telegram] Failed to load allowlist, starting fresh");
	}
	return new Set();
}

function saveAllowlist(allowlist: Set<string>) {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(ALLOWLIST_PATH, JSON.stringify([...allowlist], null, 2));
}

const allowlist = loadAllowlist();

// -- Pairing -----------------------------------------------------------------

const pendingPairings = new Map<string, { chatId: string; username: string; expiresAt: number }>();

function generatePairingCode(): string {
	return randomBytes(3).toString("hex").toUpperCase(); // 6-char hex code
}

// -- Telegram Bot API helpers ------------------------------------------------

async function tgRequest(method: string, body?: Record<string, unknown>) {
	const res = await fetch(`${API}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
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

// -- MCP Server --------------------------------------------------------------

const mcp = new Server(
	{ name: "telegram", version: "0.1.0" },
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

	if (req.params.name === "pair") {
		const { code } = req.params.arguments as { code: string };
		const normalized = code.trim().toUpperCase();
		const pending = pendingPairings.get(normalized);

		if (!pending) {
			return {
				content: [{ type: "text", text: `Invalid or expired pairing code: ${normalized}` }],
				isError: true,
			};
		}

		if (Date.now() > pending.expiresAt) {
			pendingPairings.delete(normalized);
			return {
				content: [{ type: "text", text: "Pairing code has expired. Ask the user to send another message to get a new code." }],
				isError: true,
			};
		}

		allowlist.add(pending.chatId);
		saveAllowlist(allowlist);
		pendingPairings.delete(normalized);

		await sendMessage(pending.chatId, "Paired successfully! Your messages will now be forwarded to pi.");
		console.error(`[telegram] Paired @${pending.username} (chat ${pending.chatId})`);

		return {
			content: [{ type: "text", text: `Paired @${pending.username} (chat ${pending.chatId}). Their messages will now be forwarded.` }],
		};
	}

	throw new Error(`unknown tool: ${req.params.name}`);
});

await mcp.connect(new StdioServerTransport());

// -- Long polling loop -------------------------------------------------------

let offset = 0;

async function poll() {
	while (true) {
		try {
			const updates = (await tgRequest("getUpdates", {
				offset,
				timeout: 30,
				allowed_updates: ["message"],
			})) as Array<{
				update_id: number;
				message?: {
					text?: string;
					chat: { id: number };
					from?: { username?: string; first_name?: string };
					message_id: number;
				};
			}>;

			for (const update of updates) {
				offset = update.update_id + 1;
				const msg = update.message;
				if (!msg?.text) continue;

				const chatId = String(msg.chat.id);
				const username = msg.from?.username || "unknown";
				const firstName = msg.from?.first_name || "";

				// Unknown sender — issue a pairing code
				if (!allowlist.has(chatId)) {
					const code = generatePairingCode();
					pendingPairings.set(code, {
						chatId,
						username,
						expiresAt: Date.now() + 5 * 60 * 1000, // 5 minute expiry
					});

					await sendMessage(
						chatId,
						`Your pairing code is: \`${code}\`\n\nThis code expires in 5 minutes.`,
					);
					console.error(`[telegram] Pairing request from @${username}. Check Telegram for the code, then run /telegram-pair <code> in pi.`);
					continue;
				}

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
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
}

console.error("[telegram] Starting long polling...");
if (allowlist.size > 0) {
	console.error(`[telegram] Allowlist: ${[...allowlist].join(", ")}`);
} else {
	console.error("[telegram] No users in allowlist. Send a message to the bot to get a pairing code.");
}
poll();
