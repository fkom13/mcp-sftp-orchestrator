import fileOps from './fileOps.js';
import sourceAdapter from './sourceAdapter.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Test de validation File Operations v9.1.0
// Couvre : local (fs), remote (PC1 via Tailscale), protection hash, binaire

const REMOTE_ALIAS = 'pc1_tailscale';
let passed = 0, failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        console.log(`✅ ${name}`);
        passed++;
    } else {
        console.log(`❌ ${name} ${detail}`);
        failed++;
    }
}

async function testLocal() {
    console.log('\n=== TESTS LOCAL (fs direct, sans SSH) ===');
    const tmpFile = path.join(os.tmpdir(), `orch_test_${Date.now()}.txt`);
    const source = { type: 'local', path: tmpFile };

    // Write
    const w = await fileOps.writeFile(source, 'ligne 1\nligne 2\nligne 3\n');
    check('local write retourne un hash', typeof w.hash === 'string' && w.hash.length === 64);

    // Read + hash cohérent
    const r = await fileOps.readFile(source);
    check('local read contenu correct', r.content === 'ligne 1\nligne 2\nligne 3\n');
    check('local read hash == write hash', r.hash === w.hash);

    // Edit avec bon hash
    const e = await fileOps.editFile(source, 'ligne 1\nMODIFIÉE\nligne 3\n', r.hash);
    check('local edit appliqué', e.applied === true);
    check('local edit génère un diff', e.diff.includes('MODIFIÉE'));
    check('local edit compte lignes (+1/-1)', e.added >= 1 && e.removed >= 1, `(added=${e.added}, removed=${e.removed})`);

    // Edit avec mauvais hash → doit échouer
    try {
        await fileOps.editFile(source, 'peu importe', 'hash_bidon_0000');
        check('local edit protection hash', false, '(aurait dû lever une erreur)');
    } catch (err) {
        check('local edit protection hash (HASH_MISMATCH)', err.code === 'HASH_MISMATCH');
        check('local edit erreur contient contenu actuel', err.current?.content.includes('MODIFIÉE'));
    }

    // Binaire (base64)
    const binSource = { type: 'local', path: tmpFile + '.bin' };
    const b64 = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]).toString('base64');
    await fileOps.writeFile(binSource, b64, 'base64');
    const rb = await fileOps.readFile(binSource, 'base64');
    check('local binaire round-trip', rb.content === b64);

    // E : détection binaire auto (lecture utf8 d'un binaire → bascule base64)
    const rAuto = await fileOps.readFile(binSource); // utf8 par défaut
    check('E: binaire lu en utf8 → bascule base64', rAuto.encoding === 'base64' && rAuto.binaryDetected === true);
    const rNoAuto = await fileOps.readFile(binSource, 'utf8', { autoDetect: false });
    check('E: autoDetect:false → reste utf8', rNoAuto.encoding === 'utf8');
    // Un fichier texte ne doit PAS être détecté binaire
    const rText = await fileOps.readFile(source);
    check('E: texte non détecté binaire', !rText.binaryDetected);

    // Cleanup
    await fs.unlink(tmpFile).catch(() => {});
    await fs.unlink(tmpFile + '.bin').catch(() => {});
}

async function testRemote() {
    console.log('\n=== TESTS REMOTE (PC1 via Tailscale/SFTP) ===');
    const remotePath = `/tmp/orch_test_${Date.now()}.txt`;
    const source = { type: 'remote', alias: REMOTE_ALIAS, path: remotePath };

    try {
        // Write
        const w = await fileOps.writeFile(source, 'remote 1\nremote 2\n');
        check('remote write retourne un hash', typeof w.hash === 'string' && w.hash.length === 64);

        // Read
        const r = await fileOps.readFile(source);
        check('remote read contenu correct', r.content === 'remote 1\nremote 2\n');
        check('remote read hash == write hash', r.hash === w.hash);

        // Edit
        const e = await fileOps.editFile(source, 'remote 1\nEDITÉE\n', r.hash);
        check('remote edit appliqué', e.applied === true);
        check('remote edit diff contient EDITÉE', e.diff.includes('EDITÉE'));

        // Vérif relecture
        const r2 = await fileOps.readFile(source);
        check('remote relecture après edit', r2.content === 'remote 1\nEDITÉE\n');

        // Cleanup remote
        await sourceAdapter.writeFile(source, Buffer.from(''), {});
    } catch (err) {
        check('remote tests', false, `(erreur: ${err.message})`);
    }
}

async function testCross() {
    console.log('\n=== TEST CROSS (lire remote → écrire local) ===');
    const remotePath = `/tmp/orch_cross_${Date.now()}.txt`;
    const remoteSource = { type: 'remote', alias: REMOTE_ALIAS, path: remotePath };
    const localFile = path.join(os.tmpdir(), `orch_cross_${Date.now()}.txt`);
    const localSource = { type: 'local', path: localFile };

    try {
        await fileOps.writeFile(remoteSource, 'contenu depuis PC1\n');
        const r = await fileOps.readFile(remoteSource);
        await fileOps.writeFile(localSource, r.content);
        const rl = await fileOps.readFile(localSource);
        check('cross remote→local préserve hash', rl.hash === r.hash);

        await fs.unlink(localFile).catch(() => {});
        await sourceAdapter.writeFile(remoteSource, Buffer.from(''), {});
    } catch (err) {
        check('cross test', false, `(erreur: ${err.message})`);
    }
}

async function testAdvancedEdit() {
    console.log('\n=== TESTS A+B+C (chirurgical / dryRun / backup) ===');
    const tmpFile = path.join(os.tmpdir(), `orch_adv_${Date.now()}.txt`);
    const source = { type: 'local', path: tmpFile };

    // --- A : édition chirurgicale ---
    await fileOps.writeFile(source, 'alpha\nbeta\ngamma\n');
    const r0 = await fileOps.readFile(source);
    const eA = await fileOps.editFile(source, { oldString: 'beta', newString: 'BETA', expectedHash: r0.hash });
    check('A: chirurgical applique le remplacement', eA.applied === true);
    const afterA = await fileOps.readFile(source);
    check('A: contenu modifié correctement', afterA.content === 'alpha\nBETA\ngamma\n', `(got: ${JSON.stringify(afterA.content)})`);

    // A: oldString introuvable
    try {
        await fileOps.editFile(source, { oldString: 'inexistant_xyz', newString: 'x' });
        check('A: oldString absent → erreur', false, '(aurait dû throw)');
    } catch (err) {
        check('A: oldString absent → OLDSTRING_NOT_FOUND', err.code === 'OLDSTRING_NOT_FOUND');
    }

    // A: multiples occurrences sans replaceAll
    await fileOps.writeFile(source, 'x\nx\nx\n');
    try {
        await fileOps.editFile(source, { oldString: 'x', newString: 'y' });
        check('A: multiples sans replaceAll → erreur', false, '(aurait dû throw)');
    } catch (err) {
        check('A: multiples → MULTIPLE_MATCHES', err.code === 'MULTIPLE_MATCHES', `(occ: ${err.occurrences})`);
    }

    // A: replaceAll
    const eAll = await fileOps.editFile(source, { oldString: 'x', newString: 'y', replaceAll: true });
    check('A: replaceAll applique tout', eAll.applied === true);
    const afterAll = await fileOps.readFile(source);
    check('A: replaceAll → toutes occurrences', afterAll.content === 'y\ny\ny\n', `(got: ${JSON.stringify(afterAll.content)})`);

    // --- B : dryRun ---
    await fileOps.writeFile(source, 'ligne1\nligne2\n');
    const hashBefore = (await fileOps.readFile(source)).hash;
    const dry = await fileOps.editFile(source, { oldString: 'ligne2', newString: 'MODIF', dryRun: true });
    check('B: dryRun ne s\'applique pas', dry.applied === false && dry.dryRun === true);
    check('B: dryRun fournit le diff', dry.diff.includes('MODIF'));
    const hashAfterDry = (await fileOps.readFile(source)).hash;
    check('B: dryRun n\'a rien écrit', hashBefore === hashAfterDry);

    // B: dryRun sur file_write (nouveau fichier)
    const newSource = { type: 'local', path: tmpFile + '.new' };
    const wDry = await fileOps.writeFile(newSource, 'contenu neuf\n', 'utf8', { dryRun: true });
    check('B: write dryRun signale wouldWrite', wDry.dryRun === true && wDry.wouldWrite === true);
    check('B: write dryRun n\'a pas créé le fichier', (await sourceAdapter.exists(newSource)) === false);

    // --- C : backup auto ---
    await fileOps.writeFile(source, 'version originale\n');
    const eBackup = await fileOps.editFile(source, { oldString: 'originale', newString: 'modifiée', backup: true });
    check('C: backup retourne un snapshotId', eBackup.backup && eBackup.backup.snapshotId);

    // Vérifie que le backup permet de restaurer l'original
    if (eBackup.backup) {
        const { default: snapshotManager } = await import('./snapshotManager.js');
        const restore = await snapshotManager.restoreSnapshot(eBackup.backup.snapshotId, { type: 'local' }, { dryRun: false, force: true });
        check('C: restore backup effectué', restore.restored.length === 1);
        const restored = await fileOps.readFile(source);
        check('C: fichier restauré à l\'original', restored.content === 'version originale\n', `(got: ${JSON.stringify(restored.content)})`);
        await snapshotManager.deleteSnapshot(eBackup.backup.snapshotId).catch(() => {});
    }

    await fs.unlink(tmpFile).catch(() => {});
    await fs.unlink(tmpFile + '.new').catch(() => {});
}

async function main() {
    console.log('🧪 Tests File Operations v10.1.0');
    await testLocal();
    await testRemote();
    await testCross();
    await testAdvancedEdit();
    console.log(`\n=== RÉSULTAT : ${passed} réussis, ${failed} échoués ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Erreur fatale test:', err);
    process.exit(1);
});
