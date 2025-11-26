// Modules to control application life and create native browser window
const { app, BrowserWindow, ipcMain, dialog, session, shell, Menu, MenuItem } = require('electron')
const path = require('node:path')
const fs = require('fs')
const { exec } = require('child_process')
const iconv = require('iconv-lite')
const os = require('os')
const git = require('isomorphic-git')
const http = require('isomorphic-git/http/node')
const { terminalService } = require('./terminalService');
const got = require('got');

// Cloud Sync Dependencies
const { Dropbox } = require('dropbox');
const { google } = require('googleapis');
const httpModule = require('http'); // 認証用ローカルサーバー
const urlModule = require('url');
require('dotenv').config(); // 環境変数読み込み

// ========== 【重要】APIキー設定エリア ==========
// Dropbox用
const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY;
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET;
// Google Drive用
const GDRIVE_CLIENT_ID = process.env.GDRIVE_CLIENT_ID;
const GDRIVE_CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET;
// ===========================================

// 各ウィンドウごとのカレントディレクトリを保持
const workingDirectories = new Map();
// 各ウィンドウごとのファイルウォッチャーを保持
const fileWatchers = new Map();

let mainWindow = null;

// ========== 設定関連ヘルパー ==========

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
    autoSave: true,
    cloudSync: {
      service: 'none',
      dropbox: { accessToken: null, refreshToken: null },
      gdrive: { tokens: null }
    }
  };
}

/**
 * Save app settings to disk
 */
function saveAppSettings(settings) {
  const settingsPath = path.join(app.getPath('userData'), 'app-settings.json');
  try {
    // 既存の設定を読み込んでマージ（部分更新に対応するため）
    let currentSettings = {};
    if (fs.existsSync(settingsPath)) {
      currentSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
    const newSettings = { ...currentSettings, ...settings };

    fs.writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Failed to save app settings:', error);
    return false;
  }
}

// Recent Files の読み書き
function loadRecentFiles() {
  const recentPath = path.join(app.getPath('userData'), 'recent-files.json');
  try {
    if (fs.existsSync(recentPath)) {
      return JSON.parse(fs.readFileSync(recentPath, 'utf8'));
    }
  } catch (error) {
    console.error('Failed to load recent files:', error);
  }
  return [];
}

function saveRecentFiles(files) {
  const recentPath = path.join(app.getPath('userData'), 'recent-files.json');
  try {
    fs.writeFileSync(recentPath, JSON.stringify(files, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Failed to save recent files:', error);
    return false;
  }
}

// ========== Cloud Sync Logic ==========

// Dropbox Auth
ipcMain.handle('sync:auth-dropbox', async (event) => {
  // キーが未設定の場合のガード
  if (DROPBOX_APP_KEY === 'YOUR_DROPBOX_APP_KEY') {
    return { success: false, error: '開発者用APIキーがmain.jsに設定されていません。' };
  }

  try {
    const REDIRECT_PORT = 3000;
    const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/dropbox`;

    const dbx = new Dropbox({ clientId: DROPBOX_APP_KEY, clientSecret: DROPBOX_APP_SECRET });
    const authUrl = await dbx.auth.getAuthenticationUrl(REDIRECT_URI, null, 'code', 'offline', null, 'none', false);

    shell.openExternal(authUrl);

    return new Promise((resolve) => {
      const server = httpModule.createServer(async (req, res) => {
        if (req.url.startsWith('/auth/dropbox')) {
          const query = urlModule.parse(req.url, true).query;
          const code = query.code;

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>認証成功！</h1><p>このタブを閉じてアプリに戻ってください。</p>');

          // レスポンスを返してから少し待って閉じる
          setTimeout(() => {
            server.close();
          }, 1000);

          try {
            const response = await dbx.auth.getAccessTokenFromCode(REDIRECT_URI, code);
            const tokens = response.result;

            // 設定保存
            const settings = loadAppSettings();
            settings.cloudSync = settings.cloudSync || {};
            settings.cloudSync.service = 'dropbox';
            settings.cloudSync.dropbox = {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token, // offline accessの場合
              tokenExpiresAt: Date.now() + (tokens.expires_in * 1000)
            };
            saveAppSettings(settings);

            resolve({ success: true });
          } catch (err) {
            resolve({ success: false, error: err.message });
          }
        }
      });

      // ★ポート競合エラーハンドリング
      server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
          console.error('Port 3000 is already in use.');
          try { server.close(); } catch (e) { } // 念のため
          resolve({
            success: false,
            error: `ポート${REDIRECT_PORT}が既に使用されています。前回起動した認証プロセスが残っている可能性があります。タスクマネージャー等でNode.jsプロセスを終了してください。`
          });
        } else {
          resolve({ success: false, error: e.message });
        }
      });

      server.listen(REDIRECT_PORT);
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Google Drive Auth
ipcMain.handle('sync:auth-gdrive', async (event) => {
  if (GDRIVE_CLIENT_ID === 'YOUR_GDRIVE_CLIENT_ID') {
    return { success: false, error: '開発者用Google Client IDがmain.jsに設定されていません。' };
  }

  try {
    const REDIRECT_PORT = 3000;
    const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/gdrive`;

    const oauth2Client = new google.auth.OAuth2(
      GDRIVE_CLIENT_ID,
      GDRIVE_CLIENT_SECRET,
      REDIRECT_URI
    );

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/drive.file']
    });

    shell.openExternal(authUrl);

    return new Promise((resolve) => {
      const server = httpModule.createServer(async (req, res) => {
        if (req.url.startsWith('/auth/gdrive')) {
          const query = urlModule.parse(req.url, true).query;
          const code = query.code;

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>認証成功！</h1><p>このタブを閉じてアプリに戻ってください。</p>');

          setTimeout(() => {
            server.close();
          }, 1000);

          try {
            const { tokens } = await oauth2Client.getToken(code);

            const settings = loadAppSettings();
            settings.cloudSync = settings.cloudSync || {};
            settings.cloudSync.service = 'gdrive';
            settings.cloudSync.gdrive = {
              tokens
            };
            saveAppSettings(settings);

            resolve({ success: true });
          } catch (err) {
            resolve({ success: false, error: err.message });
          }
        }
      });

      // ★ポート競合エラーハンドリング
      server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
          console.error('Port 3000 is already in use.');
          try { server.close(); } catch (e) { }
          resolve({
            success: false,
            error: `ポート${REDIRECT_PORT}が既に使用されています。`
          });
        } else {
          resolve({ success: false, error: e.message });
        }
      });

      server.listen(REDIRECT_PORT);
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 同期実行ハンドラ
ipcMain.handle('sync:start', async (event) => {
  const settings = loadAppSettings();
  const webContentsId = event.sender.id;
  const localRoot = workingDirectories.get(webContentsId);

  if (!localRoot) return { success: false, error: '同期するフォルダが開かれていません。' };
  if (!settings.cloudSync || settings.cloudSync.service === 'none') {
    return { success: false, error: '同期サービスが設定されていません。設定画面を確認してください。' };
  }

  const sender = event.sender;
  const sendStatus = (status) => sender.send('sync:status-change', status);

  try {
    sendStatus('syncing');

    if (settings.cloudSync.service === 'dropbox') {
      // 埋め込みキーを使用して同期
      await performDropboxSync(
        {
          ...settings.cloudSync.dropbox,
          clientId: DROPBOX_APP_KEY,
          clientSecret: DROPBOX_APP_SECRET
        },
        localRoot,
        sender
      );
    } else if (settings.cloudSync.service === 'gdrive') {
      await performGDriveSync(
        {
          ...settings.cloudSync.gdrive,
          clientId: GDRIVE_CLIENT_ID,
          clientSecret: GDRIVE_CLIENT_SECRET
        },
        localRoot,
        sender
      );
    }

    sendStatus('idle');
    return { success: true };
  } catch (error) {
    console.error('Sync failed:', error);
    sendStatus('error');
    return { success: false, error: error.message };
  }
});

// --- Dropbox Sync Implementation ---
async function performDropboxSync(config, localRoot, sender) {
  if (!config.accessToken) throw new Error('Dropboxの認証情報がありません。再連携してください。');

  const dbx = new Dropbox({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken
  });

  dbx.auth.setAccessToken(config.accessToken);

  // 1. ローカルファイルリスト取得 (再帰的)
  const getLocalFiles = (dir) => {
    let results = [];
    try {
      const list = fs.readdirSync(dir);
      list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          if (file !== '.git' && file !== 'node_modules') {
            results = results.concat(getLocalFiles(fullPath));
          }
        } else {
          results.push({
            path: fullPath,
            relPath: path.relative(localRoot, fullPath).replace(/\\/g, '/'),
            mtime: stat.mtime
          });
        }
      });
    } catch (e) {
      console.error('Local file scan error:', e);
    }
    return results;
  };
  const localFiles = getLocalFiles(localRoot);

  // 2. クラウドファイルリスト取得
  let cloudFiles = [];
  try {
    let hasMore = true;
    let cursor = null;
    while (hasMore) {
      const res = cursor
        ? await dbx.filesListFolderContinue({ cursor })
        : await dbx.filesListFolder({ path: '', recursive: true });

      cloudFiles = cloudFiles.concat(res.result.entries);
      hasMore = res.result.has_more;
      cursor = res.result.cursor;
    }
  } catch (e) {
    // パスが見つからない場合は空フォルダとみなす
    // "path/not_found/" エラーなどが返る可能性があるため
    console.log('Dropbox list info:', e.message);
  }

  // 3. 比較と同期
  const cloudMap = new Map();
  cloudFiles.forEach(f => {
    if (f['.tag'] === 'file') {
      const relPath = f.path_display.substring(1); // remove leading slash
      cloudMap.set(relPath, f);
    }
  });

  for (const local of localFiles) {
    const cloud = cloudMap.get(local.relPath);
    const dbxPath = '/' + local.relPath;

    if (!cloud) {
      // クラウドにない -> アップロード
      console.log(`Uploading ${local.relPath}`);
      const contents = fs.readFileSync(local.path);
      await dbx.filesUpload({ path: dbxPath, contents, mode: 'overwrite' });
    } else {
      // 両方ある -> 日時比較 (簡易: 2秒の誤差許容)
      const cloudTime = new Date(cloud.client_modified).getTime();
      const localTime = local.mtime.getTime();

      if (localTime > cloudTime + 2000) {
        console.log(`Updating Cloud ${local.relPath}`);
        const contents = fs.readFileSync(local.path);
        await dbx.filesUpload({ path: dbxPath, contents, mode: 'overwrite' });
      } else if (cloudTime > localTime + 2000) {
        console.log(`Updating Local ${local.relPath}`);
        const { result } = await dbx.filesDownload({ path: dbxPath });
        fs.writeFileSync(local.path, result.fileBinary);
        fs.utimesSync(local.path, new Date(), new Date(cloud.client_modified));
      }
      cloudMap.delete(local.relPath); // 処理済み
    }
  }

  // クラウドにしか存在しないファイル -> ダウンロード
  for (const [relPath, cloud] of cloudMap) {
    console.log(`Downloading new file ${relPath}`);
    const localPath = path.join(localRoot, relPath);
    const dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const { result } = await dbx.filesDownload({ path: cloud.path_lower });
    fs.writeFileSync(localPath, result.fileBinary);
    fs.utimesSync(localPath, new Date(), new Date(cloud.client_modified));
  }
}

// --- Google Drive Sync Implementation ---

/**
 * Google Drive同期のメイン処理
 */
async function performGDriveSync(config, localRoot, sender) {
  if (!config.tokens) throw new Error('Google Driveの認証情報がありません。再連携してください。');

  // Google OAuth2クライアントの初期化
  const oauth2Client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret
  );
  oauth2Client.setCredentials(config.tokens);

  // トークンの自動更新をハンドリング（リフレッシュトークン等が更新された場合に保存）
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.access_token || tokens.refresh_token) {
      const settings = loadAppSettings();
      if (settings.cloudSync && settings.cloudSync.gdrive) {
        // 既存のトークン情報とマージして保存
        settings.cloudSync.gdrive.tokens = { ...settings.cloudSync.gdrive.tokens, ...tokens };
        saveAppSettings(settings);
      }
    }
  });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  // 1. 同期ルートフォルダ「MarkdownIDE_Data」のIDを取得（存在しなければ作成）
  const rootFolderId = await getOrCreateDriveFolder(drive, 'MarkdownIDE_Data');
  console.log(`[GDrive] Root Folder ID: ${rootFolderId}`);

  // 2. ローカルファイルスキャン（Dropbox版と同じロジック）
  const getLocalFiles = (dir) => {
    let results = [];
    try {
      const list = fs.readdirSync(dir);
      list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          if (file !== '.git' && file !== 'node_modules') {
            results = results.concat(getLocalFiles(fullPath));
          }
        } else {
          results.push({
            path: fullPath,
            relPath: path.relative(localRoot, fullPath).replace(/\\/g, '/'), // Windowsパス区切りを統一
            mtime: stat.mtime
          });
        }
      });
    } catch (e) {
      console.error('Local file scan error:', e);
    }
    return results;
  };
  const localFiles = getLocalFiles(localRoot);

  // 3. クラウドファイルスキャン（再帰的）
  // ID, 名前, 更新日時, 相対パスを持つオブジェクトのリストを取得
  let cloudFiles = await listDriveFilesRecursive(drive, rootFolderId);

  // 4. 比較と同期実行
  // 検索用にマップ化: relPath -> driveFileObj
  const cloudMap = new Map();
  cloudFiles.forEach(f => {
    cloudMap.set(f.relPath, f);
  });

  // フォルダIDキャッシュ（アップロード時に何度も親フォルダを検索しないようにする）
  // キー: 相対ディレクトリパス, 値: FolderID
  const folderCache = new Map();
  folderCache.set('', rootFolderId); // ルート

  for (const local of localFiles) {
    const cloud = cloudMap.get(local.relPath);

    if (!cloud) {
      // A. クラウドにない -> アップロード
      console.log(`[GDrive] Uploading new file: ${local.relPath}`);
      // 親フォルダのIDを特定・作成
      const parentId = await ensureDriveDirectory(drive, rootFolderId, path.dirname(local.relPath), folderCache);
      await uploadFileToDrive(drive, parentId, path.basename(local.relPath), local.path, local.mtime);
    } else {
      // B. 両方ある -> 日時比較 (2秒の誤差許容)
      const cloudTime = new Date(cloud.modifiedTime).getTime();
      const localTime = local.mtime.getTime();

      if (localTime > cloudTime + 2000) {
        // ローカルが新しい -> クラウドを更新
        console.log(`[GDrive] Updating cloud file: ${local.relPath}`);
        await updateDriveFile(drive, cloud.id, local.path, local.mtime);
      } else if (cloudTime > localTime + 2000) {
        // クラウドが新しい -> ローカルを更新
        console.log(`[GDrive] Updating local file: ${local.relPath}`);
        await downloadDriveFile(drive, cloud.id, local.path, cloud.modifiedTime);
      }
      // 処理済みとしてマップから削除
      cloudMap.delete(local.relPath);
    }
  }

  // C. クラウドにしか存在しないファイル -> ダウンロード
  for (const [relPath, cloud] of cloudMap) {
    console.log(`[GDrive] Downloading new file: ${relPath}`);
    const localPath = path.join(localRoot, relPath);
    const dir = path.dirname(localPath);
    // ローカルフォルダがなければ作成
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    await downloadDriveFile(drive, cloud.id, localPath, cloud.modifiedTime);
  }
}

// --- Google Drive Helper Functions ---

/**
 * 指定名のフォルダを取得、なければ作成してIDを返す
 * @param {object} drive - google.drive instance
 * @param {string} folderName - フォルダ名
 * @param {string} parentId - 親フォルダID (default: 'root')
 * @returns {string} Folder ID
 */
async function getOrCreateDriveFolder(drive, folderName, parentId = 'root') {
  // ゴミ箱以外、かつ親が一致、かつフォルダタイプのものを検索
  const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${folderName}' and trashed = false`;
  const res = await drive.files.list({
    q: q,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  } else {
    // 作成
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    };
    const file = await drive.files.create({
      resource: fileMetadata,
      fields: 'id',
    });
    return file.data.id;
  }
}

/**
 * 指定フォルダ以下の全ファイルを再帰的にリストアップする
 * @param {string} folderId - 探索開始フォルダID
 * @param {string} currentPath - 現在の相対パス (再帰用)
 * @returns {Array} ファイル情報の配列
 */
async function listDriveFilesRecursive(drive, folderId, currentPath = '') {
  let results = [];
  let pageToken = null;

  do {
    // フォルダ直下の子要素を取得
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      spaces: 'drive',
      pageToken: pageToken,
      pageSize: 1000 // 一度の取得数を増やす
    });

    const files = res.data.files;
    for (const file of files) {
      // Windows環境でもパス区切り文字を '/' に統一して相対パスを構築
      const relPath = currentPath ? path.join(currentPath, file.name).replace(/\\/g, '/') : file.name;
      
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        // フォルダなら再帰的に探索
        const children = await listDriveFilesRecursive(drive, file.id, relPath);
        results = results.concat(children);
      } else {
        // ファイルならリストに追加
        results.push({
          id: file.id,
          name: file.name,
          modifiedTime: file.modifiedTime,
          relPath: relPath
        });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return results;
}

/**
 * ローカルの相対ディレクトリパスに対応するDrive上のフォルダIDを確保する
 * (階層構造が存在しない場合は作成する)
 * @param {string} relativeDir - ローカルの相対ディレクトリパス (例: "sub/folder")
 * @param {Map} cache - パスとIDのキャッシュ
 */
async function ensureDriveDirectory(drive, rootId, relativeDir, cache) {
  // 現在のディレクトリ('.')または空文字の場合はルートIDを返す
  if (relativeDir === '.' || relativeDir === '') return rootId;
  
  const normalizedPath = relativeDir.replace(/\\/g, '/');
  if (cache.has(normalizedPath)) return cache.get(normalizedPath);

  // パスを分割して親から順に探索・作成
  const parts = normalizedPath.split('/');
  let currentParentId = rootId;
  let currentPathStack = '';

  for (const part of parts) {
    currentPathStack = currentPathStack ? `${currentPathStack}/${part}` : part;
    
    if (cache.has(currentPathStack)) {
      currentParentId = cache.get(currentPathStack);
    } else {
      // 存在確認と作成 (親IDを指定して作成)
      currentParentId = await getOrCreateDriveFolder(drive, part, currentParentId);
      cache.set(currentPathStack, currentParentId);
    }
  }

  return currentParentId;
}

/**
 * ファイルの新規アップロード
 * @param {string} parentId - 親フォルダID
 * @param {string} name - ファイル名
 * @param {string} localFilePath - ローカルファイルのフルパス
 * @param {Date} mtime - 更新日時
 */
async function uploadFileToDrive(drive, parentId, name, localFilePath, mtime) {
  const fileMetadata = {
    name: name,
    parents: [parentId],
    modifiedTime: mtime.toISOString() // メタデータとして更新日時を設定
  };
  const media = {
    mimeType: 'application/octet-stream',
    body: fs.createReadStream(localFilePath),
  };
  
  await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id',
  });
}

/**
 * ファイルの更新（上書き）
 * @param {string} fileId - 更新対象のファイルID
 */
async function updateDriveFile(drive, fileId, localFilePath, mtime) {
  const fileMetadata = {
    modifiedTime: mtime.toISOString()
  };
  const media = {
    mimeType: 'application/octet-stream',
    body: fs.createReadStream(localFilePath),
  };

  await drive.files.update({
    fileId: fileId,
    resource: fileMetadata,
    media: media,
    fields: 'id',
  });
}

/**
 * ファイルのダウンロード
 * @param {string} fileId - ダウンロード対象のファイルID
 * @param {string} modifiedTimeStr - クラウド側の更新日時文字列
 */
async function downloadDriveFile(drive, fileId, localFilePath, modifiedTimeStr) {
  const dest = fs.createWriteStream(localFilePath);
  
  const res = await drive.files.get(
    { fileId: fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    res.data
      .on('end', () => {
        // ストリーム終了
      })
      .on('error', err => {
        reject(err);
      })
      .pipe(dest);

    dest.on('finish', () => {
      // ファイル書き込み完了後にタイムスタンプを同期
      try {
        const date = new Date(modifiedTimeStr);
        fs.utimesSync(localFilePath, new Date(), date);
        resolve();
      } catch (e) {
        console.error('Failed to set utimes:', e);
        // 時刻設定失敗は致命的エラーにせず完了とする
        resolve();
      }
    });
    
    dest.on('error', err => reject(err));
  });
}

// ========== ファイル/ディレクトリ操作、ターミナル、その他機能 ==========

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
        }
      }
    });
    console.log(`All terminals changed directory to: ${targetPath}`);
  } catch (e) {
    console.error('Failed to change terminals directory:', e);
  }
}

// ディレクトリ監視を開始する関数
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

        // レンダラープロセスへ通知
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

// URLの先頭部分だけを取得する関数
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
          "default-src 'self'; img-src 'self' https: data:; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; font-src 'self' https://cdnjs.cloudflare.com data:; connect-src 'self' https://www.googleapis.com https://*.dropboxapi.com;"
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

    // アイテムをエクスプローラーで表示（選択状態にする）
  ipcMain.handle('show-item-in-folder', async (event, filePath) => {
    shell.showItemInFolder(filePath);
  });

  // フォルダをエクスプローラーで開く
  ipcMain.handle('open-path', async (event, dirPath) => {
    await shell.openPath(dirPath);
  });

  // URLのメタデータ(OGP)を取得するハンドラー (Stream版)
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

  // URLのタイトルを取得するハンドラー (Stream版)
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

  // Recent Files Handlers (Updated for auto-cleanup and file-only filter)
  ipcMain.handle('load-recent-files', () => {
    const files = loadRecentFiles();
    // 存在しないファイルやフォルダをフィルタリング
    const validFiles = files.filter(item => {
        try {
            if (!fs.existsSync(item.path)) return false;
            // ディレクトリは除外してファイルのみにする
            return fs.statSync(item.path).isFile();
        } catch(e) {
            return false;
        }
    });
    
    // リストに変化があれば保存し直す（自動クリーンアップ）
    if (validFiles.length !== files.length) {
        saveRecentFiles(validFiles);
    }
    
    return validFiles;
  });

  ipcMain.handle('save-recent-files', (event, files) => {
    return saveRecentFiles(files);
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
    // 初期フォルダの監視開始
    startFileWatcher(webContentsId, initialFolderPath);
  } else {
    // 指定したパスが無い場合はホームディレクトリにする（安全策）
    const homeDir = os.homedir();
    workingDirectories.set(webContentsId, homeDir);
    // ホームディレクトリの監視開始
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

    // ウォッチャーのクリーンアップ
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

          // 新しいディレクトリの監視を開始
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

// 移動処理
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
      // 変更: ファイルだけでなくフォルダもゴミ箱へ移動
      await shell.trashItem(filepath);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to move file/directory to trash:', error);
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

      // 新しいフォルダの監視を開始
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

// PDFエクスポート（ファイル保存）のIPCハンドラー
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
            /* ブックマークカード用スタイル */
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

// ========== エディタコンテキストメニュー ==========
ipcMain.on('show-editor-context-menu', (event) => {
  const template = [
    { label: 'カット', role: 'cut' },
    { label: 'コピー', role: 'copy' },
    { label: 'ペースト', role: 'paste' },
    { type: 'separator' },
    { label: 'すべてを選択', role: 'selectAll' },
    { type: 'separator' },
    {
      label: '太字',
      click: () => event.sender.send('editor-context-menu-command', 'bold')
    },
    {
      label: '表の挿入',
      click: () => event.sender.send('editor-context-menu-command', 'insert-table')
    },
    {
      label: 'ハイライト',
      submenu: [
        {
          label: '黄色',
          click: () => event.sender.send('editor-context-menu-command', { action: 'highlight', color: '#fff700' })
        },
        {
          label: '赤色',
          click: () => event.sender.send('editor-context-menu-command', { action: 'highlight', color: '#ffcccc' })
        },
        {
          label: '青色',
          click: () => event.sender.send('editor-context-menu-command', { action: 'highlight', color: '#ccf0ff' })
        },
        {
          label: '緑色',
          click: () => event.sender.send('editor-context-menu-command', { action: 'highlight', color: '#ccffcc' })
        }
      ]
    },
    {
      label: 'コードブロック',
      click: () => event.sender.send('editor-context-menu-command', 'code-block')
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
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