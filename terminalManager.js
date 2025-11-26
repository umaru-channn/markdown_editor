// terminalManager.js
// Integrated Terminal Manager for Electron
// Handles OS detection, shell selection, and terminal process spawning

const os = require('os');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');

/**
 * Get the default shell for the current OS
 * @returns {Object} { shell: string, args: string[] }
 */
function getDefaultShell() {
    const platform = process.platform;

    if (platform === 'win32') {
        // Windows: Command Prompt (cmd.exe)を第一優先にするように変更
        // Cmd.exeのパスは通常 C:\Windows\System32\cmd.exe

        // 1. Command Prompt (cmd.exe)
        const cmdPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\cmd.exe');
        return {
            shell: cmdPath,
            args: []
        };
    } else if (platform === 'darwin') {
        // macOS: Use zsh (default on modern macOS), fallback to bash
        if (fs.existsSync('/bin/zsh')) {
            return {
                shell: '/bin/zsh',
                args: []
            };
        } else {
            return {
                shell: '/bin/bash',
                args: []
            };
        }
    } else if (platform === 'linux') {
        // Linux: Use $SHELL environment variable, fallback to /bin/bash
        const shellEnv = process.env.SHELL;
        if (shellEnv && fs.existsSync(shellEnv)) {
            return {
                shell: shellEnv,
                args: []
            };
        } else {
            return {
                shell: '/bin/bash',
                args: []
            };
        }
    }

    // Default fallback
    return {
        shell: process.env.SHELL || '/bin/bash',
        args: []
    };
}

/**
 * Detect PowerShell 7 installation paths
 * @returns {string|null} Path to pwsh.exe if found, null otherwise
 */
function detectPowerShell7() {
    // Common PowerShell 7+ installation paths
    const ps7Paths = [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files\\PowerShell\\7.0\\pwsh.exe',
        'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files (x86)\\PowerShell\\7.0\\pwsh.exe'
    ];

    // Add user local app data path if available
    if (process.env.LOCALAPPDATA) {
        ps7Paths.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'PowerShell', '7', 'pwsh.exe'));
    }

    // Check each path
    for (const ps7Path of ps7Paths) {
        if (fs.existsSync(ps7Path)) {
            console.log(`PowerShell 7 detected at: ${ps7Path}`);
            return ps7Path;
        }
    }

    return null;
}

/**
 * Detect available shells on Windows
 * @returns {Array} Array of shell profile objects
 */
function detectWindowsShells() {
    const shells = [];

    // Command Prompt - check if it exists (should always be available on Windows)
    const cmdPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\cmd.exe');
    if (fs.existsSync(cmdPath)) {
        shells.push({
            name: 'cmd',
            displayName: 'Command Prompt',
            shell: cmdPath, // Use full path for reliability
            args: []
        });
    }

    // PowerShell 7+ (latest version) - check first for priority
    const ps7Path = detectPowerShell7();
    if (ps7Path) {
        shells.push({
            name: 'powershell',
            displayName: 'PowerShell',
            shell: ps7Path,
            args: [],
            isLatest: true  // Mark as latest version
        });
    }

    // Windows PowerShell - check if it exists
    const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    if (fs.existsSync(powershellPath)) {
        shells.push({
            name: 'powershell-legacy',
            displayName: 'PowerShell (Legacy)',
            shell: powershellPath, // Use full path for reliability
            args: []
        });
    }

    // WSL (Windows Subsystem for Linux)
    // Check if wsl.exe exists in System32
    const wslPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\wsl.exe');
    if (fs.existsSync(wslPath)) {
        shells.push({
            name: 'wsl',
            displayName: 'WSL',
            shell: wslPath, // Use full path for reliability
            args: []
        });
    }

    // Git Bash - check common installation paths
    const gitBashPaths = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
    ];

    // Add LOCALAPPDATA path only if the environment variable is set
    if (process.env.LOCALAPPDATA) {
        gitBashPaths.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
    }

    for (const gitBashPath of gitBashPaths) {
        if (fs.existsSync(gitBashPath)) {
            shells.push({
                name: 'git-bash',
                displayName: 'Git Bash',
                shell: gitBashPath,
                args: []
            });
            break; // Only add once
        }
    }

    return shells;
}

/**
 * Get all available shells for the current OS
 * @returns {Array} Array of shell profile objects with name, displayName, shell, and args
 */
function getAvailableShells() {
    const platform = process.platform;

    if (platform === 'win32') {
        return detectWindowsShells();
    } else if (platform === 'darwin') {
        const shells = [];

        // zsh
        if (fs.existsSync('/bin/zsh')) {
            shells.push({
                name: 'zsh',
                displayName: 'Zsh',
                shell: '/bin/zsh',
                args: []
            });
        }

        // bash
        if (fs.existsSync('/bin/bash')) {
            shells.push({
                name: 'bash',
                displayName: 'Bash',
                shell: '/bin/bash',
                args: []
            });
        }

        return shells;
    } else if (platform === 'linux') {
        const shells = [];

        // bash
        if (fs.existsSync('/bin/bash')) {
            shells.push({
                name: 'bash',
                displayName: 'Bash',
                shell: '/bin/bash',
                args: []
            });
        }

        // zsh
        if (fs.existsSync('/bin/zsh')) {
            shells.push({
                name: 'zsh',
                displayName: 'Zsh',
                shell: '/bin/zsh',
                args: []
            });
        }

        // sh
        if (fs.existsSync('/bin/sh')) {
            shells.push({
                name: 'sh',
                displayName: 'Sh',
                shell: '/bin/sh',
                args: []
            });
        }

        // Check $SHELL if it's different from the above
        const shellEnv = process.env.SHELL;
        if (shellEnv && fs.existsSync(shellEnv)) {
            const shellName = path.basename(shellEnv);
            const alreadyAdded = shells.some(s => s.shell === shellEnv);
            if (!alreadyAdded) {
                shells.push({
                    name: shellName,
                    displayName: shellName.charAt(0).toUpperCase() + shellName.slice(1),
                    shell: shellEnv,
                    args: []
                });
            }
        }

        return shells;
    }

    return [];
}

/**
 * Spawn a shell process using node-pty
 * @param {string} shellProfile - Name of the shell profile to use (e.g., 'powershell', 'bash', 'wsl')
 * @param {string} cwd - Current working directory (defaults to home directory)
 * @param {Object} options - Additional spawn options
 * @returns {IPty} The spawned pty process
 */
function spawnShell(shellProfile = null, cwd = null, options = {}) {
    let shellConfig;

    if (shellProfile) {
        // Find the specified shell profile
        const availableShells = getAvailableShells();
        const selectedShell = availableShells.find(s => s.name === shellProfile);

        if (selectedShell) {
            shellConfig = selectedShell;
        } else {
            // Fallback to default if specified profile not found
            console.warn(`Shell profile '${shellProfile}' not found, using default shell`);
            shellConfig = getDefaultShell();
        }
    } else {
        // Use default shell
        shellConfig = getDefaultShell();
    }

    // Set working directory
    const workingDirectory = cwd || os.homedir();

    // Merge default options with provided options
    const ptyOptions = {
        name: 'xterm-color',
        cols: options.cols || 80,
        rows: options.rows || 30,
        cwd: workingDirectory,
        env: options.env || process.env,
        ...options
    };

    // Spawn the shell process
    const ptyProcess = pty.spawn(shellConfig.shell, shellConfig.args, ptyOptions);

    return ptyProcess;
}

/**
 * Get the default shell profile object (not just the shell path)
 * @returns {Object} Complete shell profile with name, displayName, shell, and args
 */
function getDefaultShellProfile() {
    const defaultShell = getDefaultShell();
    const availableShells = getAvailableShells();

    // Find the profile that matches the default shell path
    const matchingProfile = availableShells.find(shell => shell.shell === defaultShell.shell);

    if (matchingProfile) {
        return matchingProfile;
    }

    // Fallback: return first available shell (Cmdが最優先なので、Cmdが返る可能性が高い)
    return availableShells.find(shell => shell.name === 'cmd') || availableShells[0] || {
        name: 'shell',
        displayName: 'Shell',
        shell: defaultShell.shell,
        args: defaultShell.args
    };
}

/**
 * Get a shell configuration by profile name
 * @param {string} profileName - Name of the shell profile
 * @returns {Object|null} Shell configuration or null if not found
 */
function getShellByProfile(profileName) {
    const availableShells = getAvailableShells();
    return availableShells.find(s => s.name === profileName) || null;
}

module.exports = {
    getDefaultShell,
    detectPowerShell7,
    getAvailableShells,
    getDefaultShellProfile,
    spawnShell,
    getShellByProfile
};