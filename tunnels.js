import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import config from './config.js';
import queue from './queue.js';
import history from './history.js';
import ssh from './ssh.js';


const TUNNELS_PATH = path.join(config.dataDir, 'tunnels.json');
const ALLOWLIST_PATH = path.join(config.dataDir, 'tunnel_allowlist.json');

const DEFAULT_ALLOWLIST = [80, 443, 3000, 8080, 8443, 9090, 3002, 3100, 3102, 4520, 5002, 4001, 51821, 5678, 8081, 8083, 8090];

const LOCAL_TUNNELS = new Map();

async function loadJson(p, def) {
    try { await fs.access(p); return JSON.parse(await fs.readFile(p, 'utf-8')); }
    catch { return def; }
}
async function saveJson(p, data) {
    await fs.writeFile(p, JSON.stringify(data, null, 2));
}

async function loadAllowlist() {
    return await loadJson(ALLOWLIST_PATH, DEFAULT_ALLOWLIST);
}
async function saveAllowlist(list) {
    await saveJson(ALLOWLIST_PATH, list);
}

async function loadRegistry() {
    return await loadJson(TUNNELS_PATH, {});
}
async function saveRegistry(reg) {
    await saveJson(TUNNELS_PATH, reg);
}

async function getSshTarget(alias, serverManager) {
    const cfg = await serverManager.getServer(alias);
    return { host: cfg.host, port: cfg.port || 22, user: cfg.user, keyPath: cfg.keyPath };
}

function spawnLocalSsh(args, name, info) {
    const proc = spawn('ssh', args, { stdio: 'ignore', detached: false });
    LOCAL_TUNNELS.set(name, { process: proc, info });
    proc.on('exit', (code) => {
        LOCAL_TUNNELS.delete(name);
    });
    proc.on('error', () => LOCAL_TUNNELS.delete(name));
    return proc.pid;
}

function buildArgs(type, listenPort, target, via, remoteKeyPath) {
    const args = ['-N', '-o', 'ServerAliveInterval=30', '-o', 'StrictHostKeyChecking=no'];
    if (type !== 'remote') args.push('-o', 'ExitOnForwardFailure=yes');
    switch (type) {
        case 'local': args.push('-L', `${listenPort}:${target}`); break;
        case 'remote': args.push('-R', `${listenPort}:${target}`); break;
        case 'socks': args.push('-D', `${listenPort}`); break;
    }
    args.push('-p', String(via.port), `${via.user}@${via.host}`);
    const keyToUse = remoteKeyPath || via.keyPath;
    if (keyToUse) args.push('-i', keyToUse);
    return args;
}

export default {
    async create(params, serverManager) {
        const { name, type, listen_port, target, via, source, key_path } = params;
        if (!name) throw new Error("Le paramètre 'name' est requis.");
        if (!['local', 'remote', 'socks'].includes(type)) throw new Error("type doit être 'local', 'remote' ou 'socks'");
        if (!listen_port || listen_port < 1 || listen_port > 65535) throw new Error("listen_port invalide");
        if (type !== 'socks' && !target) throw new Error("target requis pour les tunnels local/remote");
        if (listen_port < 1024) throw new Error("Les ports < 1024 nécessitent root. Utilisez un port > 1023.");

        const allowlist = await loadAllowlist();
        if (!allowlist.includes(listen_port)) {
            throw new Error(`Port ${listen_port} non autorisé. Autorisez-le: tunnel_allowlist_add ${listen_port}. Ports autorisés: ${allowlist.join(', ')}`);
        }

        const registry = await loadRegistry();
        if (registry[name]) throw new Error(`Un tunnel nommé '${name}' existe déjà. Fermez-le d'abord.`);

        const viaTarget = await getSshTarget(via, serverManager);

        // Pour les tunnels sur serveur distant, le key_path doit exister SUR ce serveur
        const remoteKeyPath = source ? (key_path || null) : null;
        const args = buildArgs(type, listen_port, target || '', viaTarget, source ? (key_path || null) : null);

        if (!source) {
            const pid = spawnLocalSsh(args, name, { type, listen_port, target, via, source: null });
            registry[name] = { type, listen_port, target, via, source: null, pid, created_at: new Date().toISOString() };
            await saveRegistry(registry);
            const desc = type === 'socks'
                ? `Proxy SOCKS5 sur 127.0.0.1:${listen_port} (via ${via})`
                : `http://127.0.0.1:${listen_port} → ${via}:${target}`;
            return `Tunnel '${name}' créé localement (PID ${pid}). ${desc}\n⚠️  Ne survit pas au redémarrage du MCP.`;
        }

        const sessionName = `tunnel-${name}`;
        const sshCmd = 'ssh ' + args.join(' ');
        const createCmd = `sh -c "tmux new-session -d -s ${sessionName} '${sshCmd}'"`;

        const job = queue.addJob({ type: 'ssh', alias: source, cmd: createCmd, pty: true, timeout: 20, skip_policy: true, status: 'pending' });
        history.logTask(job);
        ssh.executeCommand(job.id);

        const result = await new Promise(resolve => {
            const start = Date.now();
            const poll = () => {
                const j = queue.getJob(job.id);
                if (!j || j.status === 'completed') resolve(j);
                else if (j.status === 'failed') resolve(j);
                else if (Date.now() - start > 30000) resolve({ status: 'failed', error: 'timeout 30s' });
                else setTimeout(poll, 200);
            };
            poll();
        });

        if (!result || result.status === 'failed') {
            const detail = result ? (result.stderr || result.output || result.error || '') : 'job introuvable';
            throw new Error(`Échec création tunnel sur ${source}: ${detail.substring(0, 500)}`);
        }

        registry[name] = { type, listen_port, target, via, source, tmux_session: sessionName, key_path, created_at: new Date().toISOString() };
        await saveRegistry(registry);

        const desc = type === 'socks'
            ? `Proxy SOCKS5 sur ${source}:${listen_port} (via ${via})`
            : `${source}:${listen_port} → ${via}:${target}`;
        return `Tunnel '${name}' créé sur ${source} (session tmux: ${sessionName}). ${desc}\n✅ Persistant (survit au redémarrage du MCP).`;
    },

    async list() {
        const registry = await loadRegistry();
        const alive = [];

        for (const [name, info] of Object.entries(registry)) {
            let status;
            if (!info.source) {
                const local = LOCAL_TUNNELS.get(name);
                status = local && local.process && !local.process.killed ? 'actif' : 'mort (MCP relancé, relancez le tunnel)';
            } else {
                const ckJob = queue.addJob({ type: 'ssh', alias: info.source, cmd: `tmux has-session -t ${info.tmux_session} 2>/dev/null && echo actif || echo mort`, timeout: 10, skip_policy: true, streaming: false, status: 'pending' });
                ssh.executeCommand(ckJob.id);
                await new Promise(r => { const p = () => { const j = queue.getJob(ckJob.id); if (!j || j.status === 'completed' || j.status === 'failed') r(j); else setTimeout(p, 200); }; p(); });
                const j = queue.getJob(ckJob.id);
                status = j && j.output && j.output.trim() === 'actif' ? 'actif' : 'mort';
            }
            alive.push({ name, ...info, status });
        }

        const allowlist = await loadAllowlist();
        return { tunnels: alive, allowlist };
    },

    async close(name, serverManager) {
        const registry = await loadRegistry();
        const info = registry[name];
        if (!info) throw new Error(`Tunnel '${name}' introuvable.`);

        if (!info.source) {
            const local = LOCAL_TUNNELS.get(name);
            if (local && local.process && !local.process.killed) {
                local.process.kill('SIGTERM');
                setTimeout(() => { if (!local.process.killed) local.process.kill('SIGKILL'); }, 2000);
            }
            LOCAL_TUNNELS.delete(name);
        } else {
            const killJob = queue.addJob({ type: 'ssh', alias: info.source, cmd: `tmux kill-session -t ${info.tmux_session} 2>/dev/null; echo OK`, timeout: 10, skip_policy: true, streaming: false, status: 'pending' });
            ssh.executeCommand(killJob.id);
        }

        delete registry[name];
        await saveRegistry(registry);
        return `Tunnel '${name}' fermé.`;
    },

    async allowlistList() {
        return await loadAllowlist();
    },

    async allowlistAdd(port) {
        const list = await loadAllowlist();
        if (!list.includes(port)) list.push(port);
        await saveAllowlist(list);
        return list;
    },

    async allowlistRemove(port) {
        const list = await loadAllowlist();
        const filtered = list.filter(p => p !== port);
        await saveAllowlist(filtered);
        return filtered;
    },

    async restore(servers) {
        const registry = await loadRegistry();
        let restored = 0;
        for (const [name, info] of Object.entries(registry)) {
            if (!info.source) {
                try {
                    const viaTarget = await getSshTarget(info.via, servers);
                    const args = buildArgs(info.type, info.listen_port, info.target || '', viaTarget, false);
                    const pid = spawnLocalSsh(args, name, info);
                    registry[name].pid = pid;
                    restored++;
                } catch { /* silencieux, tunnel perdu */ }
            }
        }
        await saveRegistry(registry);
        return restored;
    },

    shutdown() {
        for (const [name, entry] of LOCAL_TUNNELS) {
            if (entry.process && !entry.process.killed) {
                entry.process.kill('SIGTERM');
            }
        }
        LOCAL_TUNNELS.clear();
    }
};
