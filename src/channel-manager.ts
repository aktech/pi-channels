import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type {
	ChannelConfig,
	ChannelConnection,
	ChannelMessage,
	ChannelPermissionRequest,
	ChannelPermissionVerdict,
} from "./types.js";

// ============================================================================
// Notification schemas (Zod, for MCP SDK setNotificationHandler)
// ============================================================================

const ChannelNotificationSchema = z.object({
	method: z.literal("notifications/claude/channel"),
	params: z.object({
		content: z.string(),
		meta: z.record(z.string()).optional(),
	}),
});

const PermissionRequestNotificationSchema = z.object({
	method: z.literal("notifications/claude/channel/permission_request"),
	params: z.object({
		request_id: z.string(),
		tool_name: z.string(),
		description: z.string(),
		input_preview: z.string(),
	}),
});

const PermissionVerdictNotificationSchema = z.object({
	method: z.literal("notifications/claude/channel/permission"),
	params: z.object({
		request_id: z.string(),
		behavior: z.enum(["allow", "deny"]),
	}),
});

// ============================================================================
// ChannelManager
// ============================================================================

export type ChannelMessageHandler = (message: ChannelMessage) => void;
export type PermissionRequestHandler = (request: ChannelPermissionRequest) => void;
export type PermissionVerdictHandler = (verdict: ChannelPermissionVerdict) => void;

export class ChannelManager {
	private connections = new Map<string, ChannelConnection>();
	private messageHandlers: ChannelMessageHandler[] = [];
	private permissionRequestHandlers: PermissionRequestHandler[] = [];
	private permissionVerdictHandlers: PermissionVerdictHandler[] = [];

	// ========================================================================
	// Lifecycle
	// ========================================================================

	/**
	 * Start a channel by spawning its MCP server and connecting as a client.
	 */
	async startChannel(name: string, config: ChannelConfig): Promise<void> {
		if (this.connections.has(name)) {
			throw new Error(`Channel "${name}" is already running`);
		}

		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args,
			env: { ...process.env, ...config.env } as Record<string, string>,
		});

		const client = new Client({ name: `pi-channels/${name}`, version: "0.1.0" }, { capabilities: {} });

		// Set up notification handlers BEFORE connecting
		client.setNotificationHandler(ChannelNotificationSchema, async (notification) => {
			const msg: ChannelMessage = {
				source: name,
				content: notification.params.content,
				meta: notification.params.meta ?? {},
			};
			for (const handler of this.messageHandlers) {
				try {
					handler(msg);
				} catch (err) {
					console.error(`[channels] Message handler error for "${name}":`, err);
				}
			}
		});

		client.setNotificationHandler(PermissionRequestNotificationSchema, async (notification) => {
			const req: ChannelPermissionRequest = {
				source: name,
				requestId: notification.params.request_id,
				toolName: notification.params.tool_name,
				description: notification.params.description,
				inputPreview: notification.params.input_preview,
			};
			for (const handler of this.permissionRequestHandlers) {
				try {
					handler(req);
				} catch (err) {
					console.error(`[channels] Permission request handler error for "${name}":`, err);
				}
			}
		});

		client.setNotificationHandler(PermissionVerdictNotificationSchema, async (notification) => {
			const verdict: ChannelPermissionVerdict = {
				source: name,
				requestId: notification.params.request_id,
				behavior: notification.params.behavior,
			};
			for (const handler of this.permissionVerdictHandlers) {
				try {
					handler(verdict);
				} catch (err) {
					console.error(`[channels] Permission verdict handler error for "${name}":`, err);
				}
			}
		});

		await client.connect(transport);

		// Read server capabilities
		const serverCapabilities = client.getServerCapabilities();
		const hasChannel = !!serverCapabilities?.experimental?.["claude/channel"];
		if (!hasChannel) {
			await transport.close();
			throw new Error(
				`Server "${name}" does not declare the "claude/channel" capability. ` + `It cannot be used as a channel.`,
			);
		}

		const hasPermissionRelay = !!serverCapabilities?.experimental?.["claude/channel/permission"];

		// Read server instructions
		const serverInfo = client.getServerVersion();
		// Instructions are passed as part of the server constructor and available via getInstructions
		// The MCP SDK exposes instructions via the initialize response
		let instructions: string | undefined;
		try {
			// Instructions come from the server's initialize response
			instructions = (client as any)._serverInstructions as string | undefined;
		} catch {
			// Fallback - instructions may not be accessible this way
		}

		// Discover tools (e.g. `reply`)
		let tools: any[] = [];
		try {
			if (serverCapabilities?.tools) {
				const toolsResult = await client.listTools();
				tools = toolsResult.tools;
			}
		} catch {
			// Server may not expose tools (one-way channel)
		}

		const connection: ChannelConnection = {
			name,
			client,
			transport,
			tools,
			instructions,
			hasPermissionRelay,
		};

		this.connections.set(name, connection);
	}

	/**
	 * Stop a single channel and kill its subprocess.
	 */
	async stopChannel(name: string): Promise<void> {
		const conn = this.connections.get(name);
		if (!conn) return;

		this.connections.delete(name);
		try {
			await conn.client.close();
		} catch {
			// Best-effort cleanup
		}
	}

	/**
	 * Stop all channels.
	 */
	async stopAll(): Promise<void> {
		const names = Array.from(this.connections.keys());
		await Promise.allSettled(names.map((n) => this.stopChannel(n)));
	}

	// ========================================================================
	// Event subscriptions
	// ========================================================================

	onMessage(handler: ChannelMessageHandler): () => void {
		this.messageHandlers.push(handler);
		return () => {
			const idx = this.messageHandlers.indexOf(handler);
			if (idx >= 0) this.messageHandlers.splice(idx, 1);
		};
	}

	onPermissionRequest(handler: PermissionRequestHandler): () => void {
		this.permissionRequestHandlers.push(handler);
		return () => {
			const idx = this.permissionRequestHandlers.indexOf(handler);
			if (idx >= 0) this.permissionRequestHandlers.splice(idx, 1);
		};
	}

	onPermissionVerdict(handler: PermissionVerdictHandler): () => void {
		this.permissionVerdictHandlers.push(handler);
		return () => {
			const idx = this.permissionVerdictHandlers.indexOf(handler);
			if (idx >= 0) this.permissionVerdictHandlers.splice(idx, 1);
		};
	}

	// ========================================================================
	// Tool calls (reply, etc.)
	// ========================================================================

	/**
	 * Call a tool on a specific channel's MCP server.
	 */
	async callTool(
		channelName: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<{ content: Array<{ type: string; text?: string }> }> {
		const conn = this.connections.get(channelName);
		if (!conn) {
			throw new Error(`Channel "${channelName}" is not connected`);
		}

		const result = await conn.client.callTool({ name: toolName, arguments: args });
		return result as { content: Array<{ type: string; text?: string }> };
	}

	// ========================================================================
	// Queries
	// ========================================================================

	/** Get all active channel connections. */
	getConnections(): ChannelConnection[] {
		return Array.from(this.connections.values());
	}

	/** Check if any channels are running. */
	hasActiveChannels(): boolean {
		return this.connections.size > 0;
	}

	/** Get channel names. */
	getChannelNames(): string[] {
		return Array.from(this.connections.keys());
	}

	/** Get a specific connection. */
	getConnection(name: string): ChannelConnection | undefined {
		return this.connections.get(name);
	}

	/**
	 * Build a combined instructions string from all channels for the system prompt.
	 */
	getInstructions(): string {
		const parts: string[] = [];
		parts.push("## Channels");
		parts.push("");
		parts.push("You have active channel connections. Messages from channels arrive as `<channel>` tags.");
		parts.push("Read them and respond appropriately using the channel's reply tool if available.");
		parts.push("");

		for (const conn of this.connections.values()) {
			parts.push(`### Channel: ${conn.name}`);
			if (conn.instructions) {
				parts.push(conn.instructions);
			} else {
				parts.push(`Events arrive as \`<channel source="${conn.name}" ...>\`. `);
				if (conn.tools.length > 0) {
					const toolNames = conn.tools.map((t) => `\`${t.name}\``).join(", ");
					parts.push(`Available tools: ${toolNames}`);
				} else {
					parts.push("This is a one-way channel (no reply tool).");
				}
			}
			if (conn.hasPermissionRelay) {
				parts.push("This channel supports permission relay.");
			}
			parts.push("");
		}

		return parts.join("\n");
	}
}
