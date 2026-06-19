function escapeShellArg(arg) {
    if (typeof arg !== 'string') return String(arg);
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export default { escapeShellArg };
