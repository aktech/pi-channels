import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const mcp = new Server({ name: "plain", version: "0.0.1" }, { capabilities: {} });

await mcp.connect(new StdioServerTransport());
