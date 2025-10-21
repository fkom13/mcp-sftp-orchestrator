import fs from 'fs/promises';
import path from 'path';
import config from './config.js';
const SERVERS_FILE_PATH = path.join(config.dataDir, 'servers.json');

async function readServers() {
    try {
        await fs.access(SERVERS_FILE_PATH);
        const data = await fs.readFile(SERVERS_FILE_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        // Si le fichier n'existe pas, on retourne un objet vide
        return {};
    }
}

async function writeServers(servers) {
    await fs.writeFile(SERVERS_FILE_PATH, JSON.stringify(servers, null, 2));
}

async function addServer(alias, config) {
    const servers = await readServers();
    if (servers[alias]) {
        // L'alias existe, on le met à jour
        servers[alias] = { ...servers[alias], ...config };
        await writeServers(servers);
        return { success: true, message: `Serveur '${alias}' mis à jour avec succès.` };
    }
    // L'alias n'existe pas, on le crée
    servers[alias] = config;
    await writeServers(servers);
    return { success: true, message: `Serveur '${alias}' ajouté avec succès.` };
}

async function removeServer(alias) {
    const servers = await readServers();
    if (!servers[alias]) {
        throw new Error(`L'alias '${alias}' n'existe pas.`);
    }
    delete servers[alias];
    await writeServers(servers);
    return { success: true, message: `Serveur '${alias}' supprimé.` };
}

async function listServers() {
    return await readServers();
}

async function getServer(alias) {
    const servers = await readServers();
    const serverConfig = servers[alias];
    if (!serverConfig) {
        throw new Error(`L'alias de serveur '${alias}' est inconnu. Utilisez d'abord 'server_list' pour voir les alias disponibles.`);
    }
    return serverConfig;
}

export default { addServer, removeServer, listServers, getServer };
