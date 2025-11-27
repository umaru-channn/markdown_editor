/**
 * Dropbox同期サービス
 * Remotely Save (Open Source) の fsDropbox.ts のロジックを参考に、
 * Electron環境向けに簡略化して実装。
 */
class DropboxSyncService {
    constructor() {
        this.accessToken = localStorage.getItem('dropbox_access_token') || '';
        this.basePath = ''; // ローカルの同期ルートパス
    }

    setAccessToken(token) {
        this.accessToken = token;
        localStorage.setItem('dropbox_access_token', token);
    }

    setBasePath(path) {
        this.basePath = path;
    }

    getHeaders(contentType = 'application/json') {
        const headers = {
            'Authorization': `Bearer ${this.accessToken}`
        };
        if (contentType) {
            headers['Content-Type'] = contentType;
        }
        return headers;
    }

    /**
     * Dropbox API引数ヘッダー用にJSONをASCII化するヘルパー
     * 日本語などの非ASCII文字を \uXXXX 形式にエスケープします
     */
    escapeDropboxArg(args) {
        const charsToEscape = /[\u007f-\uffff]/g;
        return JSON.stringify(args).replace(charsToEscape, function (c) {
            return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
        });
    }

    /**
     * Dropbox上のファイル一覧を取得（再帰的）
     */
    async listRemoteFiles() {
        const files = [];
        let hasMore = true;
        let cursor = null;

        while (hasMore) {
            let url = 'https://api.dropboxapi.com/2/files/list_folder';
            let body = {
                path: '', // アプリフォルダのルート
                recursive: true,
                include_media_info: false,
                include_deleted: false,
                include_has_explicit_shared_members: false
            };

            if (cursor) {
                url = 'https://api.dropboxapi.com/2/files/list_folder/continue';
                body = { cursor };
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Dropbox List Error: ${err}`);
            }

            const data = await response.json();
            
            data.entries.forEach(entry => {
                if (entry['.tag'] === 'file') {
                    files.push({
                        path: entry.path_display, // 例: "/memo.md"
                        relativePath: entry.path_display.substring(1), // 先頭のスラッシュを除去
                        mtime: new Date(entry.client_modified).getTime(), // DropboxはUTC
                        size: entry.size,
                        rev: entry.rev
                    });
                }
            });

            hasMore = data.has_more;
            cursor = data.cursor;
        }
        return files;
    }

    /**
     * ファイルをアップロード
     * @param {string} localFullPath ローカルの絶対パス
     * @param {string} remotePath Dropbox上のパス (例: "/memo.md")
     */
    async uploadFile(localFullPath, remotePath) {
        // ファイル内容を読み込む
        const contentResult = await window.api.readFile(localFullPath);
        if (!contentResult.success) throw new Error(`Read Error: ${localFullPath}`);
        
        // テキストファイルとして扱う（バイナリが必要な場合はメインプロセスでBuffer処理が必要）
        const fileContent = contentResult.content;

        // Dropbox Upload API (Dropbox-API-Arg ヘッダーを使用)
        const args = {
            path: remotePath,
            mode: 'overwrite', // 上書き
            autorename: false,
            mute: false,
            strict_conflict: false
        };

        // fetchのbodyに直接データを入れるため、octet-streamにする
        const headers = {
            'Authorization': `Bearer ${this.accessToken}`,
            // ★修正: 日本語パスに対応するためエスケープ処理を通す
            'Dropbox-API-Arg': this.escapeDropboxArg(args),
            'Content-Type': 'application/octet-stream'
        };

        const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
            method: 'POST',
            headers: headers,
            body: fileContent
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Upload Error: ${err}`);
        }
        return await response.json();
    }

    /**
     * ファイルをダウンロード
     */
    async downloadFile(remotePath, localFullPath) {
        const args = {
            path: remotePath
        };

        const headers = {
            'Authorization': `Bearer ${this.accessToken}`,
            // ★修正: 日本語パスに対応するためエスケープ処理を通す
            'Dropbox-API-Arg': this.escapeDropboxArg(args)
        };

        const response = await fetch('https://content.dropboxapi.com/2/files/download', {
            method: 'POST',
            headers: headers
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Download Error: ${err}`);
        }

        const text = await response.text();
        
        // ディレクトリ作成（必要な場合）
        const dir = localFullPath.substring(0, localFullPath.lastIndexOf(navigator.platform.includes('Win') ? '\\' : '/'));
        await window.api.createDirectory(dir);

        // 保存
        await window.api.saveFile({
            filePath: localFullPath,
            content: text
        });
    }

    /**
     * 同期実行（簡易版: Newer Wins）
     * @param {Function} logCallback 進捗ログ用コールバック
     */
    async sync(logCallback) {
        if (!this.accessToken) throw new Error("アクセストークンが設定されていません。");
        if (!this.basePath) throw new Error("同期するローカルフォルダが開かれていません。");

        logCallback("同期を開始します...");

        // 1. リモート情報の取得
        logCallback("Dropboxのファイル一覧を取得中...");
        const remoteFiles = await this.listRemoteFiles();
        const remoteMap = new Map(remoteFiles.map(f => [f.relativePath, f]));

        // 2. ローカル情報の取得
        logCallback("ローカルファイル一覧を取得中...");
        const localListResult = await window.api.listFilesRecursive(this.basePath);
        if (!localListResult.success) throw new Error("ローカルファイルの取得に失敗しました。");
        
        const localFiles = [];
        for (const f of localListResult.files) {
            // .git などの除外
            if (f.relativePath.includes('.git') || f.relativePath.includes('.DS_Store')) continue;

            const stats = await window.api.getFileStats(f.fullPath);
            if (stats.success) {
                localFiles.push({
                    path: f.fullPath,
                    relativePath: f.relativePath,
                    mtime: stats.mtime,
                    size: stats.size
                });
            }
        }
        const localMap = new Map(localFiles.map(f => [f.relativePath, f]));

        // 3. 同期プランの作成
        const allPaths = new Set([...remoteMap.keys(), ...localMap.keys()]);
        let uploadCount = 0;
        let downloadCount = 0;

        for (const pathKey of allPaths) {
            const local = localMap.get(pathKey);
            const remote = remoteMap.get(pathKey);
            
            const localFullPath = this.basePath + (navigator.platform.includes('Win') ? '\\' : '/') + pathKey;
            const remotePath = '/' + pathKey; // Dropboxはスラッシュ区切り

            if (local && !remote) {
                // ローカルにしかないのでアップロード
                logCallback(`アップロード中: ${pathKey}`);
                await this.uploadFile(localFullPath, remotePath);
                uploadCount++;
            } else if (!local && remote) {
                // リモートにしかないのでダウンロード
                logCallback(`ダウンロード中: ${pathKey}`);
                await this.downloadFile(remotePath, localFullPath);
                downloadCount++;
            } else if (local && remote) {
                // 両方ある場合、時刻比較 (2秒以上の差があれば同期)
                const timeDiff = local.mtime - remote.mtime;
                if (timeDiff > 2000) {
                    // ローカルが新しい -> Upload
                    logCallback(`更新アップロード: ${pathKey}`);
                    await this.uploadFile(localFullPath, remotePath);
                    uploadCount++;
                } else if (timeDiff < -2000) {
                    // リモートが新しい -> Download
                    logCallback(`更新ダウンロード: ${pathKey}`);
                    await this.downloadFile(remotePath, localFullPath);
                    downloadCount++;
                }
                // ほぼ同じ時刻ならスキップ
            }
        }

        logCallback(`同期完了: アップロード ${uploadCount}件, ダウンロード ${downloadCount}件`);
    }
}

// シングルトンとしてエクスポート
window.dropboxSyncService = new DropboxSyncService();