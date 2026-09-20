import shellSessions from './shellSessions.js';

// Test de validation Shell Sessions Persistantes v9.3.0
// Point critique : l'état (cd, export) doit PERSISTER entre les commandes.
// Testé sur PC1 via Tailscale.

const REMOTE_ALIAS = 'pc1_tailscale';
let passed = 0, failed = 0;

function check(name, condition, detail = '') {
    if (condition) { console.log(`✅ ${name}`); passed++; }
    else { console.log(`❌ ${name} ${detail}`); failed++; }
}

async function main() {
    console.log('🧪 Tests Shell Sessions Persistantes v9.3.0 (PC1)');
    let sessionId = null;

    try {
        // 1. Création
        console.log('\n=== Création session ===');
        const created = await shellSessions.createSession(REMOTE_ALIAS, { workdir: '/tmp' });
        sessionId = created.id;
        check('session créée', created.ready === true && created.id);
        check('id contient alias', created.id.includes(REMOTE_ALIAS));

        // 2. workdir initial appliqué
        console.log('\n=== Persistance workdir ===');
        const pwd0 = await shellSessions.execInSession(sessionId, 'pwd');
        check('workdir initial = /tmp', pwd0.output === '/tmp', `(got: "${pwd0.output}")`);
        check('exitCode 0', pwd0.exitCode === 0);

        // 3. PERSISTANCE cd — le test clé
        await shellSessions.execInSession(sessionId, 'mkdir -p /tmp/orch_shell_test/sub');
        await shellSessions.execInSession(sessionId, 'cd /tmp/orch_shell_test/sub');
        const pwd1 = await shellSessions.execInSession(sessionId, 'pwd');
        check('cd PERSISTE (pwd = sous-dossier)', pwd1.output === '/tmp/orch_shell_test/sub', `(got: "${pwd1.output}")`);

        // 4. PERSISTANCE export
        console.log('\n=== Persistance variables ===');
        await shellSessions.execInSession(sessionId, 'export ORCH_VAR=persistance_ok');
        const echo1 = await shellSessions.execInSession(sessionId, 'echo $ORCH_VAR');
        check('export PERSISTE', echo1.output === 'persistance_ok', `(got: "${echo1.output}")`);

        // 5. Variable shell (non exportée) persiste aussi
        await shellSessions.execInSession(sessionId, 'MAVAR=locale123');
        const echo2 = await shellSessions.execInSession(sessionId, 'echo $MAVAR');
        check('variable shell persiste', echo2.output === 'locale123', `(got: "${echo2.output}")`);

        // 6. Exit code non-zéro capturé
        console.log('\n=== Exit codes ===');
        const failCmd = await shellSessions.execInSession(sessionId, 'ls /chemin_inexistant_xyz 2>/dev/null');
        check('exitCode non-zéro capturé', failCmd.exitCode !== 0 && failCmd.exitCode !== null, `(code: ${failCmd.exitCode})`);

        const okCmd = await shellSessions.execInSession(sessionId, 'true');
        check('exitCode 0 après succès', okCmd.exitCode === 0);

        // 7. Sortie multi-lignes
        const multi = await shellSessions.execInSession(sessionId, 'printf "a\\nb\\nc"');
        check('sortie multi-lignes', multi.output === 'a\nb\nc', `(got: ${JSON.stringify(multi.output)})`);

        // 8. Timeout
        console.log('\n=== Timeout ===');
        const timed = await shellSessions.execInSession(sessionId, 'sleep 5', 1);
        check('timeout déclenché sur sleep 5 (timeout 1s)', timed.timedOut === true);

        // La session doit rester utilisable après timeout (Ctrl-C envoyé)
        const afterTimeout = await shellSessions.execInSession(sessionId, 'echo recovered');
        check('session utilisable après timeout', afterTimeout.output === 'recovered', `(got: "${afterTimeout.output}")`);

        // 9. Listing
        console.log('\n=== Listing ===');
        const list = shellSessions.listSessions();
        check('session listée', list.some(s => s.id === sessionId));
        const me = list.find(s => s.id === sessionId);
        check('commandCount > 0', me.commandCount > 0, `(count: ${me.commandCount})`);
        check('alias correct dans listing', me.alias === REMOTE_ALIAS);

        // 10. Erreur : session inconnue
        console.log('\n=== Gestion erreurs ===');
        try {
            await shellSessions.execInSession('sh_inexistant', 'echo x');
            check('exec sur session inconnue → erreur', false, '(aurait dû throw)');
        } catch (e) {
            check('exec sur session inconnue → erreur', e.message.includes('introuvable'));
        }

        // Cleanup test dir
        await shellSessions.execInSession(sessionId, 'rm -rf /tmp/orch_shell_test');

    } catch (err) {
        check('déroulement sans exception fatale', false, `(erreur: ${err.message})`);
    } finally {
        // 11. Fermeture
        if (sessionId) {
            console.log('\n=== Fermeture ===');
            const closed = shellSessions.closeSession(sessionId);
            check('session fermée', closed.closed === true);
            const listAfter = shellSessions.listSessions();
            check('session retirée de la liste', !listAfter.some(s => s.id === sessionId));
        }
        shellSessions.closeAll();
    }

    console.log(`\n=== RÉSULTAT : ${passed} réussis, ${failed} échoués ===`);
    // Laisse le temps aux connexions de se fermer proprement
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
}

main().catch(err => { console.error('Erreur fatale test:', err); process.exit(1); });
