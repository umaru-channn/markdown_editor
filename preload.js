// preload.js
const { ipcRenderer } = require('electron');

// contextBridge ではなく window オブジェクトに直接割り当てる
window.electronAPI = {
  scanBacklinks: (targetFileName, rootDir) => ipcRenderer.invoke('scan-backlinks', targetFileName, rootDir),
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
  executeCode: (code, language, execPath, workingDir) => ipcRenderer.invoke('execute-code', code, language, execPath, workingDir),
  getLangVersions: (language) => ipcRenderer.invoke('get-lang-versions', language),
  getCurrentDirectory: () => ipcRenderer.invoke('get-current-directory'),
  getCompletionCandidates: (prefix, currentDir) => ipcRenderer.invoke('get-completion-candidates', prefix, currentDir),

  // Git operations
  gitStatus: (repoPath) => ipcRenderer.invoke('git-status', repoPath),
  gitAdd: (repoPath, filepath) => ipcRenderer.invoke('git-add', repoPath, filepath),
  gitRemove: (repoPath, filepath) => ipcRenderer.invoke('git-remove', repoPath, filepath),
  gitReset: (repoPath, filepath) => ipcRenderer.invoke('git-reset', repoPath, filepath),
  gitCommit: (repoPath, message) => ipcRenderer.invoke('git-commit', repoPath, message),
  gitStageAll: (repoPath) => ipcRenderer.invoke('git-stage-all', repoPath),
  gitPush: (repoPath) => ipcRenderer.invoke('git-push', repoPath),
  gitPull: (repoPath) => ipcRenderer.invoke('git-pull', repoPath),
  gitInit: (repoPath) => ipcRenderer.invoke('git-init', repoPath),
  gitGetBranches: (repoPath) => ipcRenderer.invoke('git-get-branches', repoPath),
  gitCheckout: (repoPath, branchName) => ipcRenderer.invoke('git-checkout', repoPath, branchName),
  gitFetch: (repoPath) => ipcRenderer.invoke('git-fetch', repoPath),
  gitDiscard: (repoPath, filepath, status) => ipcRenderer.invoke('git-discard', repoPath, filepath, status),

  authGitHub: () => ipcRenderer.invoke('auth-github'),
  gitAddRemote: (repoPath, url) => ipcRenderer.invoke('git-add-remote', repoPath, url),
  gitSetRemoteUrl: (repoPath, url) => ipcRenderer.invoke('git-set-remote-url', repoPath, url),
  gitGetRemoteUrl: (repoPath) => ipcRenderer.invoke('git-get-remote-url', repoPath),
  gitApplyGitignore: (repoPath) => ipcRenderer.invoke('git-apply-gitignore', repoPath),
  gitDeleteHistory: (repoPath) => ipcRenderer.invoke('git-delete-history', repoPath),
  gitCommitAmend: (repoPath) => ipcRenderer.invoke('git-commit-amend', repoPath),
  gitPushForce: (repoPath) => ipcRenderer.invoke('git-push-force', repoPath),
  gitShow: (repoPath, hash, filepath) => ipcRenderer.invoke('git-show', repoPath, hash, filepath),
  gitPullNoFF: (path) => ipcRenderer.invoke('git-pull-no-ff', path),

  // renderer.jsの呼び出し名に合わせて追加・マッピング
  gitLog: (repoPath, depth) => ipcRenderer.invoke('git-log', repoPath, depth), // 旧APIとの互換性用
  gitHistory: (repoPath, depth) => ipcRenderer.invoke('git-log', repoPath, depth), // renderer.jsが使用
  gitGetCommitDetail: (repoPath, oid) => ipcRenderer.invoke('git-commit-detail', repoPath, oid), // 新規追加

  getGitHubUser: () => ipcRenderer.invoke('get-github-user'),
  logoutGitHub: () => ipcRenderer.invoke('logout-github'),

  // リセットとリバート
  gitResetHead: (repoPath, oid) => ipcRenderer.invoke('git-reset-head', repoPath, oid),
  gitRevertCommit: (repoPath, oid) => ipcRenderer.invoke('git-revert-commit', repoPath, oid),

  // ブランチ操作
  gitCreateBranch: (repoPath, branchName) => ipcRenderer.invoke('git-create-branch', repoPath, branchName),
  gitDeleteBranch: (repoPath, branchName) => ipcRenderer.invoke('git-delete-branch', repoPath, branchName),

  // File operations
  saveFile: (filepath, content) => ipcRenderer.invoke('save-file', filepath, content),
  saveClipboardImage: (buffer, targetDir) => ipcRenderer.invoke('save-clipboard-image', buffer, targetDir),
  downloadImage: (url, targetDir) => ipcRenderer.invoke('download-image', url, targetDir),
  loadFile: (filepath) => ipcRenderer.invoke('load-file', filepath),
  renameFile: (oldPath, newName) => ipcRenderer.invoke('rename-file', oldPath, newName),
  moveFile: (srcPath, destPath) => ipcRenderer.invoke('move-file', srcPath, destPath),
  listFiles: (dirPath) => ipcRenderer.invoke('list-files', dirPath),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  deleteFile: (filepath) => ipcRenderer.invoke('delete-file', filepath),
  createDirectory: (dirPath) => ipcRenderer.invoke('create-directory', dirPath),
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // Window operations
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  // ウィンドウの透明度設定
  setWindowOpacity: (opacity) => ipcRenderer.invoke('window-set-opacity', opacity),

  // CSS Snippets
  getCssSnippets: () => ipcRenderer.invoke('get-css-snippets'),
  readCssSnippet: (filename) => ipcRenderer.invoke('read-css-snippet', filename),
  openSnippetsFolder: () => ipcRenderer.invoke('open-snippets-folder'),

  // ファイル選択API
  selectFile: () => ipcRenderer.invoke('select-file'),

  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),

  // PDF
  generatePdf: (htmlContent, options) => ipcRenderer.invoke('generate-pdf', htmlContent, options),
  exportPdf: (htmlContent, options) => ipcRenderer.invoke('export-pdf', htmlContent, options),

  // Utility
  fetchUrlTitle: (url) => ipcRenderer.invoke('fetch-url-title', url),
  fetchUrlMetadata: (url) => ipcRenderer.invoke('fetch-url-metadata', url),

  // Grep検索
  grepSearch: (query, dirPath) => ipcRenderer.invoke('grep-search', query, dirPath),

  // Settings
  loadAppSettings: () => ipcRenderer.invoke('load-app-settings'),
  saveAppSettings: (settings) => ipcRenderer.invoke('save-app-settings', settings),

  // Recent Files
  loadRecentFiles: () => ipcRenderer.invoke('load-recent-files'),
  saveRecentFiles: (files) => ipcRenderer.invoke('save-recent-files', files),

  // Cloud Sync (引数なしに変更)
  startCloudSync: () => ipcRenderer.invoke('sync:start'),
  authDropbox: () => ipcRenderer.invoke('sync:auth-dropbox'),
  authGDrive: () => ipcRenderer.invoke('sync:auth-gdrive'),
  onSyncStatusChange: (callback) => {
    const handler = (event, status) => callback(status);
    ipcRenderer.on('sync:status-change', handler);
    return () => ipcRenderer.removeListener('sync:status-change', handler);
  },

  // Context Menu Helper
  showFileContextMenu: (filePath, isDirectory) => ipcRenderer.send('show-file-context-menu', filePath, isDirectory),
  showEditorContextMenu: () => ipcRenderer.send('show-editor-context-menu'),

  onEditorContextMenuCommand: (callback) => {
    const handler = (event, command) => callback(command);
    ipcRenderer.on('editor-context-menu-command', handler);
    return () => ipcRenderer.removeListener('editor-context-menu-command', handler);
  },

  // Open External Links
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // エクスプローラー連携機能
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
  openPath: (dirPath) => ipcRenderer.invoke('open-path', dirPath),

  // ファイル操作のUndo/Redo ---
  undoFileOperation: () => ipcRenderer.invoke('file:undo'),
  redoFileOperation: () => ipcRenderer.invoke('file:redo'),

  // Event Listeners
  onInitiateRename: (callback) => ipcRenderer.on('initiate-rename', (_event, val) => callback(val)),
  onFileDeleted: (callback) => ipcRenderer.on('file-deleted', (_event, val) => callback(val)),

  // ファイルシステムの変更を監視するイベントリスナー
  onFileSystemChanged: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('file-system-changed', handler);
    return () => ipcRenderer.removeListener('file-system-changed', handler);
  }
};

console.log('Preload script loaded - electronAPI exposed via window');