import path from 'path';
import config from './config.js';
import jsonStore from './atomicJsonStore.js';

const SERVERS_FILE_PATH = path.join(config.dataDir, 'servers.json');
const EMPTY = {};

async function readServers() {
    return jsonStore.readJson(SERVERS_FILE_PATH, EMPTY);
}

async function addServer(alias, serverConfig) {
    let existed = false;
    await jsonStore.updateJson(SERVERS_FILE_PATH, EMPTY, (servers) => {
        existed = !!servers[alias];
        servers[alias] = existed ? { ...servers[alias], ...serverConfig } : serverConfig;
        return servers;
    });
    return { success: true, message: `Serveur '${alias}' ${existed ? 'mis à jour' : 'ajouté'} avec succès.` };
}

async function removeServer(alias) {
    await jsonStore.updateJson(SERVERS_FILE_PATH, EMPTY, (servers) => {
        if (!servers[alias]) throw new Error(`L'alias '${alias}' n'existe pas.`);
        delete servers[alias];
        return servers;
    });
    return { success: true, message: `Serveur '${alias}' supprimé.` };
}

async function listServers() {
    return readServers();
}

async function getServer(alias) {
    const servers = await readServers();
    const serverConfig = servers[alias];
    if (!serverConfig) {
        throw new Error(`L'alias de serveur '${alias}' est inconnu. Utilisez d'abord 'server_list' pour voir les alias disponibles.`);
    }
    return serverConfig;
}

/** true si l'alias est marqué readonly:true dans servers.json */
async function isAliasReadOnly(alias) {
    if (!alias) return false;
    try {
        const sc = await getServer(alias);
        return sc.readonly === true || sc.readOnly === true;
    } catch {
        return false;
    }
}

export default { addServer, removeServer, listServers, getServer, isAliasReadOnly };
