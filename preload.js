// preload.js
const { ipcRenderer } = require('electron');

// contextBridge ではなく window オブジェクトに直接割り当てる
window.electronAPI = {
  // --- Terminal APIs ---
  getTerminalConfig: () => ipcRenderer.invoke('terminal:get-config'),
  updateTerminalConfig: (updates) => ipcRenderer.invoke('terminal:update-config', updates),
  getAvailableShells: () => ipcRenderer.invoke('get-available-shells'),
  createTerminal: (options) => ipcRenderer.invoke('terminal:create', options),
  closeTerminal: (terminalId) => ipcRenderer.invoke('terminal:close', terminalId),
  writeToTerminal: (terminalId, data) => ipcRenderer.send('pty:write', { terminalId, data }),
  resizeTerminal: (terminalId, cols, rows) => ipcRenderer.send('pty:resize', { terminalId, cols, rows }),
  saveTerminalState: () => ipcRenderer.invoke('terminal:save-state'),

  onTerminalData: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('pty:data', handler);
    // クリーンアップ用の関数を返す（必要に応じて）
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  onTerminalExit: (callback) => ipcRenderer.on('pty:exit', (event, payload) => callback(payload)),
  onRestoreState: (callback) => ipcRenderer.on('terminal:restore-state', (event, state) => callback(state)),

  // --- Editor & System APIs ---
  executeCommand: (command, currentDir) => ipcRenderer.invoke('execute-command', command, currentDir),
  getCurrentDirectory: () => ipcRenderer.invoke('get-current-directory'),
  getCompletionCandidates: (prefix, currentDir) => ipcRenderer.invoke('get-completion-candidates', prefix, currentDir),

  // Git operations
  gitStatus: (repoPath) => ipcRenderer.invoke('git-status', repoPath),
  gitAdd: (repoPath, filepath) => ipcRenderer.invoke('git-add', repoPath, filepath),
  gitRemove: (repoPath, filepath) => ipcRenderer.invoke('git-remove', repoPath, filepath),
  gitCommit: (repoPath, message) => ipcRenderer.invoke('git-commit', repoPath, message),
  gitPush: (repoPath) => ipcRenderer.invoke('git-push', repoPath),
  gitPull: (repoPath) => ipcRenderer.invoke('git-pull', repoPath),

  // File operations
  saveFile: (filepath, content) => ipcRenderer.invoke('save-file', filepath, content),
  loadFile: (filepath) => ipcRenderer.invoke('load-file', filepath),
  renameFile: (oldPath, newName) => ipcRenderer.invoke('rename-file', oldPath, newName),
  moveFile: (srcPath, destPath) => ipcRenderer.invoke('move-file', srcPath, destPath), // ★追加
  listFiles: (dirPath) => ipcRenderer.invoke('list-files', dirPath),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  deleteFile: (filepath) => ipcRenderer.invoke('delete-file', filepath),
  createDirectory: (dirPath) => ipcRenderer.invoke('create-directory', dirPath),
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // Window operations
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),

  // PDF
  generatePdf: (htmlContent) => ipcRenderer.invoke('generate-pdf', htmlContent),
  exportPdf: (htmlContent) => ipcRenderer.invoke('export-pdf', htmlContent), // ★追加

  // Utility
  fetchUrlTitle: (url) => ipcRenderer.invoke('fetch-url-title', url), // ★追加: URLタイトル取得
  fetchUrlMetadata: (url) => ipcRenderer.invoke('fetch-url-metadata', url), // ★追加: URLメタデータ(OGP)取得

  // Settings
  loadAppSettings: () => ipcRenderer.invoke('load-app-settings'),
  saveAppSettings: (settings) => ipcRenderer.invoke('save-app-settings', settings),

  // Context Menu Helper
  showFileContextMenu: (filePath, isDirectory) => ipcRenderer.send('show-file-context-menu', filePath, isDirectory),

  // Open External Links (New)
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Event Listeners
  onInitiateRename: (callback) => ipcRenderer.on('initiate-rename', (_event, val) => callback(val)),
  onFileDeleted: (callback) => ipcRenderer.on('file-deleted', (_event, val) => callback(val)),

  // ★追加: ファイルシステムの変更を監視するイベントリスナー
  onFileSystemChanged: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('file-system-changed', handler);
    return () => ipcRenderer.removeListener('file-system-changed', handler);
  }
};

console.log('Preload script loaded - electronAPI exposed via window');