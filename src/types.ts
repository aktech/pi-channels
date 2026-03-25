import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// Channel configuration
// ============================================================================

/** Configuration for a single channel server. */
export interface ChannelConfig {
	/** Command to spawn the channel server process. */
	command: string;
	/** Arguments for the command. */
	args?: string[];
	/** Extra environment variables for the subprocess. */
	env?: Record<string, string>;
}

/** Map of channel name → config, read from `.pi-channels.json`. */
export interface ChannelsConfig {
	[name: string]: ChannelConfig;
}

// ============================================================================
// Runtime state
// ============================================================================

/** A live connection to a channel MCP server. */
export interface ChannelConnection {
	name: string;
	client: Client;
	transport: StdioClientTransport;
	/** MCP tools exposed by this channel (e.g. `reply`). */
	tools: Tool[];
	/** Server instructions (added to system prompt). */
	instructions: string | undefined;
	/** Whether the server declared permission relay capability. */
	hasPermissionRelay: boolean;
}

// ============================================================================
// Channel events (inbound from MCP servers)
// ============================================================================

/** A message pushed by a channel server. */
export interface ChannelMessage {
	/** Channel name (matches the key in config). */
	source: string;
	/** Message body. */
	content: string;
	/** Arbitrary key-value metadata (becomes XML tag attributes). */
	meta: Record<string, string>;
}

/** A permission request relayed by a channel server. */
export interface ChannelPermissionRequest {
	source: string;
	requestId: string;
	toolName: string;
	description: string;
	inputPreview: string;
}

/** A permission verdict sent back from a channel server. */
export interface ChannelPermissionVerdict {
	source: string;
	requestId: string;
	behavior: "allow" | "deny";
}
