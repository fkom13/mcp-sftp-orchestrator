/**
 * sshTrust.js — Autorisation croisée de clés SSH (pubkey only).
 * Ne copie JAMAIS de clé privée entre serveurs.
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import queue from './queue.js';
import servers from './servers.js';
import sourceAdapter from './sourceAdapter.js';
import utils from './utils.js';

/**
 * Lit une pubkey depuis:
 *  - { type:'string', pubkey }
 *  - { type:'local_path', path }  (fichier .pub)
 *  - { type:'alias', alias }      (keyPath du serveur → .pub à côté ou ssh-keygen -y)
 */
async function resolvePubkey(source) {
    if (!source || !source.type) {
        throw new Error("source requis: {type:'string'|'local_path'|'alias', ...}");
    }

    if (source.type === 'string') {
        const pk = (source.pubkey || source.key || '').trim();
        if (!pk.startsWith('ssh-') && !pk.startsWith('ecdsa-') && !pk.startsWith('sk-')) {
            throw new Error('pubkey invalide (doit commencer par ssh-ed25519 / ssh-rsa / …)');
        }
        return pk.split('\n')[0].trim();
    }

    if (source.type === 'local_path') {
        const p = source.path;
        if (!p) throw new Error('source.path requis pour local_path');
        let content = await fs.readFile(p, 'utf-8');
        // Si c'est une privée, refuse
        if (content.includes('PRIVATE KEY')) {
            // tenter .pub voisin
            const pubPath = p.endsWith('.pub') ? p : p + '.pub';
            try {
                content = await fs.readFile(pubPath, 'utf-8');
            } catch {
                throw new Error(`Refus: ${p} semble une clé privée. Fournissez le .pub`);
            }
        }
        const line = content.trim().split('\n').find(l => l.startsWith('ssh-') || l.startsWith('ecdsa-'));
        if (!line) throw new Error(`Aucune pubkey trouvée dans ${p}`);
        return line.trim();
    }

    if (source.type === 'alias') {
        const sc = await servers.getServer(source.alias);
        if (!sc.keyPath) {
            throw new Error(`Alias '${source.alias}' n'a pas de keyPath (password-only non supporté pour trust).`);
        }
        const pubPath = sc.keyPath.endsWith('.pub') ? sc.keyPath : sc.keyPath + '.pub';
        try {
            const content = await fs.readFile(pubPath, 'utf-8');
            const line = content.trim().split('\n').find(l => l.startsWith('ssh-') || l.startsWith('ecdsa-') || l.startsWith('sk-'));
            if (line) return line.trim();
        } catch {
            // fallback: ssh-keygen -y -f private
        }
        // Générer pubkey depuis privée localement (ne sort pas du MCP host)
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        try {
            const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', sc.keyPath], {
                timeout: 5000,
                env: { ...process.env, SSH_AUTH_SOCK: '' }
            });
            const line = stdout.trim().split('\n')[0];
            if (!line.startsWith('ssh-') && !line.startsWith('ecdsa-')) {
                throw new Error('ssh-keygen -y n\'a pas renvoyé une pubkey valide');
            }
            return line.trim();
        } catch (e) {
            throw new Error(
                `Impossible d'obtenir la pubkey pour '${source.alias}': ${e.message}. ` +
                `Créez ${pubPath} ou passez source.type=string.`
            );
        }
    }

    throw new Error(`source.type inconnu: ${source.type}`);
}

function authorizedKeysPath(userHome, explicitPath) {
    if (explicitPath) return explicitPath;
    return path.posix.join(userHome || '~', '.ssh', 'authorized_keys');
}

/**
 * options:
 *  target_alias, source?, authorized_keys_path?,
 *  source: {type, ...},
 *  comment?, dryRun?, force?
 */
async function authorizeKey(options = {}) {
    const {
        target_alias,
        user = null,
        authorized_keys_path = null,
        source,
        comment = null,
        dryRun = true,
        force = false
    } = options;

    if (!target_alias) throw new Error('target_alias requis');
    const sc = await servers.getServer(target_alias);

    const pubkey = await resolvePubkey(source);
    // Normalise: type + body (+ comment optionnel)
    const parts = pubkey.trim().split(/\s+/);
    const typeBody = parts.slice(0, 2).join(' ');
    const existingComment = parts.slice(2).join(' ');
    const lineToAdd = comment
        ? `${typeBody} ${comment}`
        : (existingComment ? `${typeBody} ${existingComment}` : typeBody);

    // Résoudre home distant
    const homeCmd = user ? `getent passwd ${utils.escapeShellArg(user).replace(/^'|'$/g, '')} 2>/dev/null | cut -d: -f6` : 'echo $HOME';
    // Simpler: use ~ expansion via shell on target for path
    const remoteUser = user || sc.user;
    const akPath = authorized_keys_path
        || `/home/${remoteUser}/.ssh/authorized_keys`;
    // root special case
    const finalAkPath = (remoteUser === 'root' && !authorized_keys_path)
        ? '/root/.ssh/authorized_keys'
        : akPath;

    let existing = '';
    let existed = false;
    try {
        const r = await sourceAdapter.readFile({ type: 'remote', alias: target_alias, path: finalAkPath });
        existing = r.content.toString('utf-8');
        existed = true;
    } catch {
        existing = '';
        existed = false;
    }

    const lines = existing.split('\n').map(l => l.trimEnd());
    const pubCore = pubkey.split(' ').slice(0, 2).join(' ');
    const already = lines.some(l => l.includes(pubCore));

    if (already && !force) {
        return {
            dryRun: !!dryRun,
            applied: false,
            alreadyPresent: true,
            target_alias,
            path: finalAkPath,
            pubkey_fingerprint_hint: pubCore.slice(0, 40) + '…'
        };
    }

    const newContent = already
        ? existing // force re-add skipped if already
        : (existing.trimEnd() + (existing && !existing.endsWith('\n') ? '\n' : '') + lineToAdd + '\n');

    if (dryRun) {
        return {
            dryRun: true,
            applied: false,
            alreadyPresent: already,
            wouldAdd: !already,
            target_alias,
            path: finalAkPath,
            linePreview: lineToAdd.slice(0, 80) + (lineToAdd.length > 80 ? '…' : ''),
            existed
        };
    }

    // Ensure .ssh dir exists via write createDirs
    // Write authorized_keys
    // Also set permissions via a quick exec would be better
    await sourceAdapter.writeFile(
        { type: 'remote', alias: target_alias, path: finalAkPath },
        Buffer.from(newContent, 'utf-8'),
        { createDirs: true }
    );

    // chmod 700 .ssh / 600 authorized_keys
    const sshDir = path.posix.dirname(finalAkPath);
    const { default: ssh } = await import('./ssh.js');
    const job = queue.addJob({
        type: 'ssh',
        alias: target_alias,
        cmd: `mkdir -p ${utils.escapeShellArg(sshDir)} && chmod 700 ${utils.escapeShellArg(sshDir)} && chmod 600 ${utils.escapeShellArg(finalAkPath)}`,
        timeout: 30,
        skip_policy: true,
        status: 'pending'
    });
    // fire and wait briefly
    await ssh.executeCommand(job.id);
    // small poll
    await new Promise(r => setTimeout(r, 500));

    queue.log('info', `ssh_authorize_key: pubkey ajoutée sur ${target_alias}:${finalAkPath}`);

    return {
        dryRun: false,
        applied: true,
        alreadyPresent: already,
        target_alias,
        path: finalAkPath,
        linePreview: lineToAdd.slice(0, 80) + '…'
    };
}

export default { authorizeKey, resolvePubkey };
