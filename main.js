// Modules to control application life and create native browser window
const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron') // shellを追加
const path = require('node:path')
const fs = require('fs')
const { exec } = require('child_process')
const iconv = require('iconv-lite')
const os = require('os')
const git = require('isomorphic-git')
const http = require('isomorphic-git/http/node')
const { terminalService } = require('./terminalService');
const got = require('got'); // URLタイトル取得用

// 各ウィンドウごとのカレントディレクトリを保持
const workingDirectories = new Map();
// ★追加: 各ウィンドウごとのファイルウォッチャーを保持
const fileWatchers = new Map();

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
 * Load app settings from disk
 */
function loadAppSettings() {
  const settingsPath = path.join(app.getPath('userData'), 'app-settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (error) {
    console.error('Failed to load app settings:', error);
  }
  // Default settings
  return {
    fontSize: '16px',
    fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
    theme: 'light',
    autoSave: true
  };
}

/**
 * Save app settings to disk
 */
function saveAppSettings(settings) {
  const settingsPath = path.join(app.getPath('userData'), 'app-settings.json');
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Failed to save app settings:', error);
    return false;
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

// ★追加: ディレクトリ監視を開始する関数
function startFileWatcher(webContentsId, dirPath) {
  // 既存のウォッチャーがあれば停止
  if (fileWatchers.has(webContentsId)) {
    try {
      fileWatchers.get(webContentsId).close();
    } catch (e) {
      console.error('Error closing file watcher:', e);
    }
    fileWatchers.delete(webContentsId);
  }

  try {
    if (!fs.existsSync(dirPath)) return;

    // fs.watchを使ってディレクトリを監視 (recursive: true はWindows/macOSでサポート)
    const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
      if (filename) {
        // .gitフォルダ内の変更は無視する（頻繁すぎるため）
        if (filename.includes('.git') || filename.includes('node_modules')) return;

        // レンダラープロセスへ通知（デバウンスはレンダラー側で行うか、ここで行う）
        // ここでは単純に送る
        const window = BrowserWindow.fromId(webContentsId);
        if (window && !window.isDestroyed()) {
          window.webContents.send('file-system-changed', { eventType, filename });
        }
      }
    });

    watcher.on('error', (error) => {
      console.error(`Watcher error: ${error}`);
    });

    fileWatchers.set(webContentsId, watcher);
    console.log(`Started watching directory: ${dirPath}`);

  } catch (error) {
    console.error(`Failed to start file watcher for ${dirPath}:`, error);
  }
}

// ★高速化ヘルパー: URLの先頭部分だけを取得する関数
const fetchHtmlHead = (url) => {
  return new Promise((resolve, reject) => {
    // Stream APIを使用
    const stream = got.stream(url, {
      timeout: { request: 2000 }, // 2秒でタイムアウト（高速化）
      retry: { limit: 0 }, // リトライなし
      headers: {
        // 一般的なブラウザのUAを偽装（ブロック回避・レスポンス向上）
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const chunks = [];
    let size = 0;
    // 60KBもあれば通常headタグは含まれる
    const MAX_SIZE = 60 * 1024;

    stream.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      const currentData = chunk.toString();

      // サイズ制限超過、または </head> や <body> が見つかったら終了
      if (size > MAX_SIZE || currentData.includes('</head>') || currentData.includes('<body')) {
        stream.destroy(); // ストリームを破棄してダウンロードを中止
        resolve(Buffer.concat(chunks).toString());
      }
    });

    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString());
    });

    stream.on('error', (err) => {
      // destroy()による中断もエラーとして扱われる場合があるため、
      // データが少しでも取れていれば成功とみなす
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks).toString());
      } else {
        // 本当のエラー（接続不可など）
        resolve(''); // rejectせず空文字を返してフォールバックさせる
      }
    });
  });
};

function createWindow() {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,           // OS標準のフレーム(タイトルバーなど)を削除
    autoHideMenuBar: true,  // メニューバーを隠す
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false
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
      // cwdが指定されていない場合、現在開いている親フォルダを使用する
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

  // 外部リンクを開くためのハンドラー
  ipcMain.handle('open-external', async (event, url) => {
    await shell.openExternal(url);
  });

  // ★高速化: URLのメタデータ(OGP)を取得するハンドラー (Stream版)
  ipcMain.handle('fetch-url-metadata', async (event, url) => {
    try {
      // 全文取得(await got)ではなく、先頭だけ取得する関数を使用
      const body = await fetchHtmlHead(url);

      // 簡易的な正規表現でOGPタグを抽出
      const getMetaContent = (prop) => {
        const regex = new RegExp(`<meta\\s+(?:property|name)=["']${prop}["']\\s+content=["']([^"']+)["']`, 'i');
        const match = body.match(regex);
        return match ? match[1] : null;
      };

      const titleRegex = /<title>([^<]*)<\/title>/i;
      const titleMatch = body.match(titleRegex);

      const metadata = {
        title: getMetaContent('og:title') || (titleMatch ? titleMatch[1].trim() : url),
        description: getMetaContent('og:description') || getMetaContent('description') || '',
        image: getMetaContent('og:image') || '',
        url: url,
        domain: new URL(url).hostname
      };

      // HTMLエンティティの簡易デコード
      const decodeEntities = (str) => {
        if (!str) return str;
        return str.replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
      };

      metadata.title = decodeEntities(metadata.title);
      metadata.description = decodeEntities(metadata.description);

      return { success: true, data: metadata };
    } catch (error) {
      console.error('Failed to fetch URL metadata:', error.message);
      return {
        success: false,
        error: error.message,
        data: { title: url, description: '', image: '', url: url, domain: new URL(url).hostname }
      };
    }
  });

  // ★高速化: URLのタイトルを取得するハンドラー (Stream版)
  ipcMain.handle('fetch-url-title', async (event, url) => {
    try {
      const body = await fetchHtmlHead(url);
      const match = body.match(/<title>([^<]*)<\/title>/i);
      if (match && match[1]) {
        return match[1].trim();
      }
      return url;
    } catch (error) {
      return url;
    }
  });

  // ウィンドウ操作用のIPCハンドラー
  ipcMain.handle('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.handle('window-maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.handle('window-close', () => {
    if (mainWindow) mainWindow.close();
  });

  // Settings Handlers
  ipcMain.handle('load-app-settings', () => {
    return loadAppSettings();
  });

  ipcMain.handle('save-app-settings', (event, settings) => {
    return saveAppSettings(settings);
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

  // 初期状態で開きたいフォルダ（保管庫）のパスを指定
  const initialFolderPath = path.join(__dirname, 'markdown_vault');

  if (fs.existsSync(initialFolderPath)) {
    workingDirectories.set(webContentsId, initialFolderPath);
    // ★追加: 初期フォルダの監視開始
    startFileWatcher(webContentsId, initialFolderPath);
  } else {
    // 指定したパスが無い場合はホームディレクトリにする（安全策）
    const homeDir = os.homedir();
    workingDirectories.set(webContentsId, homeDir);
    // ★追加: ホームディレクトリの監視開始
    startFileWatcher(webContentsId, homeDir);
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

    // ★追加: ウォッチャーのクリーンアップ
    if (fileWatchers.has(webContentsId)) {
      try {
        fileWatchers.get(webContentsId).close();
      } catch (e) { /* ignore */ }
      fileWatchers.delete(webContentsId);
    }

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

          // 内部コマンドでCDが実行された場合もターミナルを同期
          changeAllTerminalsDirectory(newPath);

          // ★追加: 新しいディレクトリの監視を開始
          startFileWatcher(webContentsId, newPath);

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

// リネーム処理
ipcMain.handle('rename-file', async (event, oldPath, newName) => {
  try {
    const dir = path.dirname(oldPath);
    const ext = path.extname(oldPath);

    // 新しい名前が拡張子を含んでいない場合、元の拡張子を維持する
    // newNameに拡張子があるかどうかをチェック
    let newFilename = newName;
    if (!path.extname(newName) && ext) {
      newFilename += ext;
    }

    const newPath = path.join(dir, newFilename);

    // 同じ名前なら何もしない
    if (oldPath === newPath) return { success: true, path: oldPath };

    // 移動先に同名ファイルがある場合はエラー
    if (fs.existsSync(newPath)) {
      return { success: false, error: '同名のファイルが既に存在します。' };
    }

    fs.renameSync(oldPath, newPath);
    return { success: true, path: newPath };
  } catch (error) {
    console.error('Failed to rename file:', error);
    return { success: false, error: error.message };
  }
});

// ★追加: 移動処理
ipcMain.handle('move-file', async (event, oldPath, newPath) => {
  try {
    // 移動先に同名ファイルがある場合はエラー
    if (fs.existsSync(newPath)) {
      return { success: false, error: '移動先に同名のファイルまたはフォルダが存在します。' };
    }

    fs.renameSync(oldPath, newPath);
    return { success: true, path: newPath };
  } catch (error) {
    console.error('Failed to move file:', error);
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
      // ファイルだけでなくフォルダも再帰的に削除できるように変更
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

      // フォルダ変更時に全ターミナルのディレクトリを同期
      changeAllTerminalsDirectory(selectedPath);

      // ★追加: 新しいフォルダの監視を開始
      startFileWatcher(webContentsId, selectedPath);

      return { success: true, path: selectedPath };
    } else {
      return { success: false, path: null };
    }
  } catch (error) {
    console.error('Failed to select folder:', error);
    return { success: false, error: error.message };
  }
});

// PDF生成 (プレビュー用 - Base64返し) のIPC ハンドラー
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
    const htmlTemplate = getPdfHtmlTemplate(htmlContent);

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

// ★追加: PDFエクスポート（ファイル保存）のIPCハンドラー
ipcMain.handle('export-pdf', async (event, htmlContent) => {
  try {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow) {
      throw new Error('Main window not found');
    }

    // 保存先ダイアログを開く
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'PDFとしてエクスポート',
      defaultPath: 'document.pdf',
      filters: [
        { name: 'PDF Files', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (canceled || !filePath) {
      return { success: false, canceled: true };
    }

    // 一時ウィンドウでレンダリング
    const pdfWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const htmlTemplate = getPdfHtmlTemplate(htmlContent);
    await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlTemplate)}`);

    // PDF生成
    const pdfData = await pdfWindow.webContents.printToPDF({
      marginsType: 1,
      pageSize: 'A4',
      printBackground: true,
      printSelectionOnly: false
    });

    pdfWindow.close();

    // ファイルに保存
    fs.writeFileSync(filePath, pdfData);

    return { success: true, path: filePath };

  } catch (error) {
    console.error('Failed to export PDF:', error);
    return { success: false, error: error.message };
  }
});

// HTMLテンプレートを生成するヘルパー関数
function getPdfHtmlTemplate(htmlContent) {
  return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body {
              font-family: "Segoe UI", "Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN", "Hiragino Sans", Meiryo, sans-serif;
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
            /* List Styling */
            ul, ol {
              padding-left: 2em;
              margin-bottom: 1em;
            }
            ol ol, ul ol, ol ul, ul ul {
                margin-bottom: 0;
            }
            li {
              margin-bottom: 0.2em; /* 0.5em から変更 */
              white-space: pre-wrap; /* リストのネストのインデント用スペースを保持 */
            }
            /* リスト内の段落マージンを削除して隙間を詰める */
            li > p {
              margin-top: 0;
              margin-bottom: 0;
            }
            /* Task List (Checklist) Styling */
            li:has(input[type="checkbox"]) {
              list-style-type: none;
              position: relative;
            }
            input[type="checkbox"] {
              margin-right: 0.5em;
              vertical-align: middle;
            }
            
            /* Mark styling for ==highlight== */
            mark {
              background-color: #fff700;
              color: black;
              padding: 0 2px;
              border-radius: 2px;
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
            img {
              max-width: 100%;
            }
            /* 改ページ用スタイル */
            .page-break {
              page-break-after: always;
              break-after: page;
              display: block;
              height: 0;
              margin: 0;
              border: none;
            }
            /* ★追加: ブックマークカード用スタイル */
            .cm-bookmark-widget {
                display: flex;
                width: 100%;
                max-width: 100%;
                height: 120px;
                border: 1px solid #e5e7eb;
                border-radius: 6px;
                overflow: hidden;
                margin: 16px 0;
                background-color: #ffffff;
                text-decoration: none;
                color: inherit;
                page-break-inside: avoid;
            }
            .cm-bookmark-content {
                flex: 1;
                padding: 12px 16px;
                display: flex;
                flex-direction: column;
                justify-content: space-between;
                overflow: hidden;
                min-width: 0;
            }
            .cm-bookmark-title {
                font-size: 14px;
                font-weight: 600;
                color: #111827;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-bottom: 4px;
                line-height: 1.4;
            }
            .cm-bookmark-desc {
                font-size: 12px;
                color: #6b7280;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
                overflow: hidden;
                line-height: 1.5;
                margin: 0;
            }
            .cm-bookmark-meta {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-top: 8px;
                font-size: 12px;
                color: #6b7280;
            }
            .cm-bookmark-favicon {
                width: 16px;
                height: 16px;
                object-fit: contain;
            }
            .cm-bookmark-cover {
                width: 33%;
                max-width: 240px;
                min-width: 120px;
                height: 100%;
                border-left: 1px solid #f3f4f6;
                position: relative;
            }
            .cm-bookmark-image {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
            }
          </style>
        </head>
        <body>
          ${htmlContent}
        </body>
      </html>
    `;
}

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