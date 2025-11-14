#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

console.error("🧪 Test MCP Server...");

try {
    const server = new McpServer({
        name: "test-server",
        version: "1.0.0",
        description: "Test"
    });

    console.error("✅ Serveur créé");

    // Test tool simple
    server.registerTool(
        "test_tool",
        {
            title: "Test",
            description: "Un test simple",
            inputSchema: z.object({})
        },
        async () => {
            return { content: [{ type: "text", text: "OK" }] };
        }
    );

    console.error("✅ Tool enregistré");

    // Test tool avec params
    server.registerTool(
        "test_tool_with_params",
        {
            title: "Test avec params",
            description: "Test avec paramètres",
            inputSchema: z.object({
                message: z.string().describe("Un message")
            })
        },
        async (params) => {
            return { content: [{ type: "text", text: params.message }] };
        }
    );

    console.error("✅ Tool avec params enregistré");
    console.error("🎉 Tout fonctionne !");
    process.exit(0);

} catch (error) {
    console.error("❌ ERREUR:", error);
    console.error("Stack:", error.stack);
    process.exit(1);
}
