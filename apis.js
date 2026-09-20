import path from 'path';
import config from './config.js';
import jsonStore from './atomicJsonStore.js';

const APIS_FILE = path.join(config.dataDir, 'apis.json');
const EMPTY = {};

async function loadApis() {
    return jsonStore.readJson(APIS_FILE, EMPTY);
}

async function addApi(alias, apiConfig) {
    if (!alias || typeof alias !== 'string') throw new Error("L'alias doit être une chaîne non vide.");
    if (!apiConfig.url) throw new Error("L'URL de l'API est obligatoire.");
    try { new URL(apiConfig.url); } catch { throw new Error(`URL invalide: ${apiConfig.url}`); }

    await jsonStore.updateJson(APIS_FILE, EMPTY, (apis) => {
        apis[alias] = apiConfig;
        return apis;
    });
    return { success: true, message: `API '${alias}' ajoutée/mise à jour avec succès.` };
}

async function listApis() {
    return loadApis();
}

async function getApi(alias) {
    const apis = await loadApis();
    const apiConfig = apis[alias];
    if (!apiConfig) throw new Error(`L'alias d'API '${alias}' est inconnu.`);
    return apiConfig;
}

async function removeApi(alias) {
    await jsonStore.updateJson(APIS_FILE, EMPTY, (apis) => {
        if (!apis[alias]) throw new Error(`L'alias d'API '${alias}' est inconnu.`);
        delete apis[alias];
        return apis;
    });
    return { success: true, message: `API '${alias}' supprimée avec succès.` };
}

export default { addApi, listApis, getApi, removeApi };
