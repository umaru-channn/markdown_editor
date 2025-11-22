// terminalService.js
// Terminal Service Layer inspired by VSCode's ITerminalService
// Provides centralized terminal management and lifecycle control

const EventEmitter = require('events');
const terminalManager = require('./terminalManager');

/**
 * Terminal Instance class
 * Encapsulates a single terminal session with its state and lifecycle
 */
class TerminalInstance extends EventEmitter {
    constructor(id, ptyProcess, shellProfile, cwd) {
        super();
        this._id = id;
        this._pty = ptyProcess;
        this._shellProfile = shellProfile;
        this._cwd = cwd;
        this._cols = 80;
        this._rows = 30;
        this._isDisposed = false;
        this._disposables = [];

        // Set up PTY event listeners
        this._setupPtyListeners();
    }

    get id() {
        return this._id;
    }

    get shellName() {
        return this._shellProfile ? this._shellProfile.displayName : 'Shell';
    }

    get dimensions() {
        return { cols: this._cols, rows: this._rows };
    }

    get isDisposed() {
        return this._isDisposed;
    }

    get cwd() {
        return this._cwd;
    }

    _setupPtyListeners() {
        if (!this._pty) return;

        // Listen for data from PTY
        const onDataListener = this._pty.onData((data) => {
            if (!this._isDisposed) {
                this.emit('data', data);
            }
        });
        // Only add to disposables if it's actually disposable
        if (onDataListener && typeof onDataListener.dispose === 'function') {
            this._disposables.push(onDataListener);
        }

        // Listen for PTY exit - this is critical for cleanup
        const onExitListener = this._pty.onExit(({ exitCode, signal }) => {
            if (!this._isDisposed) {
                console.log(`Terminal ${this._id} process exited with code ${exitCode}, signal ${signal}`);
                this.emit('exit', { exitCode, signal });

                // Automatically dispose when process exits
                setImmediate(() => {
                    this.dispose();
                });
            }
        });
        // Only add to disposables if it's actually disposable
        if (onExitListener && typeof onExitListener.dispose === 'function') {
            this._disposables.push(onExitListener);
        }

        // Listen for PTY errors - wrap handler for proper disposal
        if (typeof this._pty.on === 'function') {
            const errorHandler = (error) => {
                if (!this._isDisposed) {
                    console.error(`PTY error for terminal ${this._id}:`, error.message);
                    this.emit('error', error);
                }
            };
            this._pty.on('error', errorHandler);

            // Store the handler so we can remove it later
            this._disposables.push({
                dispose: () => {
                    if (typeof this._pty.off === 'function') {
                        this._pty.off('error', errorHandler);
                    } else if (typeof this._pty.removeListener === 'function') {
                        this._pty.removeListener('error', errorHandler);
                    }
                }
            });
        }
    }

    /**
     * Write data to the terminal
     */
    write(data) {
        if (this._isDisposed || !this._pty) {
            return;
        }

        try {
            this._pty.write(data);
        } catch (error) {
            console.error(`Error writing to terminal ${this._id}:`, error.message);
            // Auto-dispose on write error to prevent cascading errors
            if (error.code === 'ERR_STREAM_DESTROYED' || error.message.includes('EPIPE')) {
                setImmediate(() => {
                    if (!this._isDisposed) {
                        this.dispose();
                    }
                });
            }
            this.emit('error', error);
        }
    }

    /**
     * Resize the terminal
     */
    resize(cols, rows) {
        if (this._isDisposed || !this._pty) {
            return;
        }

        try {
            this._cols = cols;
            this._rows = rows;
            this._pty.resize(cols, rows);
        } catch (error) {
            console.error(`Error resizing terminal ${this._id}:`, error.message);
            // Auto-dispose on resize error
            if (error.code === 'ERR_STREAM_DESTROYED' || error.message.includes('EPIPE')) {
                setImmediate(() => {
                    if (!this._isDisposed) {
                        this.dispose();
                    }
                });
            }
            this.emit('error', error);
        }
    }

    /**
     * Get terminal state for persistence
     */
    getState() {
        return {
            id: this._id,
            shellProfile: this._shellProfile?.name || null,
            cwd: this._cwd,
            cols: this._cols,
            rows: this._rows
        };
    }

    /**
     * Dispose the terminal instance
     */
    dispose() {
        if (this._isDisposed) {
            return;
        }

        this._isDisposed = true;

        // Step 1: Remove externally attached handlers to prevent further events
        if (this._handlers) {
            try {
                this.removeListener('data', this._handlers.data);
                this.removeListener('exit', this._handlers.exit);
                this.removeListener('error', this._handlers.error);
            } catch (error) {
                console.error(`Error removing external handlers for terminal ${this._id}:`, error.message);
            }
            this._handlers = null;
        }

        // Step 2: Close PTY streams and kill process
        if (this._pty) {
            try {
                // First, try graceful shutdown with SIGTERM
                try {
                    // Set a timeout for graceful shutdown
                    const killTimeout = setTimeout(() => {
                        try {
                            // Force kill if graceful shutdown times out
                            this._pty.kill('SIGKILL');
                        } catch (forcekillError) {
                            console.error(`Error force killing PTY for terminal ${this._id}:`, forcekillError.message);
                        }
                    }, 500);

                    // Send SIGTERM for graceful shutdown
                    this._pty.kill('SIGTERM');

                    // Clear timeout after process exits (handled in onExit listener)
                    // Note: The timeout will be cleared when the process actually exits
                } catch (termError) {
                    console.error(`Error sending SIGTERM to PTY for terminal ${this._id}:`, termError.message);
                    // If SIGTERM fails, try SIGKILL immediately
                    try {
                        this._pty.kill('SIGKILL');
                    } catch (killError) {
                        console.error(`Error sending SIGKILL to PTY for terminal ${this._id}:`, killError.message);
                    }
                }
            } catch (error) {
                console.error(`Error killing PTY for terminal ${this._id}:`, error.message);
            }
        }

        // Step 3: Dispose all PTY event listeners (now that kill is in progress)
        this._disposables.forEach(disposable => {
            try {
                disposable.dispose();
            } catch (error) {
                console.error(`Error disposing listener for terminal ${this._id}:`, error.message);
            }
        });
        this._disposables = [];

        // Step 4: Remove all PTY listeners to prevent error events
        if (this._pty) {
            try {
                if (typeof this._pty.removeAllListeners === 'function') {
                    this._pty.removeAllListeners();
                }
            } catch (error) {
                console.error(`Error removing PTY listeners for terminal ${this._id}:`, error.message);
            }
            // Don't set to null yet - let the process finish exiting
        }

        // Step 5: Remove all TerminalInstance listeners
        this.removeAllListeners();
    }
}

/**
 * Terminal Service
 * Central service for managing all terminal instances
 * Inspired by VSCode's ITerminalService
 */
class TerminalService extends EventEmitter {
    constructor() {
        super();
        this._terminals = new Map();
        this._nextTerminalId = 1;
        this._config = this._loadConfig();
    }

    /**
     * Load terminal configuration
     */
    _loadConfig() {
        // Default configuration (can be loaded from file in the future)
        return {
            defaultProfile: null,
            fontFamily: 'Consolas, "Courier New", monospace',
            fontSize: 14,
            cursorBlink: true,
            scrollback: 1000,
            theme: {
                background: '#1e1e1e',
                foreground: '#d4d4d4'
            }
        };
    }

    /**
     * Get terminal configuration
     */
    getConfig() {
        return { ...this._config };
    }

    /**
     * Update terminal configuration
     */
    updateConfig(updates) {
        this._config = { ...this._config, ...updates };
        this.emit('config-changed', this._config);
    }

    /**
     * Get available shell profiles
     */
    getAvailableShells() {
        try {
            return terminalManager.getAvailableShells();
        } catch (error) {
            console.error('Failed to get available shells:', error);
            return [];
        }
    }

    /**
     * Create a new terminal instance
     */
    createTerminal(profileName = null, cwd = null, options = {}) {
        try {
            const terminalId = this._nextTerminalId++;
            const workingDir = cwd || process.cwd();

            // Get shell profile - if not specified, use the default shell profile
            let shellProfile = profileName
                ? terminalManager.getShellByProfile(profileName)
                : terminalManager.getDefaultShellProfile();

            // Spawn PTY process
            const ptyProcess = terminalManager.spawnShell(
                profileName,
                workingDir,
                {
                    cols: options.cols || 80,
                    rows: options.rows || 30,
                    env: options.env || process.env,
                    // WindowsでConPTY（擬似コンソール）の使用を強制し、リサイズ時の描画崩れを防ぐ
                    useConpty: true
                }
            );

            // Create terminal instance
            const terminal = new TerminalInstance(
                terminalId,
                ptyProcess,
                shellProfile,
                workingDir
            );

            // Store terminal instance
            this._terminals.set(terminalId, terminal);

            // Create handlers for event forwarding
            const dataHandler = (data) => {
                if (this._terminals.has(terminalId)) {
                    this.emit('terminal-data', { terminalId, data });
                }
            };

            const exitHandler = ({ exitCode, signal }) => {
                if (this._terminals.has(terminalId)) {
                    this.emit('terminal-exit', { terminalId, exitCode, signal });
                }
                this._terminals.delete(terminalId);
            };

            const errorHandler = (error) => {
                if (this._terminals.has(terminalId)) {
                    this.emit('terminal-error', { terminalId, error });
                }
            };

            // Forward terminal events
            terminal.on('data', dataHandler);
            terminal.on('exit', exitHandler);
            terminal.on('error', errorHandler);

            // Store handlers for cleanup
            terminal._handlers = {
                data: dataHandler,
                exit: exitHandler,
                error: errorHandler
            };

            // Emit terminal created event
            this.emit('terminal-created', {
                terminalId,
                shellName: terminal.shellName,
                cwd: workingDir
            });

            return terminal;
        } catch (error) {
            console.error('Failed to create terminal:', error);
            throw error;
        }
    }

    /**
     * Get a terminal instance by ID
     */
    getTerminal(terminalId) {
        return this._terminals.get(terminalId);
    }

    /**
     * Get all terminal instances
     */
    getAllTerminals() {
        return Array.from(this._terminals.values());
    }

    /**
     * Get all terminal IDs
     */
    getAllTerminalIds() {
        return Array.from(this._terminals.keys());
    }

    /**
     * Close a specific terminal
     */
    closeTerminal(terminalId) {
        const terminal = this._terminals.get(terminalId);
        if (terminal) {
            console.log(`Closing terminal ${terminalId}...`);
            try {
                terminal.dispose();
                console.log(`Terminal ${terminalId} disposed successfully`);
            } catch (error) {
                console.error(`Error disposing terminal ${terminalId}:`, error.message);
            }

            this._terminals.delete(terminalId);
            this.emit('terminal-closed', { terminalId });
            console.log(`Terminal ${terminalId} closed and removed from registry`);
            return true;
        }
        console.warn(`Terminal ${terminalId} not found for closing`);
        return false;
    }

    /**
     * Close all terminals
     */
    closeAllTerminals() {
        const terminalIds = Array.from(this._terminals.keys());
        terminalIds.forEach(id => this.closeTerminal(id));
    }

    /**
     * Get terminal state for persistence
     */
    getTerminalState() {
        const terminals = [];
        this._terminals.forEach((terminal) => {
            terminals.push(terminal.getState());
        });
        return {
            terminals,
            config: this._config
        };
    }

    /**
     * Restore terminals from saved state
     */
    restoreTerminals(state) {
        if (!state || !state.terminals) {
            return;
        }

        // Restore configuration
        if (state.config) {
            this._config = { ...this._config, ...state.config };
        }

        // Restore terminal instances
        state.terminals.forEach((terminalState) => {
            try {
                this.createTerminal(
                    terminalState.shellProfile,
                    terminalState.cwd,
                    {
                        cols: terminalState.cols,
                        rows: terminalState.rows
                    }
                );
            } catch (error) {
                console.error('Failed to restore terminal:', error);
            }
        });
    }

    /**
     * Dispose the service and all terminals
     */
    dispose() {
        this.closeAllTerminals();
        this.removeAllListeners();
    }
}

// Export singleton instance
const terminalService = new TerminalService();

module.exports = {
    TerminalService,
    TerminalInstance,
    terminalService
};