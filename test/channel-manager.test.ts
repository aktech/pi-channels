#!/usr/bin/env npx tsx
/**
 * Integration test for ChannelManager.
 * Spawns test MCP servers and verifies the full channel lifecycle.
 */

import { ChannelManager } from "../src/channel-manager.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVERS = join(__dirname, "servers");

let manager: ChannelManager;
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

async function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

async function run() {
	console.log("ChannelManager integration test\n");

	// ==================================================================
	// Test 1: One-way channel — connection + notification
	// ==================================================================
	console.log("Test 1: One-way channel");
	manager = new ChannelManager();

	await manager.startChannel("one-way", {
		command: "npx",
		args: ["tsx", join(SERVERS, "one-way.ts")],
	});
	assert(manager.hasActiveChannels(), "Channel is active");

	const conn1 = manager.getConnection("one-way")!;
	assert(conn1.tools.length === 0, "No tools on one-way channel");
	assert(conn1.hasPermissionRelay === false, "No permission relay");

	// Listen for notification
	const messages: Array<{ source: string; content: string; meta: Record<string, string> }> = [];
	manager.onMessage((msg) => messages.push(msg));

	// Wait for the server to send its notification (500ms delay + buffer)
	await sleep(2000);

	assert(messages.length > 0, "Received notification");
	if (messages.length > 0) {
		assert(messages[0].source === "one-way", "Source is correct");
		assert(messages[0].content === "hello from one-way", "Content matches");
		assert(messages[0].meta.severity === "info", "Meta matches");
	}

	await manager.stopAll();
	assert(!manager.hasActiveChannels(), "Channels stopped");

	// ==================================================================
	// Test 2: Two-way channel — tools + reply
	// ==================================================================
	console.log("\nTest 2: Two-way channel");
	manager = new ChannelManager();

	await manager.startChannel("two-way", {
		command: "npx",
		args: ["tsx", join(SERVERS, "two-way.ts")],
	});

	const conn2 = manager.getConnection("two-way")!;
	assert(conn2.tools.length === 1, "One tool discovered");
	assert(conn2.tools[0].name === "reply", "Tool is 'reply'");

	// Call reply tool
	const result = await manager.callTool("two-way", "reply", {
		chat_id: "user-1",
		text: "hello back",
	});
	assert(result.content.length > 0, "Reply returned content");
	assert(result.content[0].text === "sent:user-1:hello back", "Reply content correct");

	await manager.stopAll();

	// ==================================================================
	// Test 3: Reject server without claude/channel capability
	// ==================================================================
	console.log("\nTest 3: Reject non-channel server");
	manager = new ChannelManager();

	try {
		await manager.startChannel("plain", {
			command: "npx",
			args: ["tsx", join(SERVERS, "no-channel.ts")],
		});
		assert(false, "Should have rejected server without capability");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		assert(msg.includes("claude/channel"), "Error mentions missing capability");
	}

	assert(!manager.hasActiveChannels(), "No channels active after rejection");

	// ==================================================================
	// Test 4: Duplicate start protection
	// ==================================================================
	console.log("\nTest 4: Duplicate start protection");
	manager = new ChannelManager();

	await manager.startChannel("dup-test", {
		command: "npx",
		args: ["tsx", join(SERVERS, "one-way.ts")],
	});
	try {
		await manager.startChannel("dup-test", {
			command: "npx",
			args: ["tsx", join(SERVERS, "one-way.ts")],
		});
		assert(false, "Should have thrown on duplicate start");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		assert(msg.includes("already running"), "Error mentions already running");
	}
	await manager.stopAll();

	// ==================================================================
	// Test 5: Instructions generation
	// ==================================================================
	console.log("\nTest 5: Instructions generation");
	manager = new ChannelManager();

	await manager.startChannel("test-ch", {
		command: "npx",
		args: ["tsx", join(SERVERS, "two-way.ts")],
	});

	const instructions = manager.getInstructions();
	assert(instructions.includes("test-ch"), "Instructions include channel name");
	assert(instructions.includes("Channels"), "Instructions include header");

	await manager.stopAll();

	// ==================================================================
	// Test 6: Error handling
	// ==================================================================
	console.log("\nTest 6: Error handling");
	manager = new ChannelManager();

	try {
		await manager.callTool("nonexistent", "reply", {});
		assert(false, "Should have thrown");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		assert(msg.includes("not connected"), "Error mentions not connected");
	}

	// ==================================================================
	// Test 7: Multiple channels concurrently
	// ==================================================================
	console.log("\nTest 7: Multiple channels");
	manager = new ChannelManager();

	await manager.startChannel("ch-a", {
		command: "npx",
		args: ["tsx", join(SERVERS, "one-way.ts")],
	});
	await manager.startChannel("ch-b", {
		command: "npx",
		args: ["tsx", join(SERVERS, "two-way.ts")],
	});

	assert(manager.getChannelNames().length === 2, "Two channels active");
	assert(manager.getChannelNames().includes("ch-a"), "ch-a present");
	assert(manager.getChannelNames().includes("ch-b"), "ch-b present");

	// Stop one, verify other remains
	await manager.stopChannel("ch-a");
	assert(manager.getChannelNames().length === 1, "One channel after stopping ch-a");
	assert(manager.getConnection("ch-a") === undefined, "ch-a removed");
	assert(manager.getConnection("ch-b") !== undefined, "ch-b still active");

	await manager.stopAll();

	// ==================================================================
	// Summary
	// ==================================================================
	console.log(`\n${"=".repeat(50)}`);
	console.log(`Results: ${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

run().catch((err) => {
	console.error("Test runner error:", err);
	if (manager) manager.stopAll().catch(() => {});
	process.exit(1);
});
