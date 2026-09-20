/**
 * infraTopology — découverte live read-only et corrélation sémantique
 * domaine → reverse proxy → port → Docker/Compose/service.
 *
 * Aucune donnée secrète n'est collectée. Les probes utilisent uniquement des
 * commandes d'inventaire. Cache court pour éviter de marteler les machines.
 */
import servers from './servers.js';
import sshPool from './sshPool.js';
import queue from './queue.js';
import utils from './utils.js';

const cache = new Map();
const DEFAULT_TTL_MS = 2 * 60 * 1000;

const PROBE_CMD = String.raw`
printf '===META===\n'; hostname 2>/dev/null || true; date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true
printf '===LISTENERS===\n'; (ss -lntH 2>/dev/null || netstat -lnt 2>/dev/null || true) | head -250
printf '===DOCKER===\n'; if command -v docker >/dev/null 2>&1; then docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}' 2>/dev/null | head -250; fi
printf '===PM2===\n'; if command -v pm2 >/dev/null 2>&1; then pm2 jlist 2>/dev/null | head -c 40000; else printf '[]'; fi; printf '\n'
printf '===SYSTEMD===\n'; (systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null || true) | head -120
printf '===NGINX===\n'; if command -v nginx >/dev/null 2>&1; then (sudo -n nginx -T 2>&1 || nginx -T 2>&1 || true) | head -c 180000; fi
`;

function sectionsFromRaw(raw = '') {
  const sections = {};
  let current = 'raw';
  for (const line of String(raw).split('\n')) {
    const marker = line.match(/^===([A-Z0-9_]+)===\s*$/);
    if (marker) {
      current = marker[1].toLowerCase();
      sections[current] = [];
      continue;
    }
    (sections[current] ||= []).push(line);
  }
  return Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.join('\n').trim()]));
}

function parseListeners(text = '') {
  const out = [];
  for (const line of text.split('\n').map(s => s.trim()).filter(Boolean)) {
    const cols = line.split(/\s+/);
    // ss -lntH: State Recv-Q Send-Q Local Peer
    let local = cols.length >= 4 ? cols[3] : null;
    if (!local || !/[:.]\d+$/.test(local.replace(/\]$/, ''))) {
      const candidate = cols.find(c => /:\d+$/.test(c));
      if (candidate) local = candidate;
    }
    if (!local) continue;
    const m = local.match(/^(.*):([0-9]+)$/);
    if (!m) continue;
    out.push({ address: m[1], port: Number(m[2]), raw: line });
  }
  return out.slice(0, 250);
}

function parsePortMappings(ports = '') {
  const mappings = [];
  for (const part of ports.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(?:(.+):)?(\d+)->(\d+)\/(tcp|udp)$/);
    if (m) {
      mappings.push({ hostAddress: m[1] || null, hostPort: Number(m[2]), containerPort: Number(m[3]), protocol: m[4] });
      continue;
    }
    const exposed = part.match(/^(\d+)\/(tcp|udp)$/);
    if (exposed) mappings.push({ hostAddress: null, hostPort: null, containerPort: Number(exposed[1]), protocol: exposed[2] });
  }
  return mappings;
}

function parseDocker(text = '') {
  return text.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
    const [name = '', image = '', status = '', ports = '', composeProject = '', composeService = ''] = line.split('\t');
    return {
      name, image, status, ports,
      composeProject: composeProject || null,
      composeService: composeService || null,
      portMappings: parsePortMappings(ports)
    };
  }).filter(x => x.name).slice(0, 250);
}

function parsePm2(text = '') {
  if (!text || text === '[]') return [];
  try {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return [];
    return list.slice(0, 100).map(p => ({
      name: p.name || null,
      status: p.pm2_env?.status || null,
      pid: p.pid ?? null,
      pm_id: p.pm_id ?? null,
      cwd: p.pm2_env?.pm_cwd || null,
      port: Number(p.pm2_env?.env?.PORT ?? p.pm2_env?.PORT ?? NaN) || null
    }));
  } catch {
    return [{ parseError: true, rawLength: text.length }];
  }
}

function parseSystemd(text = '') {
  return text.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
    const unit = line.split(/\s+/)[0];
    return { unit, raw: line };
  }).filter(x => x.unit).slice(0, 120);
}

function countBraces(line) {
  let open = 0, close = 0, quote = null, escaped = false;
  for (const ch of line) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') open++;
    if (ch === '}') close++;
  }
  return { open, close };
}

function cleanDirectiveValues(line, directive) {
  const idx = line.indexOf(directive);
  if (idx < 0) return [];
  return line.slice(idx + directive.length).replace(/;.*/, '').trim().split(/\s+/).filter(Boolean);
}

function parseNginx(text = '') {
  const serverBlocks = [];
  const upstreams = {};
  const lines = text.split('\n');
  let sourceFile = null;
  let depth = 0;
  let currentServer = null;
  let currentUpstream = null;

  for (const raw of lines) {
    const fileMarker = raw.match(/^# configuration file ([^:]+):/);
    if (fileMarker) sourceFile = fileMarker[1];
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const before = depth;
    if (!currentServer) {
      const sm = line.match(/^server\s*\{/);
      if (sm) currentServer = { file: sourceFile, depth: before + 1, serverNames: [], listens: [], proxyPasses: [], returns: [] };
    }
    if (!currentUpstream) {
      const um = line.match(/^upstream\s+([^\s{]+)\s*\{/);
      if (um) currentUpstream = { name: um[1], depth: before + 1, servers: [], file: sourceFile };
    }

    if (currentServer) {
      if (/^server_name\s+/.test(line)) currentServer.serverNames.push(...cleanDirectiveValues(line, 'server_name'));
      if (/^listen\s+/.test(line)) currentServer.listens.push(...cleanDirectiveValues(line, 'listen'));
      const pm = line.match(/\bproxy_pass\s+([^;]+);/);
      if (pm) currentServer.proxyPasses.push(pm[1].trim());
      const rm = line.match(/^return\s+(\d{3})\s+([^;]+);/);
      if (rm) currentServer.returns.push({ status: Number(rm[1]), target: rm[2].trim() });
    }
    if (currentUpstream) {
      const us = line.match(/^server\s+([^;\s]+)(?:\s+[^;]*)?;/);
      if (us) currentUpstream.servers.push(us[1]);
    }

    const bc = countBraces(line);
    depth += bc.open - bc.close;

    if (currentServer && depth < currentServer.depth) {
      currentServer.serverNames = [...new Set(currentServer.serverNames)].filter(x => x && x !== '_');
      currentServer.listens = [...new Set(currentServer.listens)];
      currentServer.proxyPasses = [...new Set(currentServer.proxyPasses)];
      serverBlocks.push(currentServer);
      currentServer = null;
    }
    if (currentUpstream && depth < currentUpstream.depth) {
      upstreams[currentUpstream.name] = { servers: [...new Set(currentUpstream.servers)], file: currentUpstream.file };
      currentUpstream = null;
    }
  }
  return { serverBlocks, upstreams };
}

function endpointFromTarget(target) {
  if (!target) return null;
  let normalized = target.trim();
  try {
    if (/^https?:\/\//i.test(normalized)) {
      const u = new URL(normalized);
      return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), raw: target };
    }
  } catch { /* fall through */ }
  const simple = normalized.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const m = simple.match(/^\[?([^\]]+?)\]?:([0-9]+)$/);
  if (m) return { host: m[1], port: Number(m[2]), raw: target };
  if (/^[a-zA-Z0-9_.-]+$/.test(simple)) return { host: simple, port: null, raw: target };
  return null;
}

function resolveContainer(endpoint, docker) {
  if (!endpoint?.port) return [];
  const localHosts = new Set(['127.0.0.1','localhost','0.0.0.0','::1','[::1]']);
  const hits = [];
  for (const c of docker) {
    for (const m of c.portMappings) {
      if (localHosts.has(endpoint.host) && m.hostPort === endpoint.port) hits.push({ container: c.name, image: c.image, composeProject: c.composeProject, composeService: c.composeService, via: 'hostPort', hostPort: m.hostPort, containerPort: m.containerPort });
      if (endpoint.host === c.name && m.containerPort === endpoint.port) hits.push({ container: c.name, image: c.image, composeProject: c.composeProject, composeService: c.composeService, via: 'containerDns', containerPort: m.containerPort });
    }
  }
  return hits;
}

function buildDomainGraph(nginx, docker) {
  const byDomain = new Map();
  for (const block of nginx.serverBlocks) {
    for (const domain of block.serverNames) {
      if (!domain || domain.includes('$')) continue;
      let entry = byDomain.get(domain);
      if (!entry) {
        entry = { domain, listens: [], configFiles: [], routes: [], redirects: [] };
        byDomain.set(domain, entry);
      }
      entry.listens.push(...block.listens);
      if (block.file) entry.configFiles.push(block.file);
      entry.redirects.push(...block.returns);
      for (const proxyPass of block.proxyPasses) {
        const ep = endpointFromTarget(proxyPass);
        if (ep && nginx.upstreams[ep.host]) {
          for (const upstreamTarget of nginx.upstreams[ep.host].servers) {
            const upstreamEp = endpointFromTarget(upstreamTarget);
            entry.routes.push({ proxyPass, upstream: ep.host, target: upstreamEp, containers: resolveContainer(upstreamEp, docker) });
          }
        } else {
          entry.routes.push({ proxyPass, target: ep, containers: resolveContainer(ep, docker) });
        }
      }
    }
  }
  return [...byDomain.values()].map(entry => {
    const uniqueRoutes = [];
    const seenRoutes = new Set();
    for (const route of entry.routes) {
      const key = JSON.stringify([route.proxyPass, route.upstream || null, route.target?.host || null, route.target?.port || null]);
      if (!seenRoutes.has(key)) { seenRoutes.add(key); uniqueRoutes.push(route); }
    }
    const uniqueRedirects = [];
    const seenRedirects = new Set();
    for (const redirect of entry.redirects) {
      const key = JSON.stringify(redirect);
      if (!seenRedirects.has(key)) { seenRedirects.add(key); uniqueRedirects.push(redirect); }
    }
    const configFiles = [...new Set(entry.configFiles)];
    return {
      domain: entry.domain,
      listens: [...new Set(entry.listens)],
      configFile: configFiles.length === 1 ? configFiles[0] : null,
      configFiles,
      routes: uniqueRoutes,
      redirects: uniqueRedirects
    };
  }).sort((a, b) => a.domain.localeCompare(b.domain));
}

function parseProbe(raw) {
  const sections = sectionsFromRaw(raw);
  const docker = parseDocker(sections.docker || '');
  const nginx = parseNginx(sections.nginx || '');
  const listeners = parseListeners(sections.listeners || '');
  const pm2 = parsePm2(sections.pm2 || '');
  const systemd = parseSystemd(sections.systemd || '');
  const domains = buildDomainGraph(nginx, docker);
  return {
    meta: (sections.meta || '').split('\n').filter(Boolean),
    listeners,
    docker,
    pm2,
    systemd,
    nginx: { serverBlockCount: nginx.serverBlocks.length, upstreamCount: Object.keys(nginx.upstreams).length, upstreams: nginx.upstreams },
    domains,
    summary: {
      listeners: listeners.length,
      dockerContainers: docker.length,
      composeProjects: new Set(docker.map(c => c.composeProject).filter(Boolean)).size,
      pm2Processes: pm2.filter(x => !x.parseError).length,
      runningSystemdServices: systemd.length,
      nginxServerBlocks: nginx.serverBlocks.length,
      domains: domains.length,
      resolvedDomainRoutes: domains.reduce((n, d) => n + d.routes.filter(r => r.containers?.length).length, 0)
    }
  };
}

async function execProbe(alias, timeoutMs = 25000) {
  const serverConfig = await servers.getServer(alias);
  let connection = null;
  try {
    connection = await sshPool.getConnection(alias, serverConfig);
    const output = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`infra topology timeout ${timeoutMs}ms`)); } }, timeoutMs);
      connection.client.exec(PROBE_CMD, (err, stream) => {
        if (err) { clearTimeout(timer); if (!settled) { settled = true; reject(err); } return; }
        let out = '';
        stream.on('data', d => { if (out.length < 300000) out += d.toString(); });
        stream.stderr.on('data', d => { if (out.length < 300000) out += d.toString(); });
        stream.on('close', () => { clearTimeout(timer); if (!settled) { settled = true; resolve(out); } });
      });
    });
    return parseProbe(output);
  } finally {
    if (connection) sshPool.releaseConnection(connection.id);
  }
}

async function get(alias, { force = false, ttlMs = DEFAULT_TTL_MS, timeoutMs = 25000 } = {}) {
  const cached = cache.get(alias);
  if (!force && cached && Date.now() - cached.at < ttlMs) return { ...cached.data, cached: true, ageSeconds: Math.round((Date.now() - cached.at) / 1000) };
  const sc = await servers.getServer(alias);
  queue.log('info', `infra_topology: probe ${alias}`);
  const parsed = await execProbe(alias, timeoutMs);
  const payload = {
    alias,
    host: sc.host,
    user: sc.user,
    port: utils.resolveSshPort(sc),
    fetchedAt: new Date().toISOString(),
    ...parsed
  };
  cache.set(alias, { at: Date.now(), data: payload });
  return { ...payload, cached: false, ageSeconds: 0 };
}

function clear(alias = null) { if (alias) cache.delete(alias); else cache.clear(); return { cleared: true, alias }; }

export { sectionsFromRaw, parseListeners, parseDocker, parsePm2, parseSystemd, parseNginx, buildDomainGraph, parseProbe };
export default { get, clear, parseProbe };
