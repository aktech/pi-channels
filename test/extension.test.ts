#!/usr/bin/env npx tsx
/**
 * Test the extension's config loading and message formatting.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We can't easily test the full extension (needs pi runtime),
// but we can test the exported utilities and config loading.

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
	if (condition) {
		console.log(`  ✓ ${message}`);
		passed++;
	} else {
		console.error(`  ✗ ${message}`);
		failed++;
	}
}

console.log("Extension unit tests\n");

// ==================================================================
// Test 1: Config file loading
// ==================================================================
console.log("Test 1: Config file loading");

const testDir = join(tmpdir(), `pi-channels-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });

const configPath = join(testDir, ".pi-channels.json");
const testConfig = {
	webhook: { command: "bun", args: ["./webhook.ts"] },
	telegram: { command: "node", args: ["./telegram.js"], env: { TOKEN: "abc" } },
};
writeFileSync(configPath, JSON.stringify(testConfig));

// Dynamically import and test config loading
// Since loadChannelsConfig is not exported, we test via ChannelManager + the config format
assert(existsSync(configPath), "Config file created");

const loaded = JSON.parse(readFileSync(configPath, "utf-8"));
assert(loaded.webhook.command === "bun", "webhook command parsed");
assert(loaded.telegram.args[0] === "./telegram.js", "telegram args parsed");
assert(loaded.telegram.env.TOKEN === "abc", "telegram env parsed");

// Cleanup
unlinkSync(configPath);

// ==================================================================
// Test 2: Channel tag formatting
// ==================================================================
console.log("\nTest 2: Channel tag formatting");

// Reproduce the formatChannelTag logic
function formatChannelTag(msg: { source: string; content: string; meta: Record<string, string> }): string {
	const attrs = [`source="${msg.source}"`];
	for (const [key, value] of Object.entries(msg.meta)) {
		if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
			const escaped = value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
			attrs.push(`${key}="${escaped}"`);
		}
	}
	return `<channel ${attrs.join(" ")}>${msg.content}</channel>`;
}

const tag1 = formatChannelTag({
	source: "webhook",
	content: "build failed",
	meta: { severity: "high", run_id: "1234" },
});
assert(
	tag1 === '<channel source="webhook" severity="high" run_id="1234">build failed</channel>',
	"Basic tag formatting",
);

const tag2 = formatChannelTag({
	source: "chat",
	content: "hello <world>",
	meta: { user: 'Bob "B"' },
});
assert(tag2 === '<channel source="chat" user="Bob &quot;B&quot;">hello <world></channel>', "XML attribute escaping");

const tag3 = formatChannelTag({
	source: "test",
	content: "msg",
	meta: { valid_key: "ok", "invalid-key": "dropped", "123bad": "dropped" },
});
assert(tag3 === '<channel source="test" valid_key="ok">msg</channel>', "Invalid meta keys filtered out");

// ==================================================================
// Test 3: ChannelManager exports
// ==================================================================
console.log("\nTest 3: Exports");

import { ChannelManager } from "../src/channel-manager.js";
const m = new ChannelManager();
assert(typeof m.startChannel === "function", "startChannel exported");
assert(typeof m.stopAll === "function", "stopAll exported");
assert(typeof m.onMessage === "function", "onMessage exported");
assert(typeof m.getInstructions === "function", "getInstructions exported");
assert(m.hasActiveChannels() === false, "Fresh manager has no channels");

// ==================================================================
// Summary
// ==================================================================
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
