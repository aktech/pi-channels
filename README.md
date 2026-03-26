# pi-channels

Channels plugin for the [pi coding agent](https://github.com/aktech/pi-channels) — push events into pi sessions via MCP channel servers. Compatible with the [Claude Code channels](https://code.claude.com/docs/en/channels) protocol.

## Setup

### 1. Install

```bash
pi install npm:pi-channels
```

### 2. Create a Telegram bot

Get a bot token from [@BotFather](https://t.me/BotFather) and set it:

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
```

### 3. Configure

Create `.pi-channels.json` in your project root:

```json
{
  "telegram": {
    "command": "pi-channels-telegram"
  }
}
```

### 4. Run

```bash
pi --channels telegram
```

### 5. Pair

Send any message to your bot on Telegram. The bot replies with a pairing code. In pi, run:

```
/telegram-pair <code>
```

Only paired users can send messages. Pairing codes expire after 5 minutes. The allowlist is persisted at `~/.pi/channels/telegram/allowlist.json`.

## Commands

| Command | Description |
|---------|-------------|
| `/channels` | List active channels and their status |
| `/channel-start <name>` | Start a channel from config |
| `/channel-stop <name>` | Stop a running channel |
| `/telegram-pair <code>` | Pair a Telegram user by code |

## Writing custom channels

See [CHANNELS.md](CHANNELS.md) for how to write your own channel server.
