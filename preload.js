/**
 * The preload script runs before `index.html` is loaded
 * in the renderer. It has access to web APIs as well as
 * Electron's renderer process modules and some polyfilled
 * Node.js functions.
 *
 * https://www.electronjs.org/docs/latest/tutorial/sandbox
 */
const { contextBridge, ipcRenderer } = require('electron');

// Renderer ProcessにNode.js APIを安全に公開
contextBridge.exposeInMainWorld('electronAPI', {
  // --- Terminal APIs ---
  // Get terminal configuration
  getTerminalConfig: () => ipcRenderer.invoke('terminal:get-config'),

  // Update terminal configuration
  updateTerminalConfig: (updates) => ipcRenderer.invoke('terminal:update-config', updates),

  // 利用可能なシェルの一覧を取得
  getAvailableShells: () => ipcRenderer.invoke('get-available-shells'),

  // 新しいターミナルを作成
  createTerminal: (options) => ipcRenderer.invoke('terminal:create', options),

  // ターミナルを閉じる
  closeTerminal: (terminalId) => ipcRenderer.invoke('terminal:close', terminalId),

  // ターミナルにデータを送信
  writeToTerminal: (terminalId, data) => ipcRenderer.send('pty:write', { terminalId, data }),

  // ターミナルのサイズを変更
  resizeTerminal: (terminalId, cols, rows) => ipcRenderer.send('pty:resize', { terminalId, cols, rows }),

  // Save terminal state
  saveTerminalState: () => ipcRenderer.invoke('terminal:save-state'),

  // ターミナルからのデータを受信
  onTerminalData: (callback) => ipcRenderer.on('pty:data', (event, payload) => {
    callback(payload);
  }),

  // ターミナルの終了を受信
  onTerminalExit: (callback) => ipcRenderer.on('pty:exit', (event, payload) => {
    callback(payload);
  }),

  // Restore terminal state
  onRestoreState: (callback) => ipcRenderer.on('terminal:restore-state', (event, state) => {
    callback(state);
  }),

  // --- Editor & System APIs ---
  // コマンド実行
  executeCommand: (command, currentDir) => {
    return ipcRenderer.invoke('execute-command', command, currentDir);
  },
  // カレントディレクトリ取得
  getCurrentDirectory: () => {
    return ipcRenderer.invoke('get-current-directory');
  },
  // 自動補完候補を取得
  getCompletionCandidates: (prefix, currentDir) => {
    return ipcRenderer.invoke('get-completion-candidates', prefix, currentDir);
  },
  // Git operations
  gitStatus: (repoPath) => {
    return ipcRenderer.invoke('git-status', repoPath);
  },
  gitAdd: (repoPath, filepath) => {
    return ipcRenderer.invoke('git-add', repoPath, filepath);
  },
  gitRemove: (repoPath, filepath) => {
    return ipcRenderer.invoke('git-remove', repoPath, filepath);
  },
  gitCommit: (repoPath, message) => {
    return ipcRenderer.invoke('git-commit', repoPath, message);
  },
  gitPush: (repoPath) => {
    return ipcRenderer.invoke('git-push', repoPath);
  },
  gitPull: (repoPath) => {
    return ipcRenderer.invoke('git-pull', repoPath);
  },
  // File operations
  saveFile: (filepath, content) => {
    return ipcRenderer.invoke('save-file', filepath, content);
  },
  loadFile: (filepath) => {
    return ipcRenderer.invoke('load-file', filepath);
  },
  listFiles: (dirPath) => {
    return ipcRenderer.invoke('list-files', dirPath);
  },
  // ディレクトリ読み込み
  readDirectory: (dirPath) => {
    return ipcRenderer.invoke('read-directory', dirPath);
  },
  // ファイル削除
  deleteFile: (filepath) => {
    return ipcRenderer.invoke('delete-file', filepath);
  },
  // ディレクトリ作成
  createDirectory: (dirPath) => {
    return ipcRenderer.invoke('create-directory', dirPath);
  },
  // フォルダ選択ダイアログ
  selectFolder: () => {
    return ipcRenderer.invoke('select-folder');
  },
  // ウィンドウ操作用のAPI
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  // PDF生成
  generatePdf: (htmlContent) => {
    return ipcRenderer.invoke('generate-pdf', htmlContent);
  }
});

console.log('Preload script loaded - electronAPI exposed');

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector)
    if (element) element.innerText = text
  }

  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type])
  }
});