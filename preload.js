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
  // ★以下を追加: ウィンドウ操作用のAPI
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
})
