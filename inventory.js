/**
 * inventory.js — Inventaire léger d'un serveur (cache TTL).
 */
import queue from './queue.js';
import servers from './servers.js';
import sshPool from './sshPool.js';
import utils from './utils.js';

const cache = new Map(); // alias → { at, data }
const DEFAULT_TTL_MS = 10 * 60 * 1000;

const INVENTORY_CMD = [
    'echo "===HOST==="',
    'hostname; whoami; date -u +%Y-%m-%dT%H:%M:%SZ',
    'echo "===UPTIME==="',
    'uptime',
    'echo "===DISK==="',
    'df -h / 2>/dev/null | tail -1',
    'echo "===MEM==="',
    'free -h 2>/dev/null | head -2 || true',
    'echo "===PM2==="',
    'command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | head -c 8000 || echo "[]"',
    'echo "===DOCKER==="',
    'command -v docker >/dev/null && docker ps --format "{{.Names}}|{{.Status}}|{{.Ports}}" 2>/dev/null | head -40 || true',
    'echo "===HOME_TOP==="',
    'ls -1 "$HOME" 2>/dev/null | head -40',
    'echo "===TAILSCALE==="',
    'command -v tailscale >/dev/null && tailscale status --json 2>/dev/null | head -c 2000 || echo "no-tailscale"'
].join('; ');

function parseInventory(raw) {
    const sections = {};
    let current = 'raw';
    for (const line of (raw || '').split('\n')) {
        const m = line.match(/^===([A-Z_]+)===\s*$/);
        if (m) {
            current = m[1].toLowerCase();
            sections[current] = [];
            continue;
        }
        if (!sections[current]) sections[current] = [];
        sections[current].push(line);
    }

    const join = (k) => (sections[k] || []).join('\n').trim();

    let pm2 = [];
    try {
        const pm2Raw = join('pm2');
        if (pm2Raw && pm2Raw !== '[]') {
            const list = JSON.parse(pm2Raw);
            if (Array.isArray(list)) {
                pm2 = list.map(p => ({
                    name: p.name,
                    status: p.pm2_env?.status,
                    pid: p.pid,
                    pm_id: p.pm_id
                })).slice(0, 40);
            }
        }
    } catch {
        pm2 = [{ parse_error: true, raw: join('pm2').slice(0, 200) }];
    }

    const docker = join('docker')
        .split('\n')
        .filter(Boolean)
        .map(line => {
            const [name, status, ports] = line.split('|');
            return { name, status, ports };
        });

    const home_top = join('home_top').split('\n').filter(Boolean);
    const hasTailscale = !join('tailscale').includes('no-tailscale');

    return {
        host: join('host'),
        uptime: join('uptime'),
        disk: join('disk'),
        mem: join('mem'),
        pm2,
        docker,
        home_top,
        tailscale: hasTailscale ? 'present' : 'absent',
        tailscale_raw_len: join('tailscale').length
    };
}

async function execProbe(alias, timeoutMs = 20000) {
    const serverConfig = await servers.getServer(alias);
    let connection = null;
    try {
        connection = await sshPool.getConnection(alias, serverConfig);
        const output = await new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error(`inventory timeout ${timeoutMs}ms`));
                }
            }, timeoutMs);

            connection.client.exec(INVENTORY_CMD, (err, stream) => {
                if (err) {
                    clearTimeout(timer);
                    if (!settled) { settled = true; reject(err); }
                    return;
                }
                let out = '';
                stream.on('data', d => { out += d.toString(); });
                stream.stderr.on('data', d => { out += d.toString(); });
                stream.on('close', () => {
                    clearTimeout(timer);
                    if (!settled) { settled = true; resolve(out); }
                });
            });
        });
        return parseInventory(output);
    } finally {
        if (connection) sshPool.releaseConnection(connection.id);
    }
}

export default {
    async get(alias, { force = false, ttlMs = DEFAULT_TTL_MS } = {}) {
        const cached = cache.get(alias);
        if (!force && cached && (Date.now() - cached.at) < ttlMs) {
            return { alias, cached: true, ageSeconds: Math.round((Date.now() - cached.at) / 1000), ...cached.data };
        }

        queue.log('info', `inventory: probe ${alias}`);
        const sc = await servers.getServer(alias);
        const data = await execProbe(alias);
        const payload = {
            alias,
            host: sc.host,
            user: sc.user,
            port: utils.resolveSshPort(sc),
            ...data,
            fetchedAt: new Date().toISOString()
        };
        cache.set(alias, { at: Date.now(), data: payload });
        return { ...payload, cached: false, ageSeconds: 0 };
    },

    clear(alias = null) {
        if (alias) cache.delete(alias);
        else cache.clear();
        return { cleared: true, alias };
    }
};
