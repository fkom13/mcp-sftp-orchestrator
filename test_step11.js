import notes from './notes.js';
import guide from './guide.js';
import diffFormatter from './diffFormatter.js';
import { createTwoFilesPatch } from 'diff';

// Test de validation Étape 11 (v10.3.0) : notes, guide, diffFormatter
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { console.log(`✅ ${name}`); passed++; }
    else { console.log(`❌ ${name} ${detail}`); failed++; }
}

async function testNotes() {
    console.log('\n=== server_note ===');
    const alias = `__test_note_${Date.now()}`;
    // set
    await notes.set(alias, {
        description: 'Serveur de test',
        services: ['nginx', 'pm2:app'],
        warnings: ['RAM 1Go']
    });
    const n = await notes.get(alias);
    check('note créée avec description', n.description === 'Serveur de test');
    check('services enregistrés', n.services.length === 2);
    check('warnings enregistrés', n.warnings[0] === 'RAM 1Go');

    // merge partiel + intervention
    await notes.set(alias, { intervention: 'restart nginx' });
    const n2 = await notes.get(alias);
    check('merge partiel préserve description', n2.description === 'Serveur de test');
    check('last_intervention horodatée', n2.last_intervention && n2.last_intervention.summary === 'restart nginx');

    // list
    const all = await notes.list();
    check('note présente dans list', all[alias] !== undefined);

    // remove
    const rem = await notes.remove(alias);
    check('note supprimée', rem.removed === true);
    check('note absente après remove', (await notes.get(alias)) === null);
}

function testGuide() {
    console.log('\n=== guide ===');
    check('section index existe', guide.get('index').includes('Orchestrator'));
    check('section workflows existe', guide.get('workflows').includes('shell_create'));
    check('section file-editing existe', guide.get('file-editing').includes('expectedHash'));
    check('section pitfalls existe', guide.get('pitfalls').includes('dryRun'));
    check('section inconnue → message clair', guide.get('inexistante').includes('inconnue'));
    check('sections() liste les clés', guide.sections().includes('cheatsheet'));
}

function testFormatter() {
    console.log('\n=== diffFormatter ===');
    const patch = createTwoFilesPatch('f', 'f', 'a\nb\nc\n', 'a\nB\nc\n', 'avant', 'après');
    const f = diffFormatter.format(patch, { title: 'Test' });
    check('markdown contient bloc ```diff', f.markdown.includes('```diff'));
    check('markdown contient le titre', f.markdown.includes('### Test'));
    check('résumé +1/-1', f.added === 1 && f.removed === 1);
    check('patch nettoyé (pas de Index:)', !f.markdown.includes('Index:'));

    // response : 2 blocs, diff retiré du JSON
    const resp = diffFormatter.response(f.markdown, { hash: 'abc', diff: patch, applied: true });
    check('response = 2 blocs content', resp.content.length === 2);
    check('response JSON sans champ diff', !JSON.parse(resp.content[1].text).diff);
    check('response JSON garde hash', JSON.parse(resp.content[1].text).hash === 'abc');

    // formatFileList
    const md = diffFormatter.formatFileList({
        modified: [{ path: 'a.txt', added: 2, removed: 1 }],
        added: ['b.txt'], removed: ['c.txt']
    }, { title: 'Dossiers' });
    check('formatFileList liste modifiés', md.includes('a.txt') && md.includes('+2/-1'));
    check('formatFileList liste ajoutés/supprimés', md.includes('b.txt') && md.includes('c.txt'));
}

async function main() {
    console.log('🧪 Tests Étape 11 (v10.3.0)');
    await testNotes();
    testGuide();
    testFormatter();
    console.log(`\n=== RÉSULTAT : ${passed} réussis, ${failed} échoués ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Erreur fatale test:', err); process.exit(1); });
