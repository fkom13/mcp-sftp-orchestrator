import diffEngine from './diffEngine.js';
import compareEngine from './compareEngine.js';
import sourceAdapter from './sourceAdapter.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Test de validation Cross-Server Diff v9.2.0
// Couvre : diff_files (local/remote/cross), diff_folders, compare_all_sources

const REMOTE_ALIAS = 'pc1_tailscale';
let passed = 0, failed = 0;

function check(name, condition, detail = '') {
    if (condition) { console.log(`✅ ${name}`); passed++; }
    else { console.log(`❌ ${name} ${detail}`); failed++; }
}

async function writeLocal(p, content) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
}

async function testDiffFiles() {
    console.log('\n=== diff_files ===');
    const base = path.join(os.tmpdir(), `dff_${Date.now()}`);
    const a = `${base}_a.txt`, b = `${base}_b.txt`, c = `${base}_c.txt`;
    await writeLocal(a, 'ligne1\nligne2\nligne3\n');
    await writeLocal(b, 'ligne1\nMODIF\nligne3\n');
    await writeLocal(c, 'ligne1\nligne2\nligne3\n'); // identique à a

    // Local vs local — différent
    const d1 = await diffEngine.diffFiles({ type: 'local', path: a }, { type: 'local', path: b });
    check('diff local≠local détecte différence', d1.identical === false);
    check('diff contient MODIF', d1.diff.includes('MODIF'));
    check('origine source1 = localhost', d1.source1.server === 'localhost');
    check('compteur added/removed', d1.added >= 1 && d1.removed >= 1, `(+${d1.added}/-${d1.removed})`);

    // Local vs local — identique
    const d2 = await diffEngine.diffFiles({ type: 'local', path: a }, { type: 'local', path: c });
    check('diff identiques → identical:true', d2.identical === true);

    // Local vs remote (cross)
    const remotePath = `/tmp/dff_${Date.now()}.txt`;
    await sourceAdapter.writeFile({ type: 'remote', alias: REMOTE_ALIAS, path: remotePath }, Buffer.from('ligne1\nligne2\nligne3\n'), {});
    const d3 = await diffEngine.diffFiles(
        { type: 'local', path: a },
        { type: 'remote', alias: REMOTE_ALIAS, path: remotePath }
    );
    check('diff local↔remote identiques', d3.identical === true, `(${JSON.stringify(d3.stats)})`);
    check('origine source2 = alias remote', d3.source2.server === REMOTE_ALIAS);

    await fs.unlink(a).catch(()=>{}); await fs.unlink(b).catch(()=>{}); await fs.unlink(c).catch(()=>{});
    await sourceAdapter.writeFile({ type: 'remote', alias: REMOTE_ALIAS, path: remotePath }, Buffer.from(''), {});
}

async function testDiffFolders() {
    console.log('\n=== diff_folders ===');
    const dirA = path.join(os.tmpdir(), `dfa_${Date.now()}`);
    const dirB = path.join(os.tmpdir(), `dfb_${Date.now()}`);
    // dirA : commun.txt, only_a.txt, modif.txt, node_modules/junk.txt
    await writeLocal(path.join(dirA, 'commun.txt'), 'meme contenu\n');
    await writeLocal(path.join(dirA, 'only_a.txt'), 'exclusif A\n');
    await writeLocal(path.join(dirA, 'modif.txt'), 'version A\n');
    await writeLocal(path.join(dirA, 'node_modules', 'junk.txt'), 'ignore moi\n');
    // dirB : commun.txt, only_b.txt, modif.txt (différent)
    await writeLocal(path.join(dirB, 'commun.txt'), 'meme contenu\n');
    await writeLocal(path.join(dirB, 'only_b.txt'), 'exclusif B\n');
    await writeLocal(path.join(dirB, 'modif.txt'), 'version B\n');

    const r = await diffEngine.diffFolders(
        { type: 'local', path: dirA },
        { type: 'local', path: dirB },
        { ignorePatterns: ['node_modules'] }
    );
    check('only_in_source1 contient only_a.txt', r.only_in_source1.includes('only_a.txt'));
    check('only_in_source2 contient only_b.txt', r.only_in_source2.includes('only_b.txt'));
    check('identical contient commun.txt', r.identical.includes('commun.txt'));
    check('modified contient modif.txt', r.modified.some(m => m.path === 'modif.txt'));
    check('node_modules ignoré', !r.only_in_source1.some(p => p.includes('node_modules')));

    // includeDiff
    const r2 = await diffEngine.diffFolders(
        { type: 'local', path: dirA }, { type: 'local', path: dirB },
        { ignorePatterns: ['node_modules'], includeDiff: true }
    );
    const modEntry = r2.modified.find(m => m.path === 'modif.txt');
    check('includeDiff fournit le diff', modEntry && modEntry.diff && modEntry.diff.includes('version'));

    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
}

async function testCompareAllSources() {
    console.log('\n=== compare_all_sources (drift) ===');
    const f1 = path.join(os.tmpdir(), `cas1_${Date.now()}.txt`);
    const f2 = path.join(os.tmpdir(), `cas2_${Date.now()}.txt`);
    const f3 = path.join(os.tmpdir(), `cas3_${Date.now()}.txt`);
    await writeLocal(f1, 'config v1\n');
    await writeLocal(f2, 'config v1\n'); // identique
    await writeLocal(f3, 'config v2 DRIFT\n'); // différent

    const r = await compareEngine.compareSources([
        { type: 'local', path: f1 },
        { type: 'local', path: f2 },
        { type: 'local', path: f3 }
    ]);
    check('drift détecté', r.drift === true);
    check('2 versions distinctes', r.stats.uniqueVersions === 2, `(${r.stats.uniqueVersions})`);
    check('groupe majoritaire en premier (2 sources)', r.groups[0].sources.length === 2);
    check('3 lectures réussies', r.stats.successfulReads === 3);

    // Pas de drift
    const r2 = await compareEngine.compareSources([
        { type: 'local', path: f1 }, { type: 'local', path: f2 }
    ]);
    check('pas de drift si identiques', r2.drift === false);

    // Source inexistante → erreur capturée, pas de crash
    const r3 = await compareEngine.compareSources([
        { type: 'local', path: f1 }, { type: 'local', path: '/inexistant_xyz.txt' }
    ]);
    check('source illisible → capturée dans errors', r3.errors.length === 1);

    // NOUVEAU : labels personnalisés + chemins différents + diff-on-drift
    console.log('\n=== compare_all_sources : labels + diff-on-drift ===');
    const shellA = path.join(os.tmpdir(), `shellA_${Date.now()}`); // simule .bashrc
    const shellB = path.join(os.tmpdir(), `shellB_${Date.now()}`); // simule .zshrc (chemin différent)
    await writeLocal(shellA, 'export PATH=/usr/bin\nalias ll="ls -l"\n');
    await writeLocal(shellB, 'export PATH=/usr/bin\nalias ll="ls -la"\n'); // 1 ligne diffère
    const rl = await compareEngine.compareSources([
        { type: 'local', path: shellA, label: 'shell-vps1' },
        { type: 'local', path: shellB, label: 'shell-vps2' }
    ]);
    check('label personnalisé respecté', rl.groups[0].sources[0].label === 'shell-vps1' || rl.groups[1].sources[0].label === 'shell-vps1');
    check('référence identifiée', rl.reference !== null);
    check('drift → diff réel généré', rl.drifts.length === 1 && rl.drifts[0].diff.includes('ls -la'));
    check('diff compte les lignes', rl.drifts[0].added >= 1 && rl.drifts[0].removed >= 1, `(+${rl.drifts[0].added}/-${rl.drifts[0].removed})`);
    check('includeDiff:false → pas de diff', (await compareEngine.compareSources(
        [{ type: 'local', path: shellA }, { type: 'local', path: shellB }], { includeDiff: false }
    )).drifts.length === 0);

    await fs.unlink(f1).catch(()=>{}); await fs.unlink(f2).catch(()=>{}); await fs.unlink(f3).catch(()=>{});
    await fs.unlink(shellA).catch(()=>{}); await fs.unlink(shellB).catch(()=>{});
}

async function main() {
    console.log('🧪 Tests Cross-Server Diff v9.2.0');
    await testDiffFiles();
    await testDiffFolders();
    await testCompareAllSources();
    console.log(`\n=== RÉSULTAT : ${passed} réussis, ${failed} échoués ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Erreur fatale test:', err); process.exit(1); });
