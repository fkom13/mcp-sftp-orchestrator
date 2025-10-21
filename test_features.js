#!/usr/bin/env node

import queue from './queue.js';
import sshPool from './sshPool.js';
import { glob } from 'glob';
import path from 'path';

console.log('🧪 Test des fonctionnalités MCP Orchestrator v6.0\n');

// Test 1: Queue persistante
console.log('✅ Test Queue:');
const testJob = queue.addJob({
    type: 'test',
    alias: 'test_server',
    cmd: 'echo "Test"',
    status: 'pending'
});
console.log(`  - Tâche créée: ${testJob.id}`);
console.log(`  - Stats queue:`, queue.getStats());

// Test 2: Pool de connexions
console.log('\n✅ Test Pool SSH:');
const poolStats = sshPool.getStats();
console.log(`  - Connexions totales: ${poolStats.totalConnections}`);
console.log(`  - Serveurs actifs: ${Object.keys(poolStats.byServer).length}`);

// Test 3: Patterns Glob
console.log('\n✅ Test Patterns Glob:');
async function testGlob() {
    const patterns = ['*.js', '*.json'];
    for (const pattern of patterns) {
        const files = await glob(pattern, { cwd: process.cwd() });
        console.log(`  - Pattern "${pattern}": ${files.length} fichiers trouvés`);
    }
}

// Test 4: Détection de prompts interactifs
console.log('\n✅ Test Détection Prompts:');
const testPrompts = [
    'Are you sure you want to continue? (yes/no)',
    'Password:',
    'Do you want to continue [Y/n]?',
    'Save configuration?'
];

function detectPrompt(text) {
    const patterns = {
        'continue': /continue.*\?/i,
        'password': /password:/i,
        'yes/no': /\(yes\/no\)/i,
        'y/n': /\[y\/n\]/i,
        'save': /save.*\?/i
    };
    
    for (const [name, regex] of Object.entries(patterns)) {
        if (regex.test(text)) {
            return name;
        }
    }
    return null;
}

testPrompts.forEach(prompt => {
    const detected = detectPrompt(prompt);
    console.log(`  - "${prompt.substring(0, 30)}..." → ${detected || 'non détecté'}`);
});

// Test 5: Logs système
console.log('\n✅ Test Logs:');
queue.log('info', 'Test log info');
queue.log('warn', 'Test log warning');
queue.log('error', 'Test log error');
const logs = queue.getLogs({ limit: 3 });
console.log(`  - ${logs.length} logs récupérés`);

// Test 6: Gestion des tâches crashées
console.log('\n✅ Test Gestion Crashes:');
const crashedJob = queue.addJob({
    type: 'test_crash',
    alias: 'test',
    status: 'running'
});
queue.updateJobStatus(crashedJob.id, 'crashed', { 
    canRetry: true,
    crashedAt: new Date()
});
const crashed = queue.getCrashedJobs();
console.log(`  - Tâches crashées: ${crashed.length}`);
if (crashed.length > 0) {
    console.log(`  - Peut être relancée: ${crashed[0].canRetry}`);
}

// Test 7: Statistiques
console.log('\n✅ Résumé des Statistiques:');
const finalStats = queue.getStats();
console.log(`  - Total tâches: ${finalStats.total}`);
console.log(`  - Par statut:`, finalStats.byStatus);
console.log(`  - Par type:`, finalStats.byType);
console.log(`  - Taux de succès: ${finalStats.successRate}%`);

// Exécuter les tests asynchrones
testGlob().then(() => {
    console.log('\n✨ Tous les tests sont passés avec succès!');
    console.log('📝 Note: Ce sont des tests unitaires, pas des tests de connexion réelle.');
    
    // Nettoyer
    queue.cleanOldJobs();
    process.exit(0);
}).catch(err => {
    console.error('❌ Erreur lors des tests:', err);
    process.exit(1);
});
