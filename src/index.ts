import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ChannelManager } from "./channel-manager.js";
import type { ChannelConnection, ChannelMessage, ChannelsConfig } from "./types.js";

export type { ChannelConfig, ChannelMessage, ChannelsConfig } from "./types.js";
export { ChannelManager } from "./channel-manager.js";

// ============================================================================
// Config loading
// ============================================================================

const CONFIG_FILENAMES = [".pi-channels.json", "pi-channels.json"];

function loadChannelsConfig(cwd: string): ChannelsConfig | undefined {
	for (const filename of CONFIG_FILENAMES) {
		const configPath = join(cwd, filename);
		if (existsSync(configPath)) {
			try {
				const raw = readFileSync(configPath, "utf-8");
				return JSON.parse(raw) as ChannelsConfig;
			} catch (err) {
				console.error(`[channels] Failed to parse ${configPath}:`, err);
			}
		}
	}
	return undefined;
}

// ============================================================================
// Channel message formatting
// ============================================================================

function formatChannelTag(msg: ChannelMessage): string {
	const attrs = [`source="${msg.source}"`];
	for (const [key, value] of Object.entries(msg.meta)) {
		// Only allow identifier-safe keys (letters, digits, underscores)
		if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
			// Escape XML attribute value
			const escaped = value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
			attrs.push(`${key}="${escaped}"`);
		}
	}
	return `<channel ${attrs.join(" ")}>${msg.content}</channel>`;
}

// ============================================================================
// Tool registration helpers
// ============================================================================

/**
 * Create a pi tool definition that proxies to a channel's MCP reply tool.
 */
function createChannelReplyTool(
	channelName: string,
	mcpTool: { name: string; description?: string; inputSchema?: any },
	manager: ChannelManager,
) {
	// Build TypeBox schema from the MCP tool's JSON Schema
	const properties: Record<string, any> = {};
	const required: string[] = mcpTool.inputSchema?.required ?? [];

	if (mcpTool.inputSchema?.properties) {
		for (const [key, schema] of Object.entries(mcpTool.inputSchema.properties)) {
			const s = schema as { type?: string; description?: string };
			if (s.type === "string") {
				properties[key] = Type.String({ description: s.description });
			} else if (s.type === "number") {
				properties[key] = Type.Number({ description: s.description });
			} else if (s.type === "boolean") {
				properties[key] = Type.Boolean({ description: s.description });
			} else {
				// Fallback: accept any string
				properties[key] = Type.String({ description: s.description });
			}
		}
	}

	const parameters = Type.Object(properties, {
		// Mark required fields
		...(required.length > 0 ? {} : {}),
	});

	// Unique tool name scoped to the channel
	const toolName =
		channelName === mcpTool.name ? `channel_${channelName}_reply` : `channel_${channelName}_${mcpTool.name}`;

	return {
		name: toolName,
		label: `${channelName}:${mcpTool.name}`,
		description: mcpTool.description ?? `Call the "${mcpTool.name}" tool on channel "${channelName}"`,
		promptSnippet: `Use this tool to call ${mcpTool.name} on the ${channelName} channel.`,
		parameters,
		async execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined) {
			try {
				const result = await manager.callTool(channelName, mcpTool.name, params);
				const text =
					result.content
						?.filter((c) => c.type === "text" && c.text)
						.map((c) => c.text!)
						.join("\n") || "ok";
				return {
					content: [{ type: "text" as const, text }],
					details: { channel: channelName, tool: mcpTool.name },
				};
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Error: ${errMsg}` }],
					details: { channel: channelName, tool: mcpTool.name, error: errMsg },
				};
			}
		},
	};
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function channelsExtension(pi: ExtensionAPI) {
	const manager = new ChannelManager();
	let cleanups: Array<() => void> = [];

	// Register CLI flag: --channels webhook,telegram
	pi.registerFlag("channels", {
		type: "string",
		description: "Comma-separated list of channel names to activate (from .pi-channels.json)",
	});

	// ------------------------------------------------------------------
	// Start channels on session start
	// ------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const channelsFlag = pi.getFlag("channels") as string | undefined;
		if (!channelsFlag) return;

		const config = loadChannelsConfig(ctx.cwd);
		if (!config) {
			ctx.ui.notify(`No channel config found. Create .pi-channels.json in ${ctx.cwd}`, "warning");
			return;
		}

		// Parse requested channel names
		const requestedNames =
			channelsFlag === "all"
				? Object.keys(config)
				: channelsFlag
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);

		// Validate
		const missing = requestedNames.filter((n) => !config[n]);
		if (missing.length > 0) {
			ctx.ui.notify(`Unknown channels: ${missing.join(", ")}. Available: ${Object.keys(config).join(", ")}`, "error");
			return;
		}

		// Start each channel
		const started: string[] = [];
		for (const name of requestedNames) {
			try {
				await manager.startChannel(name, config[name]);
				started.push(name);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to start channel "${name}": ${msg}`, "error");
			}
		}

		if (started.length === 0) return;

		// Register reply tools for each channel
		for (const conn of manager.getConnections()) {
			for (const mcpTool of conn.tools) {
				const toolDef = createChannelReplyTool(conn.name, mcpTool, manager);
				pi.registerTool(toolDef as any);
			}
		}

		// Handle incoming channel messages → inject into pi session
		const unsubMsg = manager.onMessage((msg) => {
			// Status messages go to UI notification, not the agent
			if (msg.meta?.type === "status") {
				ctx.ui.notify(msg.content, "info");
				return;
			}
			const tag = formatChannelTag(msg);
			pi.sendUserMessage(tag, { deliverAs: "followUp" });
		});
		cleanups.push(unsubMsg);

		// Handle permission verdicts from channels
		const unsubVerdict = manager.onPermissionVerdict((verdict) => {
			// Emit on event bus so other extensions can react
			pi.events.emit("channel:permission_verdict", verdict);
		});
		cleanups.push(unsubVerdict);

		// Handle permission requests (outbound from pi → channels)
		const unsubPermReq = manager.onPermissionRequest((req) => {
			pi.events.emit("channel:permission_request", req);
		});
		cleanups.push(unsubPermReq);

		// Show status
		ctx.ui.setStatus("channels", `channels: ${started.join(", ")}`);
		ctx.ui.notify(`Channels started: ${started.join(", ")}`, "info");
	});

	// ------------------------------------------------------------------
	// Add channel instructions to system prompt
	// ------------------------------------------------------------------
	pi.on("before_agent_start", async (event) => {
		if (!manager.hasActiveChannels()) return undefined;

		return {
			systemPrompt: event.systemPrompt + "\n\n" + manager.getInstructions(),
		};
	});

	// ------------------------------------------------------------------
	// Shutdown channels on session end
	// ------------------------------------------------------------------
	pi.on("session_shutdown", async () => {
		for (const cleanup of cleanups) {
			try {
				cleanup();
			} catch {
				/* ignore */
			}
		}
		cleanups = [];
		await manager.stopAll();
	});

	// ------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------

	pi.registerCommand("channels", {
		description: "List active channels and their status",
		handler: async (_args, ctx) => {
			const connections = manager.getConnections();
			if (connections.length === 0) {
				ctx.ui.notify("No active channels. Use --channels flag to start channels.", "info");
				return;
			}

			const lines = connections.map((conn) => {
				const tools = conn.tools.map((t) => t.name).join(", ") || "none";
				const perm = conn.hasPermissionRelay ? "yes" : "no";
				return `  ${conn.name}: tools=[${tools}] permission-relay=${perm}`;
			});

			ctx.ui.notify(`Active channels:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("channel-stop", {
		description: "Stop a specific channel: /channel-stop <name>",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /channel-stop <channel-name>", "warning");
				return;
			}
			if (!manager.getConnection(name)) {
				ctx.ui.notify(`Channel "${name}" is not running`, "warning");
				return;
			}
			await manager.stopChannel(name);
			ctx.ui.notify(`Channel "${name}" stopped`, "info");

			// Update status
			const remaining = manager.getChannelNames();
			if (remaining.length > 0) {
				ctx.ui.setStatus("channels", `channels: ${remaining.join(", ")}`);
			} else {
				ctx.ui.setStatus("channels", undefined as any);
			}
		},
	});

	pi.registerCommand("telegram-pair", {
		description: "Pair a Telegram user: /telegram-pair <code>",
		handler: async (args, ctx) => {
			const code = args.trim();
			if (!code) {
				ctx.ui.notify("Usage: /telegram-pair <code>", "warning");
				return;
			}

			const conn = manager.getConnection("telegram");
			if (!conn) {
				ctx.ui.notify('Telegram channel is not running. Start it with --channels telegram', "warning");
				return;
			}

			try {
				const result = await manager.callTool("telegram", "pair", { code });
				const text =
					result.content
						?.filter((c) => c.type === "text" && c.text)
						.map((c) => c.text!)
						.join("\n") || "ok";
				ctx.ui.notify(text, "info");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Pairing failed: ${msg}`, "error");
			}
		},
	});

	pi.registerCommand("channel-start", {
		description: "Start a channel from config: /channel-start <name>",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /channel-start <channel-name>", "warning");
				return;
			}

			const config = loadChannelsConfig(ctx.cwd);
			if (!config || !config[name]) {
				ctx.ui.notify(
					`Channel "${name}" not found in config. Available: ${config ? Object.keys(config).join(", ") : "none"}`,
					"warning",
				);
				return;
			}

			if (manager.getConnection(name)) {
				ctx.ui.notify(`Channel "${name}" is already running`, "warning");
				return;
			}

			try {
				await manager.startChannel(name, config[name]);
				const conn = manager.getConnection(name)!;

				// Register tools for the new channel
				for (const mcpTool of conn.tools) {
					const toolDef = createChannelReplyTool(conn.name, mcpTool, manager);
					pi.registerTool(toolDef as any);
				}

				ctx.ui.notify(`Channel "${name}" started`, "info");
				ctx.ui.setStatus("channels", `channels: ${manager.getChannelNames().join(", ")}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to start channel "${name}": ${msg}`, "error");
			}
		},
	});
}
