# Roadmap MCP Orchestrator — Extension v9.1.0 → v10.0.0 (historique)

> **Release actuelle : 11.8.0.** Ce document conserve la roadmap historique ; voir `CHANGELOG.md` pour l'état courant.

**Date de début** : 31/05/2026  
**Statut historique** : v9.0.1 (stable à l'époque)  
**Protocole** : chaque étape → implémentation → test → validation → snapshot gencodedoc → rendu de main

---

## 🎯 Vision Globale : Orchestrator Pro

**Objectif** : Transformer orchestrator en **l'outil unique** pour gérer toute l'infrastructure Oracle, avec capacités avancées de manipulation de fichiers, comparaison cross-server, sessions shell persistantes, et versioning d'infrastructure.

**Pourquoi ne pas utiliser portal-mcp-server ?**
- ❌ Créerait de la redondance (2 pools SSH, 2 systèmes SFTP)
- ❌ Perd le monitoring, diagnostics, et queue existants
- ❌ Fragmente l'écosystème
- ✅ Orchestrator a déjà 80% de l'infrastructure nécessaire
- ✅ ssh2 (Node.js) peut TOUT faire (le langage n'est PAS une limitation)

---

## 🏗️ Principe Architectural Fondamental : Local + Remote Unifié

**Décision de design clé** : Tous les outils de manipulation de fichiers (read/write/edit/diff/snapshot) supportent **localhost sans SSH** ET **remote via SFTP**, de manière transparente.

### Le Problème Résolu
Avant, orchestrator forçait à passer par SSH même pour le PC local :
- Pour lire un fichier local → il fallait configurer un alias SSH localhost (lourd, absurde)
- Pour comparer local vs distant → deux workflows séparés

### La Solution : `sourceAdapter.js`
Un module d'abstraction unique qui détecte le type de source :

```javascript
// Source LOCALE (utilise fs directement, ZÉRO SSH)
{ type: 'local', path: '/home/fkomp/.bashrc' }

// Source REMOTE (utilise SFTP via pool)
{ type: 'remote', alias: 'vpsparfait', path: '/etc/nginx/nginx.conf' }
```

### Impact sur Chaque Étape

| Étape | Support Local | Support Remote | Cas Cross |
|-------|:-------------:|:--------------:|-----------|
| 7 — File Ops | ✅ (fs direct) | ✅ (SFTP) | Lire local → écrire remote |
| 8 — Diff | ✅ | ✅ | Diff local ↔ remote |
| 9 — Shell Sessions | ⚠️ N/A* | ✅ | — |
| 10 — Snapshots | ✅ | ✅ | Snapshot remote → restore local |

*_Shell Sessions : localhost utilise les outils natifs (`bash`), pas besoin de session SSH._

### Bénéfices
- ✅ **Cohérence** : une seule API pour local et remote
- ✅ **Performance** : pas d'overhead SSH pour localhost
- ✅ **Puissance** : diff/snapshot cross (local ↔ prod) natif
- ✅ **Zéro config** : localhost ne nécessite aucun setup SSH

---

## Étape 7 : File Operations — Read/Write/Edit (v9.1.0)

**Objectif** : Ajouter des outils de manipulation de fichiers distants avec protection par hash et génération de diff.

### Contexte
Actuellement, orchestrator ne peut que transférer des fichiers via SFTP (`task_transfer`). Pour éditer un fichier distant, il faut :
1. Le télécharger localement
2. L'éditer
3. Le re-uploader

Ce workflow est lourd et ne permet pas de détecter les modifications concurrentes (race condition).

### Architecture

**Principe clé** : Tous les outils doivent supporter **local ET remote** sans SSH pour localhost.

Créer deux nouveaux modules :

1. **`modules/sourceAdapter.js`** : Abstraction local/remote
   - Détecte automatiquement `type: 'local'` vs `type: 'remote'`
   - Pour local : utilise `fs` directement (pas de SSH)
   - Pour remote : utilise SFTP via pool de connexions

2. **`modules/fileOps.js`** : Opérations fichiers de haut niveau
   - **Read** : télécharger + calculer hash SHA-256
   - **Write** : écrire directement (pour nouveaux fichiers)
   - **Edit** : read + diff + write avec vérification hash
   - S'appuie sur sourceAdapter pour transparence local/remote

### Tâches

#### 1. Créer le module `modules/sourceAdapter.js`
```javascript
import fs from 'fs/promises';
import path from 'path';
import SftpClient from 'ssh2-sftp-client';
import sshPool from './sshPool.js';

// Abstraction unifiée local/remote
export default {
  async readFile(source) {
    if (source.type === 'local') {
      const content = await fs.readFile(source.path, 'utf8');
      const stat = await fs.stat(source.path);
      return { content, mtime: stat.mtimeMs, size: stat.size };
    } else {
      // Remote via SFTP
      const conn = await sshPool.getConnection(source.alias, source.config);
      const sftp = new SftpClient();
      await sftp.connect({ sock: conn.client._sock });
      const content = await sftp.get(source.path);
      const stat = await sftp.stat(source.path);
      await sftp.end();
      sshPool.releaseConnection(conn.id);
      return { content: content.toString(), mtime: stat.mtime, size: stat.size };
    }
  },
  
  async writeFile(source, content) {
    if (source.type === 'local') {
      await fs.mkdir(path.dirname(source.path), { recursive: true });
      await fs.writeFile(source.path, content, 'utf8');
      const stat = await fs.stat(source.path);
      return { size: stat.size };
    } else {
      // Remote via SFTP
      const conn = await sshPool.getConnection(source.alias, source.config);
      const sftp = new SftpClient();
      await sftp.connect({ sock: conn.client._sock });
      await sftp.put(Buffer.from(content), source.path);
      const stat = await sftp.stat(source.path);
      await sftp.end();
      sshPool.releaseConnection(conn.id);
      return { size: stat.size };
    }
  },
  
  async listDir(source) {
    if (source.type === 'local') {
      return fs.readdir(source.path);
    } else {
      const conn = await sshPool.getConnection(source.alias, source.config);
      const sftp = new SftpClient();
      await sftp.connect({ sock: conn.client._sock });
      const list = await sftp.list(source.path);
      await sftp.end();
      sshPool.releaseConnection(conn.id);
      return list;
    }
  },
  
  async stat(source) {
    if (source.type === 'local') {
      return fs.stat(source.path);
    } else {
      const conn = await sshPool.getConnection(source.alias, source.config);
      const sftp = new SftpClient();
      await sftp.connect({ sock: conn.client._sock });
      const stat = await sftp.stat(source.path);
      await sftp.end();
      sshPool.releaseConnection(conn.id);
      return stat;
    }
  }
};
```

#### 2. Créer le module `modules/fileOps.js`
```javascript
import crypto from 'crypto';
import { diffLines } from 'diff'; // npm install diff
import sourceAdapter from './sourceAdapter.js';

export default {
  async readFile(source) {
    const { content, mtime, size } = await sourceAdapter.readFile(source);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return { content, hash, mtime, size };
  },
  
  async writeFile(source, content) {
    await sourceAdapter.writeFile(source, content);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return { hash, size: Buffer.byteLength(content) };
  },
  
  async editFile(source, newContent, expectedHash) {
    // Read current file
    const current = await this.readFile(source);
    
    // Verify hash
    if (current.hash !== expectedHash) {
      throw new Error(`File modified externally. Expected hash: ${expectedHash}, actual: ${current.hash}`);
    }
    
    // Generate diff
    const diff = diffLines(current.content, newContent);
    const unifiedDiff = diff.map(part => {
      const prefix = part.added ? '+' : part.removed ? '-' : ' ';
      return part.value.split('\n').map(line => prefix + line).join('\n');
    }).join('\n');
    
    // Write new content
    const result = await this.writeFile(source, newContent);
    
    return { hash: result.hash, diff: unifiedDiff, applied: true };
  }
};
```

#### 3. Ajouter les outils MCP dans `server.js`

**Schema source unifié :**
```javascript
const sourceSchema = z.object({
  type: z.enum(['local', 'remote']),
  path: z.string().describe("Chemin absolu du fichier"),
  alias: z.string().optional().describe("Requis si type='remote', alias du serveur")
}).refine(data => data.type === 'local' || data.alias, {
  message: "alias est requis quand type='remote'"
});
```

**Outil 1 : `file_read`**
```javascript
server.registerTool(
  "file_read",
  {
    title: "Lire un fichier (local ou distant)",
    description: "Lit un fichier et retourne son contenu avec hash de protection. Supporte localhost (sans SSH) et remote (via SFTP).",
    inputSchema: z.object({
      source: sourceSchema,
      encoding: z.enum(['utf8', 'base64']).optional().default('utf8')
    })
  },
  async (params) => {
    try {
      const serverConfig = params.source.type === 'remote' 
        ? await servers.getServer(params.source.alias) 
        : null;
      
      const source = { ...params.source, config: serverConfig };
      const result = await fileOps.readFile(source);
      
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify(result, null, 2) 
        }] 
      };
    } catch (e) {
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            toolName: "file_read", 
            errorCode: "READ_ERROR", 
            errorMessage: e.message 
          }, null, 2) 
        }], 
        isError: true 
      };
    }
  }
);
```

**Outil 2 : `file_write`**
```javascript
server.registerTool(
  "file_write",
  {
    title: "Écrire un fichier (local ou distant)",
    description: "Crée ou écrase un fichier. Supporte localhost (sans SSH) et remote (via SFTP).",
    inputSchema: z.object({
      source: sourceSchema,
      content: z.string(),
      encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
      createDirs: z.boolean().optional().default(true)
    })
  },
  async (params) => {
    try {
      const serverConfig = params.source.type === 'remote' 
        ? await servers.getServer(params.source.alias) 
        : null;
      
      const source = { ...params.source, config: serverConfig };
      const result = await fileOps.writeFile(source, params.content);
      
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify(result, null, 2) 
        }] 
      };
    } catch (e) {
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            toolName: "file_write", 
            errorCode: "WRITE_ERROR", 
            errorMessage: e.message 
          }, null, 2) 
        }], 
        isError: true 
      };
    }
  }
);
```

**Outil 3 : `file_edit`**
```javascript
server.registerTool(
  "file_edit",
  {
    title: "Éditer un fichier avec protection (local ou distant)",
    description: "Édite un fichier en vérifiant qu'il n'a pas été modifié entre-temps (via hash). Génère un diff unifié.",
    inputSchema: z.object({
      source: sourceSchema,
      newContent: z.string(),
      expectedHash: z.string().describe("Hash SHA-256 du fichier lu précédemment via file_read")
    })
  },
  async (params) => {
    try {
      const serverConfig = params.source.type === 'remote' 
        ? await servers.getServer(params.source.alias) 
        : null;
      
      const source = { ...params.source, config: serverConfig };
      const result = await fileOps.editFile(source, params.newContent, params.expectedHash);
      
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify(result, null, 2) 
        }] 
      };
    } catch (e) {
      if (e.message.includes('modified externally')) {
        // Hash mismatch - return current content for user review
        const current = await fileOps.readFile({ ...params.source, config: serverConfig });
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              toolName: "file_edit", 
              errorCode: "HASH_MISMATCH", 
              errorMessage: e.message,
              currentHash: current.hash,
              currentContent: current.content
            }, null, 2) 
          }], 
          isError: true 
        };
      }
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            toolName: "file_edit", 
            errorCode: "EDIT_ERROR", 
            errorMessage: e.message 
          }, null, 2) 
        }], 
        isError: true 
      };
    }
  }
);
```

#### 4. Tests

**Tests Localhost (sans SSH) :**
- Lire un fichier local → vérifier hash cohérent
- Écrire un nouveau fichier local → vérifier création
- Éditer fichier local avec bon hash → vérifier diff généré
- Éditer fichier local avec mauvais hash → vérifier erreur de protection
- Test avec fichier binaire local (base64)

**Tests Remote (via SFTP) :**
- Lire un fichier distant → vérifier hash cohérent
- Écrire un nouveau fichier distant → vérifier création
- Éditer fichier distant avec bon hash → vérifier diff généré
- Éditer fichier distant avec mauvais hash → vérifier erreur de protection
- Test avec fichier binaire distant (base64)

**Tests Cross (local ↔ remote) :**
- Lire local → éditer → écrire remote
- Lire remote → éditer → écrire local
- Vérifier que sourceAdapter détecte correctement le type

#### 4. Documentation
- Ajouter les 3 outils dans README.md
- Workflow recommandé : `file_read_remote` → modifier → `file_edit_remote`
- Exemple d'usage avec Hermes

### Dépendances
```json
{
  "diff": "^5.1.0"
}
```

### Validation
- Tests unitaires pour fileOps.js
- Tests d'intégration avec un serveur test
- Vérifier que les hash SHA-256 sont cohérents
- Vérifier que la protection contre modifications concurrentes fonctionne

### Durée estimée
**6 heures** (2h module + 2h tools + 1h tests + 1h doc)

---

## Étape 8 : Cross-Server Diff Engine (v9.2.0)

**Objectif** : Comparer des fichiers et dossiers entre n'importe quelles sources (local ↔ local, local ↔ remote, remote ↔ remote).

### Contexte
Cas d'usage critiques :
- **Remote vs Remote** : Comparer configs Nginx entre vpsparfait et vpsparfait2
- **Local vs Remote** : Détecter drift entre code local (`/home/fkomp/Bureau/chatbot-p/`) et production (`/home/ubuntu/vera/`)
- **Local vs All Servers** : Vérifier qu'un fichier local correspond à tous les VPS
- **Local vs Local** : Comparer deux versions locales d'un fichier
- **Remote vs All Servers** : Vérifier que tous les VPS ont la même version d'un service systemd

### Architecture
Créer deux nouveaux modules qui s'appuient sur `sourceAdapter.js` pour transparence local/remote :
- `modules/diffEngine.js` : comparaison fichier à fichier (local/remote/cross)
- `modules/compareEngine.js` : comparaison de structures (dossiers, patterns, all-servers)

**Principe** : Tous les outils acceptent des sources avec `type: 'local'` ou `type: 'remote'`, sans distinction dans l'API.

### Tâches

#### 1. Créer `modules/diffEngine.js`
```javascript
import { diffLines } from 'diff';
import sourceAdapter from './sourceAdapter.js';
import fileOps from './fileOps.js';

export default {
  async diffFiles(source1, source2) {
    // source1/source2 = { type: 'local'|'remote', path, alias?, config? }
    // Read both files using sourceAdapter
    const file1 = await fileOps.readFile(source1);
    const file2 = await fileOps.readFile(source2);
    
    // Check if identical by hash
    if (file1.hash === file2.hash) {
      return { 
        identical: true, 
        hash: file1.hash,
        stats: { source1Size: file1.size, source2Size: file2.size }
      };
    }
    
    // Generate unified diff
    const diff = diffLines(file1.content, file2.content);
    const unifiedDiff = this.formatUnifiedDiff(diff, source1.path, source2.path);
    
    return { 
      identical: false,
      diff: unifiedDiff,
      stats: { 
        source1Hash: file1.hash, 
        source2Hash: file2.hash,
        source1Size: file1.size, 
        source2Size: file2.size 
      }
    };
  },
  
  async diffFolders(source1, source2, options = {}) {
    // options = { recursive: true, ignorePatterns: [], compareContent: true }
    const list1 = await this.listFilesRecursive(source1, options);
    const list2 = await this.listFilesRecursive(source2, options);
    
    // Categorize files
    const only_in_source1 = list1.filter(f => !list2.includes(f));
    const only_in_source2 = list2.filter(f => !list1.includes(f));
    const common = list1.filter(f => list2.includes(f));
    
    // Compare common files by content if requested
    const identical = [];
    const modified = [];
    
    if (options.compareContent) {
      for (const relativePath of common) {
        const file1 = await fileOps.readFile({ 
          ...source1, 
          path: `${source1.path}/${relativePath}` 
        });
        const file2 = await fileOps.readFile({ 
          ...source2, 
          path: `${source2.path}/${relativePath}` 
        });
        
        if (file1.hash === file2.hash) {
          identical.push(relativePath);
        } else {
          modified.push({ 
            path: relativePath, 
            hash1: file1.hash, 
            hash2: file2.hash 
          });
        }
      }
    }
    
    return { 
      only_in_source1, 
      only_in_source2, 
      identical, 
      modified,
      stats: {
        totalSource1: list1.length,
        totalSource2: list2.length
      }
    };
  },
  
  formatUnifiedDiff(diff, path1, path2) {
    let result = `--- ${path1}\n+++ ${path2}\n`;
    diff.forEach(part => {
      const prefix = part.added ? '+' : part.removed ? '-' : ' ';
      part.value.split('\n').forEach(line => {
        if (line) result += prefix + line + '\n';
      });
    });
    return result;
  },
  
  async listFilesRecursive(source, options) {
    // Implementation depends on sourceAdapter.listDir()
    // Returns array of relative paths
  }
};
```

#### 2. Créer `modules/compareEngine.js`
```javascript
import fileOps from './fileOps.js';
import crypto from 'crypto';

export default {
  async compareAllServers(filepath, sources) {
    // sources = [{type, path, alias?}] - can include local sources
    const results = [];
    
    for (const source of sources) {
      try {
        const file = await fileOps.readFile(source);
        results.push({
          source: source.type === 'local' ? 'localhost' : source.alias,
          hash: file.hash,
          size: file.size,
          content: file.content,
          success: true
        });
      } catch (e) {
        results.push({
          source: source.type === 'local' ? 'localhost' : source.alias,
          error: e.message,
          success: false
        });
      }
    }
    
    // Group by hash
    const groups = {};
    results.forEach(r => {
      if (r.success) {
        if (!groups[r.hash]) {
          groups[r.hash] = { hash: r.hash, sources: [], content: r.content, size: r.size };
        }
        groups[r.hash].sources.push(r.source);
      }
    });
    
    const drift = Object.keys(groups).length > 1;
    const errors = results.filter(r => !r.success);
    
    return { 
      groups: Object.values(groups), 
      drift, 
      errors,
      stats: {
        totalSources: sources.length,
        successfulReads: results.filter(r => r.success).length,
        uniqueVersions: Object.keys(groups).length
      }
    };
  },
  
  async compareFolderStructure(sources, options) {
    // Compare folder structures (tree only, no content)
    // sources can include local and remote
    // Return differences in structure
  }
};
```

#### 3. Ajouter les outils MCP

**Outil 1 : `diff_files`**
```javascript
server.registerTool(
  "diff_files",
  {
    title: "Comparer deux fichiers",
    description: "Génère un diff unifié entre deux fichiers (local/remote, n'importe quelle combinaison).",
    inputSchema: z.object({
      source1: sourceSchema,
      source2: sourceSchema,
      format: z.enum(['unified', 'side-by-side', 'summary']).optional().default('unified')
    })
  },
  async (params) => {
    try {
      // Resolve server configs if remote
      const config1 = params.source1.type === 'remote' 
        ? await servers.getServer(params.source1.alias) 
        : null;
      const config2 = params.source2.type === 'remote' 
        ? await servers.getServer(params.source2.alias) 
        : null;
      
      const s1 = { ...params.source1, config: config1 };
      const s2 = { ...params.source2, config: config2 };
      
      const result = await diffEngine.diffFiles(s1, s2);
      
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify(result, null, 2) 
        }] 
      };
    } catch (e) {
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            toolName: "diff_files", 
            errorCode: "DIFF_ERROR", 
            errorMessage: e.message 
          }, null, 2) 
        }], 
        isError: true 
      };
    }
  }
);
```

**Outil 2 : `diff_folders`**
```javascript
server.registerTool(
  "diff_folders",
  {
    title: "Comparer deux dossiers",
    description: "Compare les arborescences de deux dossiers (local/remote, n'importe quelle combinaison).",
    inputSchema: z.object({
      source1: sourceSchema,
      source2: sourceSchema,
      recursive: z.boolean().optional().default(true),
      compareContent: z.boolean().optional().default(true),
      ignorePatterns: z.array(z.string()).optional().describe("Patterns glob à ignorer (ex: ['*.log', 'node_modules'])")
    })
  },
  async (params) => {
    try {
      const config1 = params.source1.type === 'remote' 
        ? await servers.getServer(params.source1.alias) 
        : null;
      const config2 = params.source2.type === 'remote' 
        ? await servers.getServer(params.source2.alias) 
        : null;
      
      const s1 = { ...params.source1, config: config1 };
      const s2 = { ...params.source2, config: config2 };
      
      const options = {
        recursive: params.recursive,
        compareContent: params.compareContent,
        ignorePatterns: params.ignorePatterns || []
      };
      
      const result = await diffEngine.diffFolders(s1, s2, options);
      
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify(result, null, 2) 
        }] 
      };
    } catch (e) {
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            toolName: "diff_folders", 
            errorCode: "DIFF_ERROR", 
            errorMessage: e.message 
          }, null, 2) 
        }], 
        isError: true 
      };
    }
  }
);
```

**Outil 3 : `compare_all_sources`**
```javascript
server.registerTool(
  "compare_all_sources",
  {
    title: "Comparer un fichier sur plusieurs sources",
    description: "Vérifie si le même fichier est identique sur plusieurs sources (localhost + serveurs distants). Détecte les drifts.",
    inputSchema: z.object({
      sources: z.array(sourceSchema).min(2).describe("Liste de sources à comparer (local et/ou remote)")
    })
  },
  async (params) => {
    try {
      // Resolve configs for remote sources
      const sources = await Promise.all(params.sources.map(async (source) => {
        if (source.type === 'remote') {
          const config = await servers.getServer(source.alias);
          return { ...source, config };
        }
        return source;
      }));
      
      const result = await compareEngine.compareAllServers(params.sources[0].path, sources);
      
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify(result, null, 2) 
        }] 
      };
    } catch (e) {
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            toolName: "compare_all_sources", 
            errorCode: "COMPARE_ERROR", 
            errorMessage: e.message 
          }, null, 2) 
        }], 
        isError: true 
      };
    }
  }
);
```

#### 4. Tests

**Tests Local ↔ Local :**
- Diff entre deux fichiers locaux
- Diff entre deux dossiers locaux avec detection ajoutés/supprimés/modifiés
- Compare_all_sources avec uniquement des sources locales

**Tests Local ↔ Remote :**
- Diff fichier local vs fichier distant
- Diff dossier local vs dossier distant avec ignorePatterns
- Compare_all_sources mixte (localhost + 2 serveurs distants)

**Tests Remote ↔ Remote :**
- Diff entre fichiers sur deux serveurs distants différents
- Diff entre dossiers sur deux serveurs distants
- Compare d'un fichier sur 4 VPS → détecter lequel diffère

**Tests Edge Cases :**
- Source inexistante (local ou remote)
- Permissions insuffisantes
- Fichier binaire vs fichier texte
- Très gros fichiers (>10MB)

### Validation
- **Local vs Remote** : Comparer `/home/fkomp/Bureau/chatbot-p/` (local) vs `/home/ubuntu/vera/` (fkomprodmini1)
- **Remote vs Remote** : Comparer `/etc/nginx/nginx.conf` entre vpsparfait et vpsparfait2
- **All Sources** : Vérifier que `/etc/systemd/system/proxy-navy.service` est identique sur localhost + tous les VPS
- Vérifier que le grouping par hash fonctionne correctement
- Vérifier que ignorePatterns fonctionne (`node_modules`, `*.log`)

### Durée estimée
**8 heures** (3h diffEngine + 3h compareEngine + 2h tests/doc)

---

## Étape 9 : Shell Sessions Persistantes (v9.3.0)

**Objectif** : Implémenter de vraies sessions shell persistantes **sur serveurs distants** où `cd`, `export`, et autres commandes d'état persistent entre les exécutions.

**Note** : Cette fonctionnalité est **uniquement pour remote** car localhost peut utiliser les outils natifs (`bash`, `Shell`, etc.) directement sans SSH.

### Contexte Technique

**Problème actuel :**
```javascript
// ssh.js ligne 141
client.exec(cmdToExecute, ...)
```
→ Chaque `exec()` crée un **nouveau shell** → aucune persistance d'état.

**Solution :**
```javascript
client.shell((err, stream) => {
  // Ce stream est un vrai shell PTY persistant
  stream.write('cd /var/www\n');
  stream.write('export DEBUG=true\n');
  stream.write('pwd\n'); // → affichera /var/www
});
```

### Architecture

Créer `modules/shellSessions.js` :
```javascript
class ShellSessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId → { stream, buffer, alias, createdAt }
  }
  
  async createSession(alias, serverConfig) {
    // Get connection from pool
    // Create shell with PTY
    // Setup output buffering
    // Return sessionId
  }
  
  async execInSession(sessionId, command) {
    // Write command to stream
    // Wait for prompt
    // Return output since last command
  }
  
  async closeSession(sessionId) {
    // Close stream
    // Release connection
  }
}
```

### Tâches

#### 1. Créer `modules/shellSessions.js`

**Défis techniques :**
- Détecter le prompt du shell (PS1) → utiliser un marqueur unique
- Distinguer l'output de la commande vs le prompt
- Gérer les timeouts (commande longue vs commande bloquée)
- Gérer les erreurs sans couper la session

**Solution : Shell Marker Technique**
```javascript
async execInSession(sessionId, command) {
  const session = this.sessions.get(sessionId);
  const marker = `__ORCHSHELL_${Date.now()}__`;
  
  // Clear buffer
  session.buffer = '';
  
  // Execute: command ; echo MARKER
  session.stream.write(`${command} ; echo ${marker}\n`);
  
  // Wait for marker in output
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Command timeout'));
    }, session.timeout);
    
    session.stream.on('data', (data) => {
      session.buffer += data.toString();
      if (session.buffer.includes(marker)) {
        clearTimeout(timeout);
        const output = session.buffer.split(marker)[0].trim();
        resolve({ output, success: true });
      }
    });
  });
}
```

#### 2. Ajouter les outils MCP

**Outil 1 : `shell_create`**
```javascript
server.registerTool(
  "shell_create",
  {
    title: "Créer une session shell persistante",
    description: "Ouvre un shell PTY persistant où cd, export, etc. persistent entre les commandes.",
    inputSchema: z.object({
      alias: z.string(),
      workdir: z.string().optional().describe("Répertoire de démarrage"),
      env: z.record(z.string()).optional().describe("Variables d'environnement"),
      timeout: z.number().optional().default(300)
    })
  },
  async (params) => {
    // Create session
    // If workdir → cd workdir
    // If env → export each variable
    // Return { sessionId, ready: true }
  }
);
```

**Outil 2 : `shell_exec`**
```javascript
server.registerTool(
  "shell_exec",
  {
    title: "Exécuter dans une session shell",
    description: "Exécute une commande dans une session shell existante (l'état persiste).",
    inputSchema: z.object({
      sessionId: z.string(),
      command: z.string()
    })
  },
  async (params) => {
    // Use shellSessions.execInSession()
    // Return { output, exitCode }
  }
);
```

**Outil 3 : `shell_list`**
```javascript
server.registerTool(
  "shell_list",
  {
    title: "Lister les sessions shell actives",
    description: "Affiche toutes les sessions shell en cours avec leur état.",
    inputSchema: z.object({})
  },
  async () => {
    // List all sessions
    // Return { sessions: [{id, alias, age, commands_count}] }
  }
);
```

**Outil 4 : `shell_close`**
```javascript
server.registerTool(
  "shell_close",
  {
    title: "Fermer une session shell",
    description: "Termine proprement une session shell persistante.",
    inputSchema: z.object({
      sessionId: z.string()
    })
  },
  async (params) => {
    // Close session
    // Return { closed: true }
  }
);
```

#### 3. Tests
- Créer session → cd /tmp → pwd → vérifier /tmp
- Créer session → export VAR=test → echo $VAR → vérifier test
- Créer session → commande longue (sleep 10) → vérifier timeout
- Fermer session → vérifier cleanup

### Validation
- Test avec workflow Docker : cd /project → docker build . → cd .. → vérifier état
- Test avec workflow Node : cd /app → npm install → npm run build
- Vérifier que les connexions sont bien libérées après close

### Durée estimée
**10 heures** (4h shellSessions.js + 3h tools + 2h tests + 1h doc)

---

## Étape 10 : Infrastructure Snapshots (v10.0.0)

**Objectif** : Versioning de l'infrastructure style gencodedoc — snapshots, diff, restore de configurations critiques (local ET remote).

### Contexte
Cas d'usage :
- **Remote** : Snapshot de `/etc/nginx/` sur vpsparfait avant modification
- **Remote** : Snapshot de tous les systemd services d'un VPS avant mise à jour
- **Local** : Snapshot de `/home/fkomp/Bureau/chatbot-p/` avant un refactor majeur
- **Cross** : Comparer snapshot local vs snapshot distant pour détecter drift
- **Restore Remote** : Restaurer config après problème sur VPS
- **Restore Local** : Restaurer version locale après test raté

### Architecture

Créer `modules/snapshotManager.js` + database SQLite qui s'appuie sur `sourceAdapter.js` pour transparence local/remote :

**Principe** : Un snapshot peut capturer des fichiers locaux ET/OU distants. Le stockage SQLite est centralisé sur localhost.

**Schema SQLite : `infra_snapshots.db`**
```sql
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL, -- 'local' or 'remote'
  source_alias TEXT, -- NULL for local, server alias for remote
  timestamp INTEGER NOT NULL,
  tag TEXT,
  message TEXT,
  paths TEXT -- JSON array of captured paths
);

CREATE TABLE file_contents (
  hash TEXT PRIMARY KEY,
  content BLOB NOT NULL,
  size INTEGER
);

CREATE TABLE file_map (
  snapshot_id TEXT,
  path TEXT,
  hash TEXT,
  mtime INTEGER,
  source_type TEXT, -- 'local' or 'remote' (denormalized for queries)
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id),
  FOREIGN KEY (hash) REFERENCES file_contents(hash)
);

CREATE INDEX idx_snapshot_source ON snapshots(source_type, source_alias);
CREATE INDEX idx_file_map_snapshot ON file_map(snapshot_id);
CREATE INDEX idx_file_map_source ON file_map(source_type);
```

**Déduplication par hash :** Même principe que gencodedoc — un fichier avec le même contenu n'est stocké qu'une fois.

### Tâches

#### 1. Créer `modules/snapshotManager.js`
```javascript
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { diffLines } from 'diff';
import sourceAdapter from './sourceAdapter.js';
import fileOps from './fileOps.js';

export default {
  async createSnapshot(source, paths, options = {}) {
    // source = { type: 'local'|'remote', alias?, config? }
    // options = { tag, message, recursive }
    // For each path (file or folder):
    //   - Read via sourceAdapter (local=fs, remote=SFTP)
    //   - Calculate hash
    //   - Store in file_contents (si nouveau hash → dedup)
    //   - Insert in file_map avec source_type
    // Return { snapshotId, filesCount, totalBytes, deduplicatedBytes }
  },
  
  async listSnapshots(filter = {}) {
    // filter = { sourceType?, sourceAlias?, limit? }
    // List snapshots filtered by source (local, specific server, or all)
    // Return array with metadata
  },
  
  async diffSnapshots(snapshot1Id, snapshot2Id) {
    // Compare file_map tables (peu importe local/remote)
    // Return: added, removed, modified files
    // For modified: generate unified diff via diffLines
    // NB: permet de comparer snapshot local vs snapshot remote !
  },
  
  async restoreSnapshot(snapshotId, targetSource, options = {}) {
    // targetSource = { type: 'local'|'remote', alias?, config? }
    // options = { paths, dryRun, force }
    // NB: on peut restaurer un snapshot remote vers local (et vice-versa)
    // If dryRun: only show what would be done
    // Write files via sourceAdapter (local=fs, remote=SFTP)
    // Return { restored: [], skipped: [] }
  },
  
  async deleteSnapshot(snapshotId) {
    // Delete entries from file_map
    // Delete snapshot entry
    // Cleanup orphaned file_contents (hash not referenced)
    // Return { deleted: true, freedBytes }
  }
};
```

#### 2. Ajouter les outils MCP

**Outil 1 : `snapshot_create`**
```javascript
server.registerTool(
  "snapshot_create",
  {
    title: "Créer un snapshot d'infrastructure",
    description: "Capture l'état de fichiers/dossiers critiques (localhost sans SSH, ou serveur distant via SFTP).",
    inputSchema: z.object({
      source: z.object({
        type: z.enum(['local', 'remote']),
        alias: z.string().optional().describe("Requis si type='remote'")
      }).refine(d => d.type === 'local' || d.alias, {
        message: "alias requis quand type='remote'"
      }),
      paths: z.array(z.string()).describe("Chemins à capturer (fichiers ou dossiers)"),
      tag: z.string().optional(),
      message: z.string().optional(),
      recursive: z.boolean().optional().default(true)
    })
  },
  async (params) => {
    try {
      const config = params.source.type === 'remote' 
        ? await servers.getServer(params.source.alias) 
        : null;
      const source = { ...params.source, config };
      const result = await snapshotManager.createSnapshot(source, params.paths, {
        tag: params.tag,
        message: params.message,
        recursive: params.recursive
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ toolName: "snapshot_create", errorCode: "SNAPSHOT_ERROR", errorMessage: e.message }, null, 2) }], isError: true };
    }
  }
);
```

**Outil 2 : `snapshot_list`**
```javascript
server.registerTool(
  "snapshot_list",
  {
    title: "Lister les snapshots",
    description: "Affiche les snapshots filtrés par source (localhost, serveur spécifique, ou tous).",
    inputSchema: z.object({
      sourceType: z.enum(['local', 'remote']).optional().describe("Filtrer par type de source"),
      sourceAlias: z.string().optional().describe("Filtrer par alias serveur (si remote)"),
      limit: z.number().optional().default(20)
    })
  },
  async (params) => {
    try {
      const result = await snapshotManager.listSnapshots({
        sourceType: params.sourceType,
        sourceAlias: params.sourceAlias,
        limit: params.limit
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ toolName: "snapshot_list", errorCode: "LIST_ERROR", errorMessage: e.message }, null, 2) }], isError: true };
    }
  }
);
```

**Outil 3 : `snapshot_diff`**
```javascript
server.registerTool(
  "snapshot_diff",
  {
    title: "Comparer deux snapshots",
    description: "Génère un diff unifié entre deux snapshots (peu importe local/remote — permet de comparer un snapshot local vs distant).",
    inputSchema: z.object({
      snapshot1: z.string(),
      snapshot2: z.string(),
      format: z.enum(['summary', 'detailed']).optional().default('summary')
    })
  },
  async (params) => {
    try {
      const result = await snapshotManager.diffSnapshots(params.snapshot1, params.snapshot2);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ toolName: "snapshot_diff", errorCode: "DIFF_ERROR", errorMessage: e.message }, null, 2) }], isError: true };
    }
  }
);
```

**Outil 4 : `snapshot_restore`**
```javascript
server.registerTool(
  "snapshot_restore",
  {
    title: "Restaurer un snapshot",
    description: "Restaure les fichiers d'un snapshot vers une cible (local ou remote). DANGEREUX - dryRun par défaut. NB: peut restaurer un snapshot remote vers local (et vice-versa).",
    inputSchema: z.object({
      snapshotId: z.string(),
      target: z.object({
        type: z.enum(['local', 'remote']),
        alias: z.string().optional().describe("Requis si type='remote'")
      }).refine(d => d.type === 'local' || d.alias, {
        message: "alias requis quand type='remote'"
      }),
      paths: z.array(z.string()).optional().describe("Chemins spécifiques à restaurer (sinon tous)"),
      dryRun: z.boolean().optional().default(true),
      force: z.boolean().optional().default(false)
    })
  },
  async (params) => {
    try {
      // SECURITE : dryRun=true par défaut. Restauration réelle requiert force=true
      if (!params.dryRun && !params.force) {
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              toolName: "snapshot_restore",
              errorCode: "CONFIRMATION_REQUIRED",
              errorMessage: "Restauration réelle bloquée. Utilisez dryRun:true pour prévisualiser, ou force:true pour confirmer l'écrasement.",
              hint: "Toujours faire un dryRun d'abord et valider avec Franck avant force:true"
            }, null, 2) 
          }], 
          isError: true 
        };
      }
      
      const config = params.target.type === 'remote' 
        ? await servers.getServer(params.target.alias) 
        : null;
      const target = { ...params.target, config };
      
      const result = await snapshotManager.restoreSnapshot(params.snapshotId, target, {
        paths: params.paths,
        dryRun: params.dryRun,
        force: params.force
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ toolName: "snapshot_restore", errorCode: "RESTORE_ERROR", errorMessage: e.message }, null, 2) }], isError: true };
    }
  }
);
```

**Outil 5 : `snapshot_delete`**
```javascript
server.registerTool(
  "snapshot_delete",
  {
    title: "Supprimer un snapshot",
    description: "Supprime définitivement un snapshot et nettoie les orphelins.",
    inputSchema: z.object({
      snapshotId: z.string()
    })
  },
  async (params) => {
    // Use snapshotManager.deleteSnapshot()
    // Return { deleted: true, freedBytes }
  }
);
```

#### 3. Tests

**Tests Remote :**
- Créer snapshot de `/etc/nginx/` sur vpsparfait
- Modifier un fichier nginx.conf
- Créer un deuxième snapshot
- Diff les deux snapshots → vérifier détection de modification
- Restore dryRun → vérifier preview
- Restore avec force → vérifier restauration effective

**Tests Local (sans SSH) :**
- Créer snapshot de `/home/fkomp/Bureau/chatbot-p/` (local)
- Modifier un fichier local
- Créer un deuxième snapshot local
- Diff → vérifier détection
- Restore local dryRun → vérifier preview

**Tests Cross (local ↔ remote) :**
- Snapshot local vs snapshot remote → diff pour détecter drift
- Restore snapshot remote VERS local (backup de prod en local)
- Restore snapshot local VERS remote (déploiement)

**Tests Déduplication :**
- 2 snapshots du même fichier → 1 seul stockage dans file_contents
- Vérifier freedBytes lors de la suppression
- Vérifier cleanup des orphelins

### Validation
- **Remote** : Snapshot de /home/ubuntu/vera/ sur fkomprodmini1
- **Cross** : Diff snapshot local /home/fkomp/Bureau/chatbot-p/ vs snapshot remote /home/ubuntu/vera/
- **Local** : Snapshot des configs MCP locales avant refactor
- Vérifier que la déduplication économise de l'espace
- Test restore avec confirmation Franck (force:true jamais sans validation)

### Durée estimée
**15 heures** (5h snapshotManager + 4h SQLite schema + 3h tools + 2h tests + 1h doc)

---

## Étape 11 : Expérience Agent (DX/AIX) (v10.1.0)

**Objectif** : Rendre orchestrator agréable et sûr à piloter par une IA — guide intégré, affichage lisible des diffs, système de notes/protocole par serveur pour éviter que l'IA se perde dans le parc.

**Statut** : 📋 Planifié (à peaufiner après validation des étapes 7-10)

### Contexte
Avec ~30+ outils et 6+ serveurs, une IA pilote peut :
- Ne pas savoir quel outil utiliser quand (manque de guide)
- Recevoir des diffs illisibles (JSON brut au lieu de format visuel)
- Confondre les serveurs (quel VPS a quel service ? quelles particularités ?)

### Sous-fonctionnalités

#### 11.1 — Guide IA intégré (`guide`)
Un outil qui retourne un manuel structuré pour l'IA pilote (comme `gencodedoc_guide` ou `assistant_ia_get_guide`).

```javascript
guide({ section: 'index' | 'workflows' | 'file-editing' | 'diff' | 'snapshots' | 'cheatsheet' })
```

Contenu :
- **index** : vue d'ensemble des outils par catégorie
- **workflows** : recettes copier-coller (ex: "éditer un fichier distant en sécurité")
- **file-editing** : workflow `file_read` → modifier → `file_edit` (avec hash)
- **cheatsheet** : tableau condensé outil → cas d'usage
- **pitfalls** : pièges courants (ex: toujours dryRun avant restore)

**Bénéfice** : L'IA appelle `guide` en début de session pour charger les bonnes pratiques.

#### 11.2 — Affichage clair des diffs (format client)
Améliorer le rendu des diffs pour qu'ils s'affichent proprement dans les clients MCP (OpenCode, Claude Desktop), comme les vrais outils d'édition.

Options à explorer :
- **Format markdown** : diff dans un bloc ```diff pour coloration syntaxique
- **Format side-by-side** : deux colonnes alignées
- **Résumé condensé** : `+12 lignes / -5 lignes` avec extrait des changements clés
- **Stats visuelles** : barre de proportion ajouts/suppressions

Appliquer à : `file_edit`, `diff_files`, `diff_folders`, `snapshot_diff`.

```javascript
// Exemple de sortie enrichie
{
  summary: "3 fichiers modifiés (+45 / -12 lignes)",
  markdown: "```diff\n- old line\n+ new line\n```",
  files: [{ path, added, removed, preview }]
}
```

#### 11.3 — Notes & Protocole par serveur (`server_note`)
Système de mémoire contextuelle attaché à chaque serveur pour que l'IA ne se perde pas.

```javascript
// Écrire une note sur un serveur
server_note_set({ alias: 'vpsparfait', note: 'Nginx configs dans /etc/nginx. Ne PAS toucher au bloc legacy2.' })

// Lire les notes d'un serveur
server_note_get({ alias: 'vpsparfait' })

// Lister toutes les notes (vue d'ensemble parc)
server_note_list()
```

Structure enrichie possible :
- **description** : rôle du serveur
- **services** : liste des services critiques
- **warnings** : avertissements (ex: "RAM limitée 1Go", "ne pas redémarrer X")
- **conventions** : chemins standards, particularités
- **last_intervention** : historique des dernières actions

**Stockage** : étendre `servers.json` avec un champ `notes` OU table SQLite dédiée.

**Intégration** : `server_list` pourrait inclure un résumé des notes pour donner le contexte immédiatement.

#### 11.4 — Outil de contexte parc (`infra_overview`)
Vue synthétique de tout le parc en un appel (comme `get_system_overview`).

```javascript
infra_overview() 
// → { servers: [{alias, host, role, services, status, warnings}], total: 6 }
```

Croise : `server_list` + notes + dernier health check + statut services.

### Tâches
1. Créer `modules/guide.js` avec le contenu du manuel IA
2. Créer `modules/diffFormatter.js` pour l'affichage enrichi
3. Étendre `servers.js` avec support notes (ou `modules/notes.js` + SQLite)
4. Ajouter les outils : `guide`, `server_note_set/get/list`, `infra_overview`
5. Refactorer les sorties de diff existantes pour utiliser `diffFormatter`

### Validation
- L'IA appelle `guide` → reçoit un manuel clair et actionnable
- Un diff s'affiche proprement en markdown dans OpenCode
- `server_note_set` puis `server_list` → les notes apparaissent dans le contexte
- `infra_overview` donne une vue complète du parc en un appel

### Durée estimée
**8 heures** (2h guide + 2h diffFormatter + 3h notes/overview + 1h intégration)

---

## Résumé des Versions Étendues

| Étape | Version | Fonctionnalité | Effort | Impact |
|-------|---------|----------------|--------|--------|
| 7 | 9.1.0 | File Operations (read/write/edit + hash) | 6h | Édition distante sécurisée |
| 8 | 9.2.0 | Cross-Server Diff (files/folders/all-servers) | 8h | Détection drift config |
| 9 | 9.3.0 | Shell Sessions Persistantes (cd/export persistent) | 10h | Vrais terminaux interactifs |
| 10 | 10.0.0 | Infrastructure Snapshots (versioning + restore) | 15h | Versioning infra complète |
| 11 | 10.1.0 | Expérience Agent (guide, diff lisible, notes parc) | 8h | IA pilote sans se perdre |

**Durée totale estimée** : **47 heures** (~6 jours de dev)

---

## Dépendances Supplémentaires

```json
{
  "diff": "^5.1.0",
  "better-sqlite3": "^9.2.2"
}
```

---

## Priorités d'Implémentation

### 🔴 Priorité CRITIQUE (débloquer Hermes immédiatement)
- **Étape 7** (File Operations) → Permet à Hermes d'éditer des fichiers sur PC1/PC2 via Tailscale

### 🟠 Priorité HAUTE (amélioration qualité)
- **Étape 8** (Cross-Server Diff) → Détecter les drifts de config entre VPS

### 🟡 Priorité MOYENNE (confort d'usage)
- **Étape 9** (Shell Sessions) → Workflows complexes (docker build, npm install, etc.)

### 🟢 Priorité BASSE (long terme)
- **Étape 10** (Snapshots) → Versioning infra (nice to have, pas urgent)

---

## Ordre d'Implémentation Recommandé

1. **v9.1.0** (File Operations) → Débloquer cas d'usage Hermes
2. **v9.2.0** (Cross-Server Diff) → Valider cohérence infra
3. **v9.3.0** (Shell Sessions) → Améliorer DX pour workflows complexes
4. **v10.0.0** (Snapshots) → Sécuriser l'infra (quand temps disponible)

---

## Notes de Sécurité

### Outils Dangereux (Confirmation Franck Obligatoire)
- `snapshot_restore` avec `force: true` → peut écraser config production
- `file_write` sans hash → pas de protection contre écrasement
- `shell_exec` avec commandes rm/shutdown → potentiel destructif

### Protection Recommandée
- Toujours utiliser `file_edit` (avec hash) plutôt que `file_write` pour modifier
- Toujours faire `snapshot_restore` avec `dryRun: true` d'abord
- Logger toutes les opérations destructives dans `history.json`
- Attention accrue sur `type: 'local'` → écrit directement sur le PC hôte du MCP

---

## Integration avec GenCodeDoc

Chaque étape majeure (v9.1, v9.2, v9.3, v10.0) doit :
1. Créer un snapshot gencodedoc **avant** implémentation (tag: `before-vX.Y.0`)
2. Commits réguliers pendant implémentation
3. Snapshot gencodedoc **après** validation (tag: `vX.Y.0-stable`)
4. Générer documentation avec `generate_documentation`
5. Sync RAG via rag-api

---

## Métriques de Succès

### v9.1.0 (File Operations)
- ✅ Hermes peut éditer un fichier sur PC1 via Tailscale (remote)
- ✅ Peut éditer un fichier local SANS config SSH (localhost)
- ✅ Protection hash détecte modification concurrente
- ✅ Diff généré est lisible et correct
- ✅ Workflow cross : lire local → écrire remote fonctionne

### v9.2.0 (Cross-Server Diff)
- ✅ Peut comparer nginx.conf entre vpsparfait et vpsparfait2 (remote ↔ remote)
- ✅ Peut comparer code local vs prod distante (local ↔ remote)
- ✅ Peut détecter quel VPS a une config différente
- ✅ Diff de dossiers identifie fichiers ajoutés/supprimés/modifiés

### v9.3.0 (Shell Sessions)
- ✅ `cd /tmp` puis `pwd` affiche `/tmp` (état persiste)
- ✅ `export VAR=test` puis `echo $VAR` affiche `test`
- ✅ Peut exécuter `docker build` dans une session sans timeout

### v10.0.0 (Snapshots)
- ✅ Snapshot de /etc/nginx/ (remote) fonctionne
- ✅ Snapshot de code local SANS SSH fonctionne
- ✅ Diff entre snapshots affiche modifications (même cross local/remote)
- ✅ Restore dryRun montre preview correct
- ✅ Restore cross (remote → local) permet backup de prod
- ✅ Déduplication économise espace (2 snapshots identiques = 1 stockage)

---

**Protocole de travail** : Implémenter une étape → tester → valider → snapshot gencodedoc → **rendre la main à Franck** → itérer.
