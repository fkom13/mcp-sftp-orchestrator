import fs from 'fs/promises';
import path from 'path';
import config from './config.js';

const APIS_FILE = path.join(config.dataDir, 'apis.json');

let apis = {};

let isInitialized = false;
let initPromise = null;

// Charger les APIs au démarrage
async function loadApis() {
    try {
        const data = await fs.readFile(APIS_FILE, 'utf-8');
        apis = JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            // Le fichier n'existe pas encore, c'est normal
            apis = {};
        } else {
            console.error("Erreur lors du chargement de apis.json:", err);
        }
    }
}

async function ensureInitialized() {
    if (isInitialized) return;
    if (!initPromise) {
        initPromise = loadApis().then(() => { isInitialized = true; });
    }
    return initPromise;
}

// Sauvegarder les APIs
async function saveApis() {
    await ensureInitialized();
    try {
        await fs.writeFile(APIS_FILE, JSON.stringify(apis, null, 2));
    } catch (err) {
        console.error("Erreur lors de la sauvegarde de apis.json:", err);
    }
}

// Ajouter ou mettre à jour une API
async function addApi(alias, apiConfig) {
    await ensureInitialized();
    apis[alias] = apiConfig;
    await saveApis();
    return { success: true, message: `API '${alias}' ajoutée/mise à jour avec succès.` };
}

// Lister toutes les APIs
async function listApis() {
    await ensureInitialized();
    return apis;
}

// Obtenir une API par son alias
async function getApi(alias) {
    await ensureInitialized();
    const apiConfig = apis[alias];
    if (!apiConfig) {
        throw new Error(`L'alias d'API '${alias}' est inconnu.`);
    }
    return apiConfig;
}

// Supprimer une API
async function removeApi(alias) {
    await ensureInitialized();
    if (!apis[alias]) {
        throw new Error(`L'alias d'API '${alias}' est inconnu.`);
    }
    delete apis[alias];
    await saveApis();
    return { success: true, message: `API '${alias}' supprimée avec succès.` };
}

// Initialiser le module
ensureInitialized();

export default {
    addApi,
    listApis,
    getApi,
    removeApi
};
