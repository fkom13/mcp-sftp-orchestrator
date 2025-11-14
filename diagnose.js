#!/usr/bin/env node

console.error("🔍 Diagnostic MCP Orchestrator\n");

// 1. Tester les imports
console.error("1️⃣ Test des imports...");
try {
    await import("@modelcontextprotocol/sdk/server/mcp.js");
    console.error("   ✅ @modelcontextprotocol/sdk");
} catch (e) {
    console.error("   ❌ @modelcontextprotocol/sdk:", e.message);
    process.exit(1);
}

try {
    await import("zod");
    console.error("   ✅ zod");
} catch (e) {
    console.error("   ❌ zod:", e.message);
    process.exit(1);
}

// 2. Tester config
console.error("\n2️⃣ Test de config...");
try {
    const config = await import("./config.js");
    console.error("   ✅ config.dataDir:", config.default.dataDir);
    console.error("   ✅ config.syncTimeout:", config.default.syncTimeout);
} catch (e) {
    console.error("   ❌ config:", e.message);
    process.exit(1);
}

// 3. Tester queue
console.error("\n3️⃣ Test de queue...");
try {
    const queue = await import("./queue.js");
    console.error("   ✅ queue importée");
    const stats = queue.default.getStats();
    console.error("   ✅ queue.getStats():", JSON.stringify(stats));
} catch (e) {
    console.error("   ❌ queue:", e.message);
    console.error(e.stack);
    process.exit(1);
}

// 4. Tester servers
console.error("\n4️⃣ Test de servers...");
try {
    const servers = await import("./servers.js");
    const list = await servers.default.listServers();
    console.error("   ✅ servers.listServers():", Object.keys(list).length, "serveurs");
} catch (e) {
    console.error("   ❌ servers:", e.message);
    process.exit(1);
}

// 5. Tester un simple serveur MCP
console.error("\n5️⃣ Test d'un serveur MCP minimal...");
try {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { z } = await import("zod");

    const server = new McpServer({
        name: "test",
        version: "1.0.0",
        description: "Test"
    });

    server.registerTool(
        "test",
        {
            title: "Test",
            description: "Test",
            inputSchema: z.object({})
        },
        async () => ({ content: [{ type: "text", text: "OK" }] })
    );

    console.error("   ✅ Serveur MCP minimal fonctionne");
} catch (e) {
    console.error("   ❌ Serveur MCP:", e.message);
    console.error(e.stack);
    process.exit(1);
}

console.error("\n✅ TOUS LES TESTS PASSENT");
console.error("\n📋 Prochaine étape: vérifier server.js ligne par ligne");
process.exit(0);
