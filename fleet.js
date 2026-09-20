/**
 * fleet.js — Diagnostic parallèle du parc (ping SSH + ressources légères).
 */
import queue from './queue.js';
import servers from './servers.js';
import sshPool from './sshPool.js';
import utils from './utils.js';

const PROBE_CMD = `echo OK; date -u +%Y-%m-%dT%H:%M:%SZ; uptime; free -h 2>/dev/null | head -2; df -h / 2>/dev/null | tail -1`;

/**
 * Probe un serveur : latence handshake + commande légère.
 * Retourne { alias, ok, latencyMs, host, user, output?, error?, resources? }
 */
async function probeServer(alias, timeoutMs = 15000) {
    const started = Date.now();
    let connection = null;

    try {
        const serverConfig = await servers.getServer(alias);
        // Vérifier que la clé existe (fail rapide)
        if (serverConfig.keyPath) {
            const fs = await import('fs/promises');
            try {
                await fs.access(serverConfig.keyPath);
            } catch {
                return {
                    alias,
                    ok: false,
                    latencyMs: Date.now() - started,
                    host: serverConfig.host,
                    user: serverConfig.user,
                    port: utils.resolveSshPort(serverConfig),
                    error: `Clé SSH introuvable: ${serverConfig.keyPath}`
                };
            }
        }

        connection = await Promise.race([
            sshPool.getConnection(alias, serverConfig),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Timeout connexion ${timeoutMs}ms`)), timeoutMs)
            )
        ]);

        const latencyMs = Date.now() - started;
        const output = await execOnClient(connection.client, PROBE_CMD, Math.max(5000, timeoutMs - latencyMs));

        return {
            alias,
            ok: true,
            latencyMs,
            host: serverConfig.host,
            user: serverConfig.user,
            port: utils.resolveSshPort(serverConfig),
            output: (output || '').trim().slice(0, 800),
            resources: parseLightResources(output)
        };
    } catch (err) {
        let host = null, user = null, port = 22;
        try {
            const sc = await servers.getServer(alias);
            host = sc.host; user = sc.user; port = utils.resolveSshPort(sc);
        } catch { /* alias inconnu */ }

        return {
            alias,
            ok: false,
            latencyMs: Date.now() - started,
            host,
            user,
            port,
            error: err.message
        };
    } finally {
        if (connection) {
            try { sshPool.releaseConnection(connection.id); } catch { /* ignore */ }
        }
    }
}

function execOnClient(client, cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error(`Timeout exec ${timeoutMs}ms`));
            }
        }, timeoutMs);

        client.exec(cmd, (err, stream) => {
            if (err) {
                clearTimeout(timer);
                if (!settled) { settled = true; reject(err); }
                return;
            }
            let out = '';
            stream.on('data', d => { out += d.toString(); });
            stream.stderr.on('data', d => { out += d.toString(); });
            stream.on('close', (code) => {
                clearTimeout(timer);
                if (settled) return;
                settled = true;
                if (code !== 0 && code !== null) {
                    // Certaines distros n'ont pas free -h : on accepte quand même si OK en tête
                    if (out.includes('OK')) resolve(out);
                    else reject(new Error(`exit ${code}: ${out.slice(0, 200)}`));
                } else {
                    resolve(out);
                }
            });
        });
    });
}

function parseLightResources(output) {
    if (!output) return null;
    const resources = { load: null, disk_use: null, mem_line: null };
    try {
        const loadMatch = output.match(/load average:\s*([0-9.,\s]+)/i);
        if (loadMatch) resources.load = loadMatch[1].trim();
        const lines = output.split('\n');
        const mem = lines.find(l => /^\s*Mem:/i.test(l));
        if (mem) resources.mem_line = mem.trim();
        const disk = lines.find(l => /\/\s*$/.test(l.trim()) || l.includes('%'));
        // dernière ligne df souvent "… 42% /"
        const df = [...lines].reverse().find(l => /\d+%/.test(l) && l.includes('/'));
        if (df) {
            const m = df.match(/(\d+%)/);
            if (m) resources.disk_use = m[1];
        }
    } catch { /* ignore */ }
    return resources;
}

/**
 * Status de tout le parc (ou d'une liste d'alias).
 * options = { aliases?: string[], timeoutMs?: number }
 */
async function fleetStatus(options = {}) {
    const all = await servers.listServers();
    let aliases = options.aliases;

    if (!aliases || aliases.length === 0) {
        aliases = Object.keys(all);
    }

    // Résolution group: / all déjà faite en amont idéalement
    const timeoutMs = options.timeoutMs || 15000;
    queue.log('info', `fleet_status: probe de ${aliases.length} serveur(s)...`);

    const results = await Promise.all(
        aliases.map(alias => probeServer(alias, timeoutMs))
    );

    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);

    return {
        total: results.length,
        online: ok,
        offline: failed.length,
        results: results.sort((a, b) => a.alias.localeCompare(b.alias)),
        failed_aliases: failed.map(r => r.alias),
        timestamp: new Date().toISOString()
    };
}

export default { probeServer, fleetStatus };
