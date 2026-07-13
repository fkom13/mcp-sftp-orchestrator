import fs from 'fs/promises';
import path from 'path';
import config from './config.js';

const POLICIES_PATH = path.join(config.dataDir, 'policies.json');

const DEFAULT_POLICIES = {
    command_blocklist: [
        "rm -rf /",
        "rm -rf /*",
        "mkfs*",
        ":(){:|:&};:",
        "dd if=/dev/zero",
        "> /dev/sda",
        "chmod -R 000 /",
        "mv / /dev/null",
        "wget -O- http://* | sh",
        "curl http://* | sh",
        "eval $(curl",
        "eval $(wget",
        "git clone http://* | sh"
    ]
};

async function loadPolicies() {
    try {
        await fs.access(POLICIES_PATH);
        const data = await fs.readFile(POLICIES_PATH, 'utf-8');
        return JSON.parse(data);
    } catch {
        await fs.writeFile(POLICIES_PATH, JSON.stringify(DEFAULT_POLICIES, null, 2));
        return { ...DEFAULT_POLICIES };
    }
}

async function savePolicies(policies) {
    await fs.writeFile(POLICIES_PATH, JSON.stringify(policies, null, 2));
}

function checkCommand(cmd, blocklist) {
    const cmdTrimmed = cmd.trim();
    for (const pattern of blocklist) {
        const regex = pattern.includes('*')
            ? new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i')
            : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        if (regex.test(cmdTrimmed)) {
            return { blocked: true, pattern };
        }
    }
    return { blocked: false };
}

export default {
    async list() {
        return await loadPolicies();
    },
    async add(pattern) {
        const policies = await loadPolicies();
        if (!policies.command_blocklist.includes(pattern)) {
            policies.command_blocklist.push(pattern);
            await savePolicies(policies);
        }
        return policies;
    },
    async remove(pattern) {
        const policies = await loadPolicies();
        policies.command_blocklist = policies.command_blocklist.filter(p => p !== pattern);
        await savePolicies(policies);
        return policies;
    },
    async check(cmd) {
        const policies = await loadPolicies();
        return checkCommand(cmd, policies.command_blocklist);
    },
    checkCommand
};
