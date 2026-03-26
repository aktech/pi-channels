# pi-channels

Channels plugin for the [pi coding agent](https://github.com/aktech/pi-channels). Brings the [Claude Code channels](https://code.claude.com/docs/en/channels) concept to pi — push events into pi sessions via MCP channel servers.

## What are channels?

A channel is an MCP server that pushes events into your running pi session. Channels let pi react to things happening while you're working — like CI results, chat messages, monitoring alerts, or webhooks.

Channels follow the same protocol as [Claude Code channels](https://code.claude.com/docs/en/channels-reference):
- One-way channels push events (alerts, webhooks)
- Two-way channels also expose a `reply` tool so pi can respond

## Setup

### 1. Install the plugin

```bash
pi install npm:pi-channels
```

### 2. Set up Telegram

Create a bot with [@BotFather](https://t.me/BotFather) and set the token:

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
```

### 3. Configure channels

Create `.pi-channels.json` in your project root:

```json
{
  "telegram": {
    "command": "pi-channels-telegram"
  }
}
```

### 4. Launch pi with channels

```bash
pi --channels telegram
```

Or start all configured channels:

```bash
pi --channels all
```

### 5. Pair your Telegram account

Send any message to your bot on Telegram. The bot replies with a pairing code. In pi, run:

```
/telegram-pair <code>
```

Only paired users can send messages. The allowlist is persisted at `~/.pi/channels/telegram/allowlist.json`. Pairing codes expire after 5 minutes.

## Writing a channel server

Channel servers are MCP servers that declare the `claude/channel` capability. They communicate with pi over stdio.

### Minimal one-way channel (webhook receiver)

```typescript
#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const mcp = new Server(
  { name: "webhook", version: "0.0.1" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions:
      'Events from the webhook channel arrive as <channel source="webhook" ...>. ' +
      "They are one-way: read them and act, no reply expected.",
  },
);

await mcp.connect(new StdioServerTransport());

Bun.serve({
  port: 8788,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = await req.text();
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: body,
        meta: { path: new URL(req.url).pathname, method: req.method },
      },
    });
    return new Response("ok");
  },
});
```

### Two-way channel (with reply tool)

```typescript
#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mcp = new Server(
  { name: "mychat", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      'Messages arrive as <channel source="mychat" chat_id="...">. ' +
      "Reply with the reply tool, passing the chat_id from the tag.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message back over this channel",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "The conversation to reply in" },
          text: { type: "string", description: "The message to send" },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { chat_id, text } = req.params.arguments as {
      chat_id: string;
      text: string;
    };
    // Send the reply to your chat platform here
    console.error(`Reply to ${chat_id}: ${text}`);
    return { content: [{ type: "text", text: "sent" }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

await mcp.connect(new StdioServerTransport());
```

## Commands

Once the extension is loaded, these commands are available:

| Command | Description |
|---------|-------------|
| `/channels` | List active channels and their status |
| `/channel-start <name>` | Start a channel from config |
| `/channel-stop <name>` | Stop a running channel |

## How it works

1. On session start, the plugin reads `.pi-channels.json` and spawns each requested channel as a subprocess
2. It connects to each channel server as an MCP client over stdio
3. When a channel server sends a `notifications/claude/channel` notification, the message is injected into the pi session as a `<channel>` tag
4. If the channel exposes tools (like `reply`), they are registered as pi tools so the agent can call them
5. Channel server instructions are appended to the system prompt

## Channel protocol

This plugin implements the same channel protocol as Claude Code:

- **Capability**: `claude/channel` (required), `claude/channel/permission` (optional)
- **Notification**: `notifications/claude/channel` with `{ content, meta? }`
- **Permission relay**: `notifications/claude/channel/permission_request` and `notifications/claude/channel/permission`
- **Tools**: Standard MCP tool capability for reply/interaction tools

Any MCP server built for Claude Code channels should work with this plugin.
