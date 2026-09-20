/**
 * Utilitaires partagés (échappement shell, masquage secrets, timeouts, statuts).
 * Extrait pour tests unitaires sans charger le serveur MCP.
 */

const SENSITIVE_KEYS = new Set([
    'password',
    'pass',
    'api_key',
    'apikey',
    'apiKey',
    'htpasswd_pass',
    'htpasswdPass',
    'secret',
    'token',
    'access_token',
    'privateKey',
    'private_key',
    'authorization'
]);

function escapeShellArg(arg) {
    if (typeof arg !== 'string') return String(arg);
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Masque un secret : garde les `visible` derniers caractères.
 * null/undefined/non-string → inchangé.
 */
function maskSecret(value, visible = 4) {
    if (value == null) return value;
    const s = String(value);
    if (s.length === 0) return s;
    if (s.length <= visible) return '***';
    return '***' + s.slice(-visible);
}

/**
 * Clone profond léger et masque les champs sensibles (récursif).
 * Ne mute pas l'objet d'origine.
 */
function redactSensitiveObject(obj, options = {}) {
    const visible = options.visible ?? 4;
    const extraKeys = options.extraKeys || [];
    const keys = new Set([...SENSITIVE_KEYS, ...extraKeys.map(k => k.toLowerCase())]);

    function walk(value, keyName) {
        if (value == null) return value;
        if (Array.isArray(value)) return value.map(v => walk(v, null));
        if (typeof value === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(value)) {
                const lower = k.toLowerCase();
                if (keys.has(lower) || keys.has(k)) {
                    out[k] = typeof v === 'string' || typeof v === 'number'
                        ? maskSecret(v, visible)
                        : (v == null ? v : '***');
                } else {
                    out[k] = walk(v, k);
                }
            }
            return out;
        }
        return value;
    }

    return walk(obj, null);
}

/**
 * Convertit un timeout "secondes utilisateur" en ms pour waitForJobCompletion.
 * - undefined/null → fallbackMs (déjà en ms, ex: config.syncTimeout)
 * - 0 → 0 (attente infinie côté wait)
 * - n > 0 → n * 1000
 */
function toWaitTimeoutMs(timeoutSeconds, fallbackMs) {
    if (timeoutSeconds === 0) return 0;
    if (timeoutSeconds == null || timeoutSeconds === undefined || timeoutSeconds === '') {
        return fallbackMs;
    }
    const n = Number(timeoutSeconds);
    if (!Number.isFinite(n) || n < 0) return fallbackMs;
    return n * 1000;
}

/** Statuts pour lesquels un job n'évoluera plus (fin d'attente hybride). */
function isTerminalJobStatus(status) {
    return status === 'completed'
        || status === 'failed'
        || status === 'partial'
        || status === 'crashed';
}

/**
 * Résout le port SSH depuis une config serveur.
 */
function resolveSshPort(serverConfig) {
    if (!serverConfig) return 22;
    const p = serverConfig.port;
    if (p == null || p === '') return 22;
    const n = Number(p);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? n : 22;
}

/** Patterns heuristiques de commandes destructives (avertissement / dry-run). */
const DESTRUCTIVE_PATTERNS = [
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/i,
    /\brm\s+-rf\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bdrop\s+(database|table)\b/i,
    /\btruncate\s+table\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\buserdel\b/i,
    /\bpasswd\b/i,
    /\bchmod\s+-R\s+000\b/i,
    /\b>\s*\/dev\/sd/i,
    /\biptables\s+-F\b/i,
    /\bsystemctl\s+(stop|disable|mask)\b/i,
    /\bdocker\s+(system\s+prune|rmi|rm\s+-f)\b/i,
    /\bpm2\s+(delete|del|kill)\b/i
];

function isDestructiveCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') return false;
    return DESTRUCTIVE_PATTERNS.some(re => re.test(cmd));
}

/**
 * Refuse l'opération si MCP_READONLY=true.
 * @throws Error
 */
function assertWritable(actionLabel = 'cette opération') {
    // Lazy import-free: caller passes config.readOnly or we read env
    const ro = process.env.MCP_READONLY === 'true' || process.env.MCP_READONLY === '1';
    if (ro) {
        throw new Error(
            `Mode lecture seule (MCP_READONLY=1) : ${actionLabel} est refusé. ` +
            `Relancez le MCP sans MCP_READONLY pour écrire.`
        );
    }
}

/**
 * Compacte un objet pour l'agent (tronque gros champs).
 * options = { maxString=500, maxArray=30, dropKeys=[] }
 */
function compactResult(obj, options = {}) {
    const maxString = options.maxString ?? 500;
    const maxArray = options.maxArray ?? 30;
    const dropKeys = new Set(options.dropKeys || ['diff', 'raw_output', 'content']);

    function walk(v, key) {
        if (v == null) return v;
        if (typeof v === 'string') {
            if (dropKeys.has(key)) return v.length > 80 ? `[omitted ${v.length} chars]` : v;
            return v.length > maxString ? v.slice(0, maxString) + `…[+${v.length - maxString}]` : v;
        }
        if (Array.isArray(v)) {
            const sliced = v.slice(0, maxArray).map((item) => walk(item, null));
            if (v.length > maxArray) sliced.push(`…+${v.length - maxArray} items`);
            return sliced;
        }
        if (typeof v === 'object') {
            const out = {};
            for (const [k, val] of Object.entries(v)) {
                if (dropKeys.has(k) && typeof val === 'string' && val.length > 100) {
                    out[k] = `[omitted ${val.length} chars]`;
                } else {
                    out[k] = walk(val, k);
                }
            }
            return out;
        }
        return v;
    }

    return walk(obj, null);
}

function wantsCompact(params = {}) {
    if (params && params.compact === true) return true;
    if (params && params.compact === false) return false;
    return process.env.MCP_COMPACT === 'true' || process.env.MCP_COMPACT === '1';
}

export {
    escapeShellArg,
    maskSecret,
    redactSensitiveObject,
    toWaitTimeoutMs,
    isTerminalJobStatus,
    resolveSshPort,
    isDestructiveCommand,
    assertWritable,
    compactResult,
    wantsCompact,
    DESTRUCTIVE_PATTERNS,
    SENSITIVE_KEYS
};

export default {
    escapeShellArg,
    maskSecret,
    redactSensitiveObject,
    toWaitTimeoutMs,
    isTerminalJobStatus,
    resolveSshPort,
    isDestructiveCommand,
    assertWritable,
    compactResult,
    wantsCompact
};
