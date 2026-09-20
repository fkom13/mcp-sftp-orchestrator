import snapshotManager from './snapshotManager.js';
import sourceAdapter from './sourceAdapter.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Test de validation Infrastructure Snapshots v10.0.0
// Couvre : create (local + remote PC1), dedup, diff, restore dryRun/réel, delete+orphelins

const REMOTE_ALIAS = 'pc1_tailscale';
let passed = 0, failed = 0;
const createdSnapshots = [];

function check(name, condition, detail = '') {
    if (condition) { console.log(`✅ ${name}`); passed++; }
    else { console.log(`❌ ${name} ${detail}`); failed++; }
}

async function writeLocal(p, content) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
}

async function main() {
    console.log('🧪 Tests Infrastructure Snapshots v10.0.0');

    // Prépare un dossier local de test
    const dir = path.join(os.tmpdir(), `snap_test_${Date.now()}`);
    await writeLocal(path.join(dir, 'config.txt'), 'version 1\n');
    await writeLocal(path.join(dir, 'sub', 'data.txt'), 'donnée A\n');
    await writeLocal(path.join(dir, 'dup1.txt'), 'CONTENU IDENTIQUE\n');
    await writeLocal(path.join(dir, 'dup2.txt'), 'CONTENU IDENTIQUE\n'); // même contenu → dedup
    await writeLocal(path.join(dir, 'node_modules', 'junk.txt'), 'ignore\n');

    try {
        // 1. Création snapshot local + dedup
        console.log('\n=== snapshot_create (local) + dedup ===');
        const snap1 = await snapshotManager.createSnapshot(
            { type: 'local' }, [dir],
            { tag: 'test-v1', message: 'snapshot initial', ignorePatterns: ['node_modules'] }
        );
        createdSnapshots.push(snap1.snapshotId);
        check('snapshot créé', !!snap1.snapshotId);
        check('4 fichiers capturés (node_modules ignoré)', snap1.filesCount === 4, `(got: ${snap1.filesCount})`);
        check('déduplication : dup1/dup2 → 1 objet dédupliqué', snap1.dedupedObjects >= 1, `(deduped: ${snap1.dedupedObjects})`);

        // 2. Listing
        console.log('\n=== snapshot_list ===');
        const list = await snapshotManager.listSnapshots({ sourceType: 'local' });
        check('snapshot présent dans la liste', list.some(s => s.id === snap1.snapshotId));
        check('tag correct', list.find(s => s.id === snap1.snapshotId).tag === 'test-v1');

        // 3. Modifie un fichier + 2e snapshot
        console.log('\n=== 2e snapshot après modif ===');
        await writeLocal(path.join(dir, 'config.txt'), 'version 2 MODIFIÉE\n');
        await writeLocal(path.join(dir, 'nouveau.txt'), 'fichier ajouté\n');
        await fs.unlink(path.join(dir, 'sub', 'data.txt'));
        const snap2 = await snapshotManager.createSnapshot(
            { type: 'local' }, [dir],
            { tag: 'test-v2', ignorePatterns: ['node_modules'] }
        );
        createdSnapshots.push(snap2.snapshotId);
        check('2e snapshot créé', !!snap2.snapshotId);

        // 4. Diff snapshots
        console.log('\n=== snapshot_diff ===');
        const diff = await snapshotManager.diffSnapshots(snap1.snapshotId, snap2.snapshotId, { includeDiff: true });
        check('config.txt détecté modifié', diff.modified.some(m => m.path.endsWith('config.txt')));
        check('nouveau.txt détecté ajouté', diff.added.some(p => p.endsWith('nouveau.txt')));
        check('sub/data.txt détecté supprimé', diff.removed.some(p => p.endsWith('data.txt')));
        const modConfig = diff.modified.find(m => m.path.endsWith('config.txt'));
        check('diff détaillé contient MODIFIÉE', modConfig?.diff?.includes('MODIFIÉE'));

        // 5. Restore dryRun
        console.log('\n=== snapshot_restore (dryRun) ===');
        const restoreDir = path.join(os.tmpdir(), `snap_restore_${Date.now()}`);
        // Note: restore utilise les chemins absolus du snapshot. On restaure vers local (mêmes chemins).
        const dry = await snapshotManager.restoreSnapshot(snap1.snapshotId, { type: 'local' }, { dryRun: true });
        check('dryRun ne modifie rien', dry.dryRun === true);
        check('dryRun liste les fichiers à restaurer', dry.restored.length === 4, `(got: ${dry.restored.length})`);

        // 6. Restore réel (restaure config.txt v1 par-dessus la v2)
        console.log('\n=== snapshot_restore (réel) ===');
        const real = await snapshotManager.restoreSnapshot(
            snap1.snapshotId, { type: 'local' },
            { dryRun: false, force: true, paths: [path.join(dir, 'config.txt')] }
        );
        check('restore réel effectué', real.dryRun === false && real.restored.length === 1);
        const restoredContent = await fs.readFile(path.join(dir, 'config.txt'), 'utf8');
        check('config.txt restauré à v1', restoredContent === 'version 1\n', `(got: "${restoredContent.trim()}")`);

        // 7. Remote snapshot (PC1)
        console.log('\n=== snapshot_create (remote PC1) ===');
        const remotePath = `/tmp/snap_remote_${Date.now()}`;
        await sourceAdapter.writeFile({ type: 'remote', alias: REMOTE_ALIAS, path: `${remotePath}/f1.txt` }, Buffer.from('remote 1\n'), {});
        await sourceAdapter.writeFile({ type: 'remote', alias: REMOTE_ALIAS, path: `${remotePath}/f2.txt` }, Buffer.from('remote 2\n'), {});
        const snapR = await snapshotManager.createSnapshot(
            { type: 'remote', alias: REMOTE_ALIAS }, [remotePath], { tag: 'remote-test' }
        );
        createdSnapshots.push(snapR.snapshotId);
        check('snapshot remote créé', snapR.filesCount === 2, `(got: ${snapR.filesCount})`);
        check('serveur = alias PC1', snapR.server === REMOTE_ALIAS);

        // 8. Delete + orphan cleanup
        console.log('\n=== snapshot_delete + orphelins ===');
        const del = await snapshotManager.deleteSnapshot(snapR.snapshotId);
        createdSnapshots.pop();
        check('snapshot supprimé', del.deleted === true);
        check('blobs orphelins nettoyés', del.freedObjects >= 1, `(freed: ${del.freedObjects})`);
        const listAfter = await snapshotManager.listSnapshots();
        check('snapshot retiré de la liste', !listAfter.some(s => s.id === snapR.snapshotId));

        // Cleanup remote
        await sourceAdapter.writeFile({ type: 'remote', alias: REMOTE_ALIAS, path: `${remotePath}/f1.txt` }, Buffer.from(''), {});
        await sourceAdapter.writeFile({ type: 'remote', alias: REMOTE_ALIAS, path: `${remotePath}/f2.txt` }, Buffer.from(''), {});

    } catch (err) {
        check('droulement sans exception fatale', false, `(erreur: ${err.message})`);
        console.error(err);
    } finally {
        // Nettoyage : supprime les snapshots de test restants
        for (const id of createdSnapshots) {
            await snapshotManager.deleteSnapshot(id).catch(() => {});
        }
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    console.log(`\n=== RÉSULTAT : ${passed} réussis, ${failed} échoués ===`);
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
}

main().catch(err => { console.error('Erreur fatale test:', err); process.exit(1); });
