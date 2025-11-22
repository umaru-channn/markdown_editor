// Modules to control application life and create native browser window
const { app, BrowserWindow, ipcMain, dialog, session } = require('electron')
const path = require('node:path')
const fs = require('fs')
const { exec } = require('child_process')
const iconv = require('iconv-lite')
const os = require('os')
const git = require('isomorphic-git')
const http = require('isomorphic-git/http/node')
const { terminalService } = require('./terminalService');

// 各ウィンドウごとのカレントディレクトリを保持
const workingDirectories = new Map();
let mainWindow = null;

/**
 * Load terminal state from disk
 */
function loadTerminalState() {
  const statePath = path.join(app.getPath('userData'), 'terminal-state.json');
  try {
    if (fs.existsSync(statePath)) {
      const stateData = fs.readFileSync(statePath, 'utf8');
      return JSON.parse(stateData);
    }
  } catch (error) {
    console.error('Failed to load terminal state:', error);
  }
  return null;
}

/**
 * Save terminal state to disk
 */
function saveTerminalState() {
  const statePath = path.join(app.getPath('userData'), 'terminal-state.json');
  try {
    const state = terminalService.getTerminalState();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save terminal state:', error);
  }
}

/**
 * 全ての起動中ターミナルのカレントディレクトリを変更するヘルパー関数
 * @param {string} targetPath - 移動先のディレクトリパス
 */
function changeAllTerminalsDirectory(targetPath) {
  try {
    const terminals = terminalService.getAllTerminals();
    terminals.forEach(term => {
      if (!term.isDisposed) {
        const shellName = (term.shellName || '').toLowerCase();
        let cmd = '';
        
        // プラットフォームとシェルに応じてコマンドを生成
        if (process.platform === 'win32') {
          // Windowsの場合
          if (shellName.includes('cmd') || shellName.includes('command prompt')) {
            // cmd.exe: /d オプションでドライブ変更も対応
            cmd = `cd /d "${targetPath}"\r`;
          } else if (shellName.includes('powershell')) {
            // PowerShell
            cmd = `cd "${targetPath}"\r`;
          } else {
            // Git Bash (bash.exe) やその他Unix互換シェル
            // Windowsパスのバックスラッシュをスラッシュに変換して渡すのが安全
            const unixPath = targetPath.replace(/\\/g, '/');
            cmd = `cd "${unixPath}"\r`;
          }
        } else {
          // macOS / Linux (bash, zsh, etc.)
          cmd = `cd "${targetPath}"\r`;
        }

        if (cmd) {
          // コマンドを送信（Enterキー相当の \r を含む）
          term.write(cmd);
          // 視覚的にプロンプトを更新するために改行を追加で送る場合もあるが、基本は上記でOK
        }
      }
    });
    console.log(`All terminals changed directory to: ${targetPath}`);
  } catch (e) {
    console.error('Failed to change terminals directory:', e);
  }
}

function createWindow() {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,           // ★追加: OS標準のフレーム(タイトルバーなど)を削除
    autoHideMenuBar: true,  // ★追加: メニューバーを隠す
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  // CSPヘッダーを設定する処理
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; img-src 'self' https: data:; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; font-src 'self' https://cdnjs.cloudflare.com data:;"
        ]
      }
    })
  })

  // --- Integrated Terminal Setup with TerminalService ---
  
  // Set up terminal service event handlers
  terminalService.on('terminal-data', ({ terminalId, data }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { terminalId, data });
    }
  });

  terminalService.on('terminal-exit', ({ terminalId, exitCode, signal }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { terminalId, exitCode });
    }
  });

  terminalService.on('terminal-error', ({ terminalId, error }) => {
    console.error(`Terminal ${terminalId} error:`, error);
  });

  // Get terminal configuration
  ipcMain.handle('terminal:get-config', () => {
    return terminalService.getConfig();
  });

  // Update terminal configuration
  ipcMain.handle('terminal:update-config', (event, updates) => {
    terminalService.updateConfig(updates);
    return terminalService.getConfig();
  });

  // Get available shells handler
  ipcMain.handle('get-available-shells', () => {
    const shells = terminalService.getAvailableShells();
    console.log('Get available shells called, returning:', shells);
    return shells;
  });

  // Create new terminal handler
  ipcMain.handle('terminal:create', (event, { profileName, cwd }) => {
    try {
      // ★変更: cwdが指定されていない場合、現在開いている親フォルダを使用する
      let targetCwd = cwd;
      if (!targetCwd) {
        const webContentsId = event.sender.id;
        targetCwd = workingDirectories.get(webContentsId);
      }

      // ターゲットCWDがまだない（初期状態など）場合はホームディレクトリなどをフォールバックに使用
      if (!targetCwd) {
        targetCwd = os.homedir();
      }

      console.log(`Creating terminal with CWD: ${targetCwd}`);
      const terminal = terminalService.createTerminal(profileName, targetCwd);
      return {
        terminalId: terminal.id,
        shellName: terminal.shellName,
        cols: terminal.dimensions.cols,
        rows: terminal.dimensions.rows
      };
    } catch (error) {
      console.error('Failed to create terminal:', error);
      throw error;
    }
  });

  // Send data to specific terminal
  ipcMain.on('pty:write', (event, { terminalId, data }) => {
    try {
      const terminal = terminalService.getTerminal(terminalId);
      if (terminal && !terminal.isDisposed) {
        terminal.write(data);
      } else if (!terminal) {
        console.warn(`Terminal ${terminalId} not found for write operation`);
      }
    } catch (error) {
      console.error(`Error writing to terminal ${terminalId}:`, error.message);
    }
  });

  // Resize specific terminal
  ipcMain.on('pty:resize', (event, { terminalId, cols, rows }) => {
    try {
      const terminal = terminalService.getTerminal(terminalId);
      if (terminal && !terminal.isDisposed) {
        terminal.resize(cols, rows);
      }
    } catch (error) {
      console.error(`Error resizing terminal ${terminalId}:`, error.message);
    }
  });

  // Close specific terminal
  ipcMain.handle('terminal:close', async (event, terminalId) => {
    try {
      console.log(`IPC: Closing terminal ${terminalId}`);
      const result = terminalService.closeTerminal(terminalId);
      
      // Wait a bit for the process to fully clean up
      await new Promise(resolve => setTimeout(resolve, 100));
      
      console.log(`IPC: Terminal ${terminalId} close completed`);
      return result;
    } catch (error) {
      console.error(`Error closing terminal ${terminalId}:`, error);
      return false;
    }
  });

  // Save terminal state
  ipcMain.handle('terminal:save-state', () => {
    saveTerminalState();
    return true;
  });
  
  // --- End of Terminal Setup ---

  // and load the index.html of the app.
  mainWindow.loadFile('index.html')

  // ★追加: ウィンドウ操作用のIPCハンドラー
  ipcMain.handle('window-minimize', () => {
    if(mainWindow) mainWindow.minimize();
  });

  ipcMain.handle('window-maximize', () => {
    if(mainWindow) {
        if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
        } else {
        mainWindow.maximize();
        }
    }
  });

  ipcMain.handle('window-close', () => {
    if(mainWindow) mainWindow.close();
  });

  // Open the DevTools.
  if (process.env.NODE_ENV === 'development') {
    try {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    } catch { /* no-op */ }
  }

  // Restore terminal state after window is ready
  mainWindow.webContents.once('did-finish-load', () => {
    const savedState = loadTerminalState();
    if (savedState && savedState.terminals && savedState.terminals.length > 0) {
      // Send restore signal to renderer
      mainWindow.webContents.send('terminal:restore-state', savedState);
    }
  });

  // webContents IDを取得（ウィンドウ破棄前に保存）
  const webContentsId = mainWindow.webContents.id;

  // ★変更: 初期状態で開きたいフォルダ（保管庫）のパスを指定
  const initialFolderPath = 'C:\\Users\\it222184.TSITCL\\electron_app\\markdown_editor\\markdown_vault';

  if (fs.existsSync(initialFolderPath)) {
    workingDirectories.set(webContentsId, initialFolderPath);
  } else {
    // 指定したパスが無い場合はホームディレクトリにする（安全策）
    console.log('指定されたフォルダが見つかりません。ホームディレクトリを使用します。');
    workingDirectories.set(webContentsId, os.homedir());
  }

  // Save state periodically
  const saveInterval = setInterval(() => {
    try {
      saveTerminalState();
    } catch (error) {
      console.error('Failed to save terminal state:', error);
    }
  }, 30000); // Every 30 seconds

  // ウィンドウが閉じられたらマップから削除
  mainWindow.on('closed', () => {
    clearInterval(saveInterval);
    workingDirectories.delete(webContentsId);
    mainWindow = null;
  });
}

// カレントディレクトリを取得
ipcMain.handle('get-current-directory', async (event) => {
  const webContentsId = event.sender.id;
  return workingDirectories.get(webContentsId) || os.homedir();
});

// 自動補完候補を取得
ipcMain.handle('get-completion-candidates', async (event, prefix, currentDir) => {
  return new Promise((resolve) => {
    const cwd = currentDir || os.homedir();

    // プレフィックスからパスとファイル名を分離
    const lastSlashIndex = Math.max(prefix.lastIndexOf('\\'), prefix.lastIndexOf('/'));
    let dirPath, filePrefix;

    if (lastSlashIndex >= 0) {
      dirPath = prefix.substring(0, lastSlashIndex + 1);
      filePrefix = prefix.substring(lastSlashIndex + 1);
    } else {
      dirPath = '';
      filePrefix = prefix;
    }

    // 検索するディレクトリを決定
    const searchDir = dirPath ? path.resolve(cwd, dirPath) : cwd;

    // ディレクトリが存在しない場合
    if (!fs.existsSync(searchDir)) {
      resolve([]);
      return;
    }

    try {
      // ディレクトリ内のファイル・フォルダを取得
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });

      // プレフィックスにマッチするものをフィルタ
      const candidates = entries
        .filter(entry => {
          const name = entry.name.toLowerCase();
          const searchPrefix = filePrefix.toLowerCase();
          return name.startsWith(searchPrefix);
        })
        .map(entry => {
          const fullName = dirPath + entry.name;
          // ディレクトリの場合は末尾に \ を追加
          return entry.isDirectory() ? fullName + '\\' : fullName;
        })
        .sort();

      resolve(candidates);
    } catch (err) {
      resolve([]);
    }
  });
});

// IPC handler for executing terminal commands
ipcMain.handle('execute-command', async (event, command, currentDir) => {
  return new Promise((resolve) => {
    const webContentsId = event.sender.id;
    const cwd = currentDir || workingDirectories.get(webContentsId) || os.homedir();

    // cdコマンドの特別な処理
    const trimmedCommand = command.trim();
    const cdMatch = trimmedCommand.match(/^cd\s+(.+)$/i);

    if (cdMatch) {
      // cd <path> の形式
      let targetPath = cdMatch[1].trim();

      // cd /d オプションの処理
      if (targetPath.toLowerCase().startsWith('/d ')) {
        targetPath = targetPath.substring(3).trim();
      }

      // 引用符を削除
      targetPath = targetPath.replace(/^["']|["']$/g, '');

      // パスを解決
      let newPath;
      if (path.isAbsolute(targetPath)) {
        newPath = targetPath;
      } else if (targetPath === '..') {
        // 親ディレクトリへ移動
        newPath = path.dirname(cwd);
      } else if (targetPath === '.') {
        // 現在のディレクトリ（変更なし）
        newPath = cwd;
      } else {
        // 相対パス
        newPath = path.resolve(cwd, targetPath);
      }

      // パスを正規化
      newPath = path.normalize(newPath);

      // ディレクトリが存在するか確認
      try {
        if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
          workingDirectories.set(webContentsId, newPath);
          
          // ★追加: 内部コマンドでCDが実行された場合もターミナルを同期
          changeAllTerminalsDirectory(newPath);

          resolve({
            success: true,
            output: '',
            cwd: newPath
          });
        } else {
          resolve({
            success: false,
            output: `指定されたパスが見つかりません。: ${targetPath}`,
            cwd: cwd
          });
        }
      } catch (err) {
        resolve({
          success: false,
          output: `エラー: ${err.message}`,
          cwd: cwd
        });
      }
      return;
    } else if (trimmedCommand.toLowerCase() === 'cd' || trimmedCommand.toLowerCase() === 'cd.') {
      // cd だけの場合は現在のディレクトリを表示
      resolve({
        success: true,
        output: cwd,
        cwd: cwd
      });
      return;
    }

    // その他のコマンドを実行
    exec(command, {
      encoding: 'buffer',
      shell: 'cmd.exe',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      cwd: cwd
    }, (error, stdout, stderr) => {
      if (error) {
        const stderrText = stderr ? iconv.decode(Buffer.from(stderr), 'cp932') : '';
        const errorText = error.message ? error.message : '';
        resolve({
          success: false,
          output: stderrText || errorText,
          cwd: cwd
        });
      } else {
        const stdoutText = stdout ? iconv.decode(Buffer.from(stdout), 'cp932') : '';
        const stderrText = stderr ? iconv.decode(Buffer.from(stderr), 'cp932') : '';
        resolve({
          success: true,
          output: stdoutText || stderrText || '',
          cwd: cwd
        });
      }
    });
  });
});

// Git operations
ipcMain.handle('git-status', async (event, repoPath) => {
  try {
    const dir = repoPath || os.homedir();
    const matrix = await git.statusMatrix({ fs, dir });

    const staged = [];
    const unstaged = [];

    // statusMatrix returns [filepath, HEADStatus, WorkdirStatus, StageStatus]
    // https://isomorphic-git.org/docs/en/statusMatrix
    for (const [filepath, HEADStatus, WorkdirStatus, StageStatus] of matrix) {
      // Skip unmodified files
      if (HEADStatus === 1 && WorkdirStatus === 1 && StageStatus === 1) continue;

      // Unstaged changes (workdir different from stage)
      if (WorkdirStatus !== StageStatus) {
        unstaged.push({ filepath, status: getStatusText(HEADStatus, WorkdirStatus, StageStatus, 'workdir') });
      }

      // Staged changes (stage different from HEAD)
      if (StageStatus !== HEADStatus) {
        staged.push({ filepath, status: getStatusText(HEADStatus, WorkdirStatus, StageStatus, 'stage') });
      }
    }

    return { success: true, staged, unstaged };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Helper function to get status text
function getStatusText(HEADStatus, WorkdirStatus, StageStatus, type) {
  if (type === 'workdir') {
    if (HEADStatus === 0 && WorkdirStatus === 2) return 'new';
    if (HEADStatus === 1 && WorkdirStatus === 2) return 'modified';
    if (HEADStatus === 1 && WorkdirStatus === 0) return 'deleted';
  } else if (type === 'stage') {
    if (HEADStatus === 0 && StageStatus === 2) return 'added';
    if (HEADStatus === 1 && StageStatus === 2) return 'modified';
    if (HEADStatus === 1 && StageStatus === 0) return 'deleted';
  }
  return 'unknown';
}

ipcMain.handle('git-add', async (event, repoPath, filepath) => {
  try {
    const dir = repoPath || os.homedir();
    await git.add({ fs, dir, filepath });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('git-remove', async (event, repoPath, filepath) => {
  try {
    const dir = repoPath || os.homedir();
    await git.remove({ fs, dir, filepath });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('git-commit', async (event, repoPath, message) => {
  try {
    const dir = repoPath || os.homedir();

    // Get author info from git config or use defaults
    let author = {
      name: 'User',
      email: 'user@example.com'
    };

    try {
      const name = await git.getConfig({ fs, dir, path: 'user.name' });
      const email = await git.getConfig({ fs, dir, path: 'user.email' });
      if (name) author.name = name;
      if (email) author.email = email;
    } catch (e) {
      // Use defaults if config not found
    }

    const sha = await git.commit({
      fs,
      dir,
      message,
      author
    });

    return { success: true, sha };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('git-push', async (event, repoPath) => {
  try {
    const dir = repoPath || os.homedir();
    await git.push({
      fs,
      http,
      dir,
      remote: 'origin',
      ref: 'main'
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('git-pull', async (event, repoPath) => {
  try {
    const dir = repoPath || os.homedir();
    await git.pull({
      fs,
      http,
      dir,
      remote: 'origin',
      ref: 'main',
      singleBranch: true
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// File operations
ipcMain.handle('save-file', async (event, filepath, content) => {
  try {
    const webContentsId = event.sender.id;
    const cwd = workingDirectories.get(webContentsId) || os.homedir();
    const fullPath = path.isAbsolute(filepath) ? filepath : path.join(cwd, filepath);

    // Create directory if it doesn't exist
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf8');
    return { success: true, path: fullPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-file', async (event, filepath) => {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    return content;
  } catch (error) {
    console.error('Failed to load file:', error);
    throw error;
  }
});

ipcMain.handle('read-directory', async (event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      path: path.join(dirPath, entry.name)
    })).sort((a, b) => {
      // フォルダを先に表示
      if (a.isDirectory !== b.isDirectory) {
        return b.isDirectory ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    });
    return items;
  } catch (error) {
    console.error('Failed to read directory:', error);
    return [];
  }
});

ipcMain.handle('delete-file', async (event, filepath) => {
  try {
    if (fs.existsSync(filepath)) {
      // ★変更: ファイルだけでなくフォルダも再帰的に削除できるように変更
      fs.rmSync(filepath, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to delete file/directory:', error);
    throw error;
  }
});

ipcMain.handle('create-directory', async (event, dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return true;
  } catch (error) {
    console.error('Failed to create directory:', error);
    throw error;
  }
});

ipcMain.handle('list-files', async (event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath);
    return entries;
  } catch (error) {
    console.error('Failed to list files:', error);
    return [];
  }
});

// フォルダ選択ダイアログのIPC ハンドラー
ipcMain.handle('select-folder', async (event) => {
  try {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'フォルダを選択してください'
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const selectedPath = result.filePaths[0];
      // カレントディレクトリを更新
      const webContentsId = event.sender.id;
      workingDirectories.set(webContentsId, selectedPath);
      
      // ★追加: フォルダ変更時に全ターミナルのディレクトリを同期
      changeAllTerminalsDirectory(selectedPath);

      return { success: true, path: selectedPath };
    } else {
      return { success: false, path: null };
    }
  } catch (error) {
    console.error('Failed to select folder:', error);
    return { success: false, error: error.message };
  }
});

// PDF生成のIPC ハンドラー
ipcMain.handle('generate-pdf', async (event, htmlContent) => {
  try {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow) {
      throw new Error('Main window not found');
    }

    // Create a temporary BrowserWindow for PDF generation
    const pdfWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    // Load HTML content
    const htmlTemplate = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body {
              font-family: Arial, sans-serif;
              padding: 40px;
              line-height: 1.6;
              color: #333;
            }
            h1, h2, h3, h4, h5, h6 {
              margin-top: 24px;
              margin-bottom: 16px;
              font-weight: 600;
            }
            p {
              margin-bottom: 16px;
            }
            code {
              background-color: #f6f8fa;
              padding: 2px 6px;
              border-radius: 3px;
              font-family: monospace;
            }
            pre {
              background-color: #f6f8fa;
              padding: 16px;
              border-radius: 6px;
              overflow-x: auto;
            }
            pre code {
              padding: 0;
              background-color: transparent;
            }
            blockquote {
              border-left: 4px solid #ddd;
              padding-left: 16px;
              color: #666;
              margin: 16px 0;
            }
            table {
              border-collapse: collapse;
              width: 100%;
              margin: 16px 0;
            }
            table th, table td {
              border: 1px solid #ddd;
              padding: 8px;
              text-align: left;
            }
            table th {
              background-color: #f6f8fa;
              font-weight: 600;
            }
          </style>
        </head>
        <body>
          ${htmlContent}
        </body>
      </html>
    `;

    await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlTemplate)}`);

    // Generate PDF
    const pdfData = await pdfWindow.webContents.printToPDF({
      marginsType: 1,
      pageSize: 'A4',
      printBackground: true,
      printSelectionOnly: false
    });

    // Close the temporary window
    pdfWindow.close();

    // Return PDF as base64
    return pdfData.toString('base64');
  } catch (error) {
    console.error('Failed to generate PDF:', error);
    throw error;
  }
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', function () {
  // Save terminal state before quitting
  saveTerminalState();
  
  // Dispose all terminals
  terminalService.dispose();

  if (process.platform !== 'darwin') app.quit()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.