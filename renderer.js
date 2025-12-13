/**
 * Markdown IDE - Main Renderer Process
 * Integrated layout with full Markdown functionality (CodeMirror 6) and Terminal Support
 * Update: Added Search functionality (Ctrl+F) with VS Code like styling
 * Update: Added drawSelection for persistent selection visibility
 * Update: Dynamic language switching based on file extension
 * Update: Integrated Git Management features with Init support
 * Update: Added Git History Graph and Detail Tooltip
 * Fix: Hide unnecessary Git UI elements when no repository is found
 */

const path = require('path');
const { webFrame } = require('electron');
const { EditorState, Prec, Compartment, Annotation, RangeSetBuilder, StateField } = require("@codemirror/state");
const { EditorView, keymap, highlightActiveLine, lineNumbers, drawSelection, dropCursor, MatchDecorator, ViewPlugin, Decoration, WidgetType } = require("@codemirror/view");
const { defaultKeymap, history, historyKeymap, undo, redo, indentMore, indentLess } = require("@codemirror/commands");
const { syntaxHighlighting, defaultHighlightStyle, indentUnit } = require("@codemirror/language");
const { oneDark } = require("@codemirror/theme-one-dark");
const { closeBrackets } = require("@codemirror/autocomplete");
const { livePreviewPlugin } = require("./livePreviewPlugin.js");
const { tablePlugin } = require("./tablePlugin.js");
const { MergeView } = require("@codemirror/merge");

// 言語パッケージのインポート（Modern）
const { markdown, markdownLanguage } = require("@codemirror/lang-markdown");

// @codemirror/search から必要なクラスをインポート
const {
    search,
    searchKeymap,
    setSearchQuery,
    SearchQuery,
    findNext,
    findPrevious,
    replaceNext,
    replaceAll,
    closeSearchPanel
} = require("@codemirror/search");
const { get } = require('http');

// スペース可視化用のカスタムプラグイン（スタイルはCSSで定義するためクラス付与のみ行う）
const spaceMatcher = new MatchDecorator({
    regexp: / +/g,
    decoration: (match) => Decoration.mark({
        class: "cm-highlightSpace"
    })
});

const customHighlightWhitespace = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = spaceMatcher.createDeco(view);
    }
    update(update) {
        this.decorations = spaceMatcher.updateDeco(update, this.decorations);
    }
}, {
    decorations: v => v.decorations
});

// プログラムによる変更を識別するためのアノテーション
const ExternalChange = Annotation.define();

// ========== DOM要素取得 ==========
const ideContainer = document.getElementById('ide-container');
const leftPane = document.getElementById('left-pane');
const rightPane = document.getElementById('right-pane');
const rightActivityBar = document.querySelector('.right-activity-bar');
const bottomPane = document.getElementById('bottom-pane');
const centerPane = document.getElementById('center-pane');
const btnCalendar = document.getElementById('btn-calendar');

// トップバー操作
const btnToggleLeftPane = document.getElementById('btn-toggle-leftpane');
const topSideSwitchButtons = document.querySelectorAll('.side-switch');

// ウィンドウコントロール
const btnToggleRightActivity = document.getElementById('btn-toggle-right-activity');
const btnMinimize = document.getElementById('btn-minimize');
const btnMaximize = document.getElementById('btn-maximize');
const btnClose = document.getElementById('btn-close');

// 左ペイン
const leftPaneContents = document.querySelectorAll('.left-pane-content');
const btnTerminalRight = document.getElementById('btn-terminal-right');
const btnTogglePosition = document.getElementById('btn-toggle-position');

// 左アクティビティバー
const btnZen = document.getElementById('btn-zen');
const btnSettings = document.getElementById('btn-settings');
const btnPdfPreview = document.getElementById('btn-pdf-preview');

// エディタコンテナ
const editorContainer = document.getElementById('editor');

// ターミナルコンテナ
const terminalContainer = document.getElementById('terminal-container');
const terminalBottomContainer = document.getElementById('terminal-bottom-container');

// エディタタブ
const editorTabsContainer = document.getElementById('editor-tabs');
const closedTabsHistory = [];

// ファイルタイトル入力
const fileTitleBar = document.getElementById('file-title-bar');
const fileTitleInput = document.getElementById('file-title-input');

// ファイル統計情報
const fileStatsElement = document.getElementById('file-stats');
const statusBar = document.getElementById('status-bar');

// ツールバーボタン
const btnBulletList = document.getElementById('btn-bullet-list');
const btnNumberList = document.getElementById('btn-number-list');
const btnCheckList = document.getElementById('btn-check-list');
const colorBtn = document.getElementById('color-btn');
const colorPicker = document.getElementById('color-picker');

// 最近使ったファイルリスト
const btnRecentClear = document.getElementById('btn-recent-clear');
const recentFilesList = document.getElementById('recent-files-list');

// ========== Git関連 DOM要素 ==========
const gitUnstagedList = document.getElementById('git-unstaged');
const gitStagedList = document.getElementById('git-staged');
const gitMessageInput = document.getElementById('git-message');
const btnGitCommit = document.getElementById('git-commit-btn');
const btnGitPush = document.getElementById('git-push-btn');
const btnGitRefresh = document.getElementById('btn-git-refresh');
const btnGitStage = document.getElementById('btn-git-stage');
const btnGitUnstage = document.getElementById('btn-git-unstage');
// ステータスバーのブランチ表示用
const statusBarBranch = document.getElementById('status-bar-branch');

// Git履歴用要素
const gitHistoryList = document.getElementById('git-history-list');
const gitCurrentBranchBadge = document.getElementById('git-current-branch');
const gitCommitTooltip = document.getElementById('git-commit-tooltip');

// ========== Cloud Sync Logic (Frontend) ==========
const btnCloudSync = document.getElementById('btn-cloud-sync');
const syncServiceSelect = document.getElementById('sync-service');
const syncSettingsDropbox = document.getElementById('sync-settings-dropbox');
const syncSettingsGDrive = document.getElementById('sync-settings-gdrive');
const btnAuthDropbox = document.getElementById('btn-auth-dropbox');
const btnAuthGDrive = document.getElementById('btn-auth-gdrive');
const syncStatusText = document.getElementById('sync-status-text');

// ========== 状態管理 ==========
let globalEditorView = null; // CodeMirrorインスタンス
let isPositionRight = true;
let isTerminalVisible = false;
let isRightActivityBarVisible = true;
let isMaximized = false;
let savedRightActivityBarState = true;
let activeContextMenu = null;
let globalDiffView = null; // Diffビューのインスタンス保持用
let isDiffMode = false;    // 現在Diffモードかどうか

// 言語状態を管理するフィールド
const currentLanguageField = StateField.define({
    create() { return 'markdown'; },
    update(value, tr) { return value; }
});

// ファイルパスからPrism言語IDを取得するヘルパー
function getPrismLanguageFromPath(filePath) {
    if (!filePath) return 'markdown';
    const ext = path.extname(filePath).toLowerCase().replace('.', '');

    const langMap = {
        'js': 'javascript', 'ts': 'typescript', 'py': 'python',
        'sh': 'bash', 'zsh': 'bash', 'shell': 'bash',
        'rb': 'ruby', 'cs': 'csharp', 'kt': 'kotlin',
        'rs': 'rust', 'go': 'go', 'md': 'markdown', 'markdown': 'markdown',
        'html': 'markup', 'xml': 'markup', 'svg': 'markup',
        'c': 'c', 'cpp': 'cpp', 'h': 'cpp',
        'css': 'css', 'json': 'json', 'yaml': 'yaml', 'yml': 'yaml',
        'java': 'java', 'php': 'php', 'sql': 'sql', 'pl': 'perl',
        'lua': 'lua', 'r': 'r', 'dart': 'dart', 'swift': 'swift',
        'scala': 'scala', 'bf': 'brainfuck', 'ws': 'whitespace'
    };

    return langMap[ext] || 'markdown';
}

// 設定管理
let appSettings = {
    fontSize: '16px',
    fontFamily: '"Segoe UI", "Meiryo", sans-serif',
    theme: 'light',
    autoSave: true,
    autoSaveOnClose: false,
    wordWrap: true,
    windowTransparency: 0,
    tabSize: 4,
    insertSpaces: true,
    showLineNumbers: true,
    autoCloseBrackets: true,
    highlightActiveLine: true,
    defaultImageLocation: '.',
    excludePatterns: 'node_modules, .git, .DS_Store, dist, build, .obsidian',
    showStatusBar: true,
    showToolbar: true,
    showFileTitleBar: true,
    showWhitespace: false,
    enabledSnippets: [],
    // PDF設定のデフォルト値
    pdfOptions: {
        pageSize: 'A4',
        marginsType: 0,
        printBackground: true,
        displayHeaderFooter: false,
        landscape: false,
        enableToc: false,
        includeTitle: false,
        pageRanges: ''
    }
};

// ========== Command Registry ==========
const COMMANDS_REGISTRY = [
    // --- Global Commands ---
    { id: 'file:save', name: 'ファイルを保存', defaultKey: 'Mod-s', context: 'global', run: () => saveCurrentFile() },
    { id: 'file:save-as', name: '名前を付けて保存', defaultKey: 'Mod-Shift-s', context: 'global', run: () => saveCurrentFile(true) },
    { id: 'file:new-tab', name: '新規タブ', defaultKey: 'Mod-t', context: 'global', run: () => createNewTab() },
    {
        id: 'file:close-tab', name: 'タブを閉じる', defaultKey: 'Mod-w', context: 'global', run: () => {
            const tab = document.querySelector('.editor-tabs .tab.active'); if (tab) closeTab(tab, tab.id === 'tab-settings');
        }
    },
    { id: 'file:reopen-tab', name: '閉じたタブを開く', defaultKey: 'Mod-Shift-t', context: 'global', run: () => reopenLastClosedTab() },

    // サイドバー切替 (太字 Ctrl+B との競合を避けて Shift を追加)
    { id: 'view:toggle-sidebar', name: 'サイドバーの表示/非表示', defaultKey: 'Mod-Shift-b', context: 'global', run: () => document.getElementById('btn-toggle-leftpane')?.click() },
    // ターミナル切替 (Ctrl+@)
    { id: 'view:toggle-terminal', name: 'ターミナルの表示/非表示', defaultKey: 'Mod-@', context: 'global', run: () => { isTerminalVisible = !isTerminalVisible; updateTerminalVisibility(); } },
    { id: 'view:toggle-right-pane', name: '右パネルの表示/非表示', defaultKey: 'Mod-l', context: 'global', run: () => { isRightActivityBarVisible = !isRightActivityBarVisible; updateTerminalVisibility(); } },

    // 1. アプリ全体(ウィンドウ)の拡大縮小 (新規追加)
    // 拡大: Ctrl + Shift + + (US配列等では = キー)
    { id: 'view:window-zoom-in', name: 'ウィンドウ拡大', defaultKey: 'Mod-Shift-+', context: 'global', run: () => adjustWindowZoom(0.5) },
    // 縮小: Ctrl + Shift + -
    { id: 'view:window-zoom-out', name: 'ウィンドウ縮小', defaultKey: 'Mod-Shift-=', context: 'global', run: () => adjustWindowZoom(-0.5) },
    // ウィンドウリセット: Ctrl + 0 (標準的なリセットキー)
    { id: 'view:window-zoom-reset', name: 'ウィンドウリセット', defaultKey: 'Mod-Alt-0', context: 'global', run: () => webFrame.setZoomLevel(0) },

    // 2. 文字サイズ(エディタ)の拡大縮小
    // 既存のキー割り当て(Ctrl+; / Ctrl+-)を維持
    { id: 'view:font-zoom-in', name: '文字サイズ拡大', defaultKey: 'Mod-;', context: 'global', run: () => adjustFontSize(2) },
    { id: 'view:font-zoom-out', name: '文字サイズ縮小', defaultKey: 'Mod--', context: 'global', run: () => adjustFontSize(-2) },
    // フォントリセット: Ctrl + Alt + 0 (ウィンドウリセットと区別するため変更)
    { id: 'view:font-zoom-reset', name: '文字サイズリセット', defaultKey: 'Mod-0', context: 'global', run: () => adjustFontSize(0) },

    // --- Editor Commands (CodeMirror) ---
    // 装飾
    { id: 'editor:bold', name: '太字', defaultKey: 'Mod-b', context: 'editor', run: (view) => toggleMark(view, "**") },
    { id: 'editor:italic', name: '斜体', defaultKey: 'Mod-i', context: 'editor', run: (view) => toggleMark(view, "*") },
    // 取り消し線 (SaveAsとの競合を避けて Mod-Shift-x に変更)
    { id: 'editor:strikethrough', name: '取り消し線', defaultKey: 'Mod-Shift-x', context: 'editor', run: (view) => toggleMark(view, "~~") },
    { id: 'editor:highlight', name: 'ハイライト', defaultKey: 'Mod-Shift-h', context: 'editor', run: (view) => toggleMark(view, "==") },
    { id: 'editor:inline-code', name: 'インラインコード', defaultKey: 'Mod-e', context: 'editor', run: (view) => toggleMark(view, "`") },

    // 見出し
    { id: 'editor:h1', name: '見出し 1', defaultKey: 'Mod-1', context: 'editor', run: (view) => toggleLinePrefix(view, "#") },
    { id: 'editor:h2', name: '見出し 2', defaultKey: 'Mod-2', context: 'editor', run: (view) => toggleLinePrefix(view, "##") },
    { id: 'editor:h3', name: '見出し 3', defaultKey: 'Mod-3', context: 'editor', run: (view) => toggleLinePrefix(view, "###") },
    { id: 'editor:h4', name: '見出し 4', defaultKey: 'Mod-4', context: 'editor', run: (view) => toggleLinePrefix(view, "####") },
    { id: 'editor:h5', name: '見出し 5', defaultKey: 'Mod-5', context: 'editor', run: (view) => toggleLinePrefix(view, "#####") },
    { id: 'editor:h6', name: '見出し 6', defaultKey: 'Mod-6', context: 'editor', run: (view) => toggleLinePrefix(view, "######") },

    // 挿入・ブロック
    { id: 'editor:link', name: 'リンク挿入', defaultKey: 'Mod-k', context: 'editor', run: (view) => insertLink(view) },
    { id: 'editor:code-block', name: 'コードブロック', defaultKey: 'Mod-Shift-c', context: 'editor', run: (view) => insertCodeBlock(view) },
    { id: 'editor:quote', name: '引用', defaultKey: 'Mod-Shift-.', context: 'editor', run: (view) => toggleLinePrefix(view, ">") },

    // リスト
    { id: 'editor:list-bullet', name: '箇条書きリスト', defaultKey: 'Mod-Shift-8', context: 'editor', run: (view) => toggleList(view, 'ul') },
    { id: 'editor:list-number', name: '番号付きリスト', defaultKey: 'Mod-Shift-9', context: 'editor', run: (view) => toggleList(view, 'ol') },
    { id: 'editor:list-task', name: 'タスクリスト', defaultKey: 'Mod-Shift-l', context: 'editor', run: (view) => toggleList(view, 'task') },

    // 検索・置換
    { id: 'editor:search', name: '検索', defaultKey: 'Mod-f', context: 'editor', run: () => searchWidgetControl?.open() },
    { id: 'editor:replace', name: '置換', defaultKey: 'Mod-h', context: 'editor', run: () => searchWidgetControl?.toggleReplace() },

    // --- 挿入機能 (既存関数のショートカット化) ---
    { id: 'editor:insert-image', name: '画像挿入', defaultKey: 'Mod-Shift-m', context: 'editor', run: (view) => insertImage(view) },
    { id: 'editor:insert-table', name: 'テーブル挿入', defaultKey: 'Mod-Alt-t', context: 'editor', run: (view) => insertTable(view) }, // Mod-t (新規タブ) と被らないようにShift
    { id: 'editor:insert-hr', name: '区切り線', defaultKey: 'Mod-Alt-h', context: 'editor', run: (view) => insertHorizontalRule(view) },
    { id: 'editor:insert-page-break', name: '改ページ', defaultKey: 'Mod-Enter', context: 'editor', run: (view) => insertPageBreak(view) },

    // タブ切り替え (Ctrl+Tab / Ctrl+Shift+Tab)
    { id: 'view:next-tab', name: '次のタブ', defaultKey: 'Mod-tab', context: 'global', run: () => switchTab(1) },
    { id: 'view:prev-tab', name: '前のタブ', defaultKey: 'Mod-Shift-tab', context: 'global', run: () => switchTab(-1) },
];

/**
 * キー文字列 (Mod-Shift-s) を表示用 (Ctrl+Shift+S) に変換
 */
function formatKeyDisplay(keyStr) {
    if (!keyStr) return 'Blank';
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    return keyStr
        .replace('Mod', isMac ? 'Cmd' : 'Ctrl')
        .replace(/-/g, ' + ')
        .toUpperCase();
}

// CodeMirror Compartments for dynamic reconfiguration
const themeCompartment = new Compartment();
const editorStyleCompartment = new Compartment();
const languageCompartment = new Compartment(); // 言語設定用のCompartment
const lineWrappingCompartment = new Compartment();
const indentUnitCompartment = new Compartment();
const tabSizeCompartment = new Compartment();
const lineNumbersCompartment = new Compartment();
const activeLineCompartment = new Compartment();
const autoCloseBracketsCompartment = new Compartment();
const whitespaceCompartment = new Compartment();

// ========== PDF Preview State ==========
let isPdfPreviewVisible = false;
let pdfDocument = null;

// ========== Terminal Integration State ==========
const terminals = new Map();
let activeTerminalId = null;
let terminalConfig = null;
let availableShells = [];

// Terminal DOM Elements
const terminalTabsList = document.getElementById('terminal-tabs-list');
const newTerminalBtn = document.getElementById('new-terminal-btn');
const dropdownToggle = document.getElementById('dropdown-toggle');
const shellDropdown = document.getElementById('shell-dropdown');

// File System State
let currentDirectoryPath = null;
let openedFiles = new Map();
let fileModificationState = new Map();
let currentSortOrder = 'asc';
let currentFilePath = null;
let recentFiles = []; // 最近開いたファイルのリスト

// PDFのズームレベルを管理するグローバル変数 (初期値: 1.5倍)
let pdfCurrentScale = 1.5;

/**
 * 単一のPDFページを指定されたスケールでCanvasにレンダリングする
 */
async function renderPdfPageToCanvas(page, canvas, scale) {
    // デバイスのピクセル比（Retinaディスプレイなどで重要）を取得
    const pixelRatio = window.devicePixelRatio || 1;

    // スケールをデバイスピクセル比で補正
    const actualScale = scale; // PDF.jsが内部でdevicePixelRatioを考慮するため、ここでは補正しない

    const viewport = page.getViewport({ scale: actualScale });

    const context = canvas.getContext('2d');

    // Canvasの解像度（高解像度画像として描画）
    canvas.height = viewport.height * pixelRatio; // 縦方向の解像度
    canvas.width = viewport.width * pixelRatio;   // 横方向の解像度

    // CSSサイズ（見た目のサイズ）をViewportのサイズに設定
    // これがCanvasを視覚的に拡大・縮小する部分です
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    // 描画コンテキストをピクセル比に応じてスケールさせる
    context.scale(pixelRatio, pixelRatio);

    // 描画
    await page.render({
        canvasContext: context,
        viewport: viewport
    }).promise;
}

/**
 * PDF全体の描画とコントロールUIの生成を行う
 * (ズーム変更時や初期描画時に呼び出される)
 */
async function renderAllPdfPages(pdf, container, filePath) {
    // ズーム変更時にコンテナ全体を一旦クリア
    container.innerHTML = '';

    const numPages = pdf.numPages;

    // 1. コントロールパネルのコンテナを作成 (ブロック要素として配置)
    const controlsContainer = document.createElement('div');
    controlsContainer.className = 'pdf-controls-top';
    // position:sticky を削除し、flex-shrink: 0 で固定領域化
    controlsContainer.style.cssText = 'display:flex; justify-content:center; align-items:center; padding:10px 0; background-color:var(--sidebar-bg); width:100%; border-bottom: 1px solid var(--sidebar-border); color: var(--text-color); flex-shrink: 0;';
    container.appendChild(controlsContainer);

    // 2. ページ数とスケール表示エリア
    const pageInfo = document.createElement('span');
    pageInfo.id = 'pdf-page-indicator';
    pageInfo.textContent = `1 / ${numPages} | Scale: ${Math.round(pdfCurrentScale * 100)}%`;
    pageInfo.style.margin = '0 20px';
    pageInfo.style.minWidth = '150px';
    pageInfo.style.textAlign = 'center';
    pageInfo.style.fontSize = '13px';
    controlsContainer.appendChild(pageInfo);

    // 3. ズームイン/アウトボタン
    const createZoomBtn = (text, onClick) => {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.onclick = onClick;
        btn.style.cssText = 'background:transparent; border:1px solid var(--sidebar-border); color:var(--text-color); border-radius:3px; padding:2px 8px; cursor:pointer; margin:0 2px;';
        return btn;
    };

    const zoomOutBtn = createZoomBtn('🔍 -', () => {
        pdfCurrentScale = Math.max(0.5, pdfCurrentScale - 0.25);
        renderAllPdfPages(pdf, container, filePath);
    });
    controlsContainer.appendChild(zoomOutBtn);

    const zoomInBtn = createZoomBtn('🔍 +', () => {
        pdfCurrentScale = Math.min(3.0, pdfCurrentScale + 0.25);
        renderAllPdfPages(pdf, container, filePath);
    });
    controlsContainer.appendChild(zoomInBtn);


    // 4. 描画エリア (ここだけスクロールさせる)
    const pageRenderArea = document.createElement('div');
    pageRenderArea.className = 'pdf-page-render-area';
    // flex: 1 と overflow-y: auto を追加してスクロール領域にする
    pageRenderArea.style.cssText = 'flex: 1; overflow-y: auto; width: 100%; display: flex; flex-direction: column; align-items: center; padding: 20px 0;';
    container.appendChild(pageRenderArea);

    // 5. Intersection Observer の設定
    let activePageNum = 1;
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const pageNum = parseInt(entry.target.dataset.pageNum);
                activePageNum = pageNum;

                const indicator = document.getElementById('pdf-page-indicator');
                if (indicator) {
                    indicator.textContent = `${activePageNum} / ${numPages} | Scale: ${Math.round(pdfCurrentScale * 100)}%`;
                }
            }
        });
    }, {
        root: pageRenderArea, // 監視対象のスクロールコンテナを pageRenderArea に変更
        rootMargin: '-40% 0px -40% 0px',
        threshold: 0
    });

    // 6. 各ページをレンダリング
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const pageContainer = document.createElement('div');
        pageContainer.className = 'pdf-page-container';
        pageContainer.dataset.pageNum = pageNum;

        pageContainer.style.cssText = 'margin-bottom:20px; position: relative;';
        pageRenderArea.appendChild(pageContainer);

        const canvas = document.createElement('canvas');
        canvas.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
        pageContainer.appendChild(canvas);

        const page = await pdf.getPage(pageNum);

        await renderPdfPageToCanvas(page, canvas, pdfCurrentScale);

        observer.observe(pageContainer);
    }
}

// ========== 左ペイン幅の動的制御用変数更新関数 ==========
function updateLeftPaneWidthVariable() {
    const isHidden = leftPane.classList.contains('hidden');
    // 固定値 '240px' ではなく、現在の設定値(--leftpane-width)を取得して使用
    // CSS変数が未設定の場合はデフォルト240pxを使用
    const currentSettingsWidth = getComputedStyle(document.documentElement).getPropertyValue('--leftpane-width').trim() || '240px';
    const width = isHidden ? '0px' : currentSettingsWidth;
    document.documentElement.style.setProperty('--current-left-pane-width', width);
}

// ========== ビュー切り替えロジック (重要: タブと画面の同期) ==========

/**
 * メインビュー（エディタ or 設定画面）を切り替え、タブのアクティブ状態を更新する
 * @param {string} targetId - 表示したいコンテンツのID ('content-readme', 'content-settings' など)
 */
function switchMainView(targetId) {
    // 1. すべてのメインコンテンツを非表示にする
    const contentIds = ['content-readme', 'content-settings'];
    contentIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('content-hidden');
    });

    // 2. 指定されたコンテンツを表示する
    const targetEl = document.getElementById(targetId);
    if (targetEl) {
        targetEl.classList.remove('content-hidden');
    }

    // 3. タブのアクティブ状態を更新する
    document.querySelectorAll('.editor-tabs .tab').forEach(tab => {
        tab.classList.remove('active');

        // 設定タブの場合
        if (targetId === 'content-settings' && tab.id === 'tab-settings') {
            tab.classList.add('active');
        }
        // エディタ（ファイル）の場合
        else if (targetId === 'content-readme' && tab.dataset.filepath === currentFilePath) {
            tab.classList.add('active');
        }
    });

    // 4. ツールバーとファイルタイトルバーの表示制御
    const toolbar = document.querySelector('.toolbar');

    if (targetId === 'content-readme') {
        // エディタ画面: 設定がONの場合のみツールバーを表示
        if (toolbar) {
            if (appSettings.showToolbar) {
                toolbar.classList.remove('hidden');
            } else {
                toolbar.classList.add('hidden');
            }
        }

        // タイトルバーはREADME以外 かつ 設定がONの場合のみ表示
        if (currentFilePath !== 'README.md' && appSettings.showFileTitleBar) {
            if (fileTitleBar) fileTitleBar.classList.remove('hidden');
        } else {
            if (fileTitleBar) fileTitleBar.classList.add('hidden');
        }
    } else {
        // 設定画面など: ツールバーとタイトルバーを両方非表示
        if (toolbar) toolbar.classList.add('hidden');
        if (fileTitleBar) fileTitleBar.classList.add('hidden');
    }
}

// ========== 設定関連の関数 ==========

// 透明度を適用する関数
function applyWindowOpacity(transparency) {
    if (window.electronAPI && window.electronAPI.setWindowOpacity) {
        // 透明度(0-90)を不透明度(1.0-0.1)に変換して送信
        // 0% -> 1.0 (不透明), 90% -> 0.1 (透明)
        const opacity = 1.0 - (transparency / 100);
        window.electronAPI.setWindowOpacity(opacity);
    }
}

async function loadSettings() {
    try {
        const settings = await window.electronAPI.loadAppSettings();
        if (settings) {
            appSettings = { ...appSettings, ...settings };
        }
        applySettingsToUI();
        updateEditorSettings();

        // 起動時に透明度を適用
        if (appSettings.windowTransparency !== undefined) {
            applyWindowOpacity(appSettings.windowTransparency);
        }
    } catch (e) {
        console.error("Failed to load settings", e);
    }
}

async function saveSettings() {
    try {
        await window.electronAPI.saveAppSettings(appSettings);
    } catch (e) {
        console.error("Failed to save settings", e);
    }
}

function setupSettingsNavigation() {
    const navItems = document.querySelectorAll('.settings-nav-item');
    const sections = document.querySelectorAll('.settings-section');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            // すべてのアクティブクラスを削除
            navItems.forEach(nav => nav.classList.remove('active'));
            sections.forEach(sec => sec.classList.remove('active'));

            // クリックされた項目をアクティブ化
            item.classList.add('active');

            const targetSectionId = `settings-section-${item.dataset.section}`;
            const targetSection = document.getElementById(targetSectionId);
            if (targetSection) {
                targetSection.classList.add('active');
            }
        });
    });
}

function applySettingsToUI() {
    // DOM要素への反映
    const fontSizeInput = document.getElementById('font-size');
    const fontFamilyInput = document.getElementById('font-family');
    const themeInput = document.getElementById('theme');
    const showStatusBarInput = document.getElementById('show-status-bar');
    const autoSaveInput = document.getElementById('auto-save');
    const autoSaveOnCloseInput = document.getElementById('auto-save-on-close');
    const wordWrapInput = document.getElementById('word-wrap');
    const tabSizeInput = document.getElementById('tab-size');
    const insertSpacesInput = document.getElementById('insert-spaces');
    const showLineNumbersInput = document.getElementById('show-line-numbers');
    const autoCloseBracketsInput = document.getElementById('auto-close-brackets');
    const highlightActiveLineInput = document.getElementById('highlight-active-line');
    const defaultImageLocationInput = document.getElementById('default-image-location');
    const excludePatternsInput = document.getElementById('exclude-patterns');
    const showToolbarInput = document.getElementById('show-toolbar');
    const showFileTitleBarInput = document.getElementById('show-file-title-bar');
    const showWhitespaceInput = document.getElementById('show-whitespace');
    const lineHeightInput = document.getElementById('line-height');

    if (wordWrapInput) wordWrapInput.checked = appSettings.wordWrap;
    if (fontSizeInput) fontSizeInput.value = appSettings.fontSize;
    if (fontFamilyInput) fontFamilyInput.value = appSettings.fontFamily;
    if (themeInput) themeInput.value = appSettings.theme;
    if (showStatusBarInput) showStatusBarInput.checked = appSettings.showStatusBar;
    if (autoSaveInput) autoSaveInput.checked = appSettings.autoSave;
    if (autoSaveOnCloseInput) autoSaveOnCloseInput.checked = appSettings.autoSaveOnClose;
    if (tabSizeInput) tabSizeInput.value = appSettings.tabSize;
    if (insertSpacesInput) insertSpacesInput.checked = appSettings.insertSpaces;
    if (showLineNumbersInput) showLineNumbersInput.checked = appSettings.showLineNumbers;
    if (autoCloseBracketsInput) autoCloseBracketsInput.checked = appSettings.autoCloseBrackets;
    if (highlightActiveLineInput) highlightActiveLineInput.checked = appSettings.highlightActiveLine;
    if (defaultImageLocationInput) defaultImageLocationInput.value = appSettings.defaultImageLocation || '.';
    if (excludePatternsInput) excludePatternsInput.value = appSettings.excludePatterns || '';
    if (showToolbarInput) showToolbarInput.checked = appSettings.showToolbar;
    if (showFileTitleBarInput) showFileTitleBarInput.checked = appSettings.showFileTitleBar;
    if (showWhitespaceInput) showWhitespaceInput.checked = appSettings.showWhitespace;

    // 行間設定の反映とCSS変数の更新
    if (lineHeightInput) {
        let val = appSettings.lineHeight || "1.4";
        // もし数値の 1 や 2 だった場合、"1.0", "2.0" に変換してHTMLのoptionと合わせる
        if (val === 1) val = "1.0";
        if (val === 2) val = "2.0";

        lineHeightInput.value = val;
    }
    document.documentElement.style.setProperty('--line-height', (appSettings.lineHeight || 1.4) + 'em');

    // ツールバーの表示/非表示制御 (設定画面では表示しないように条件を追加)
    const toolbar = document.querySelector('.toolbar');
    const readmeContent = document.getElementById('content-readme');
    const fileTitleBarEl = document.getElementById('file-title-bar');

    if (toolbar && readmeContent) {
        // 現在エディタ画面(content-readme)が表示されているかチェック
        const isEditorViewActive = !readmeContent.classList.contains('content-hidden');
        // 現在テキストモード(エディタ)かチェック(メディア表示でないか)
        const isTextMode = document.getElementById('editor').style.display !== 'none';

        // 「設定がON」かつ「エディタ画面が表示中」かつ「テキストモード」の場合のみ表示
        if (appSettings.showToolbar && isEditorViewActive && isTextMode) {
            toolbar.classList.remove('hidden');
        } else {
            toolbar.classList.add('hidden');
        }

        // ファイルタイトルバーの即時反映
        if (fileTitleBarEl) {
            // 設定ON かつ エディタ表示中 かつ README以外なら表示
            if (appSettings.showFileTitleBar && isEditorViewActive && currentFilePath !== 'README.md') {
                fileTitleBarEl.classList.remove('hidden');
            } else {
                fileTitleBarEl.classList.add('hidden');
            }
        }
    }

    // 透明度スライダーへの反映
    const opacityInput = document.getElementById('window-opacity');
    const opacityValue = document.getElementById('window-opacity-value');
    if (opacityInput && opacityValue) {
        // 設定値があれば使用、なければ0
        const val = appSettings.windowTransparency !== undefined ? appSettings.windowTransparency : 0;
        opacityInput.value = val;
        opacityValue.textContent = `${val}%`;
    }

    // ステータスバーの表示制御
    if (statusBar) {
        statusBar.classList.toggle('hidden', !appSettings.showStatusBar);
        // ステータスバーを非表示にするときは、下ペイン/リサイザーの bottom を 0 にする必要がある
        const bottomOffset = appSettings.showStatusBar ? '24px' : '0px';
        document.documentElement.style.setProperty('--status-bar-height', bottomOffset);

        // bottom-paneの位置を調整
        if (bottomPane) {
            bottomPane.style.bottom = bottomOffset;

            // 下ペインが隠れている状態でも、centerPane のマージンを適切に設定する
            if (bottomPane.classList.contains('hidden') || !isTerminalVisible) {
                centerPane.style.marginBottom = '0px';
            }
        }

        // リサイザー位置も調整（bottom-paneの高さが0になるため、リサイザーも隠す）
        const resizerBottom = document.getElementById('resizer-bottom');
        if (resizerBottom) {
            resizerBottom.style.bottom = `calc(${parseInt(bottomPane?.style.height || '200px')}px + ${bottomOffset})`;
            // ステータスバー非表示、またはターミナルが非表示の場合にリサイザーを隠す
            const hideResizer = !appSettings.showStatusBar || bottomPane.classList.contains('hidden');
            resizerBottom.classList.toggle('hidden', hideResizer);
        }
    }

    // ステータスバーのフォントサイズ更新
    const statusFontSize = document.getElementById('status-font-size');
    if (statusFontSize) {
        statusFontSize.textContent = `Size: ${appSettings.fontSize}`;
    }

    // テーマの適用
    if (appSettings.theme === 'dark') {
        document.body.setAttribute('data-theme', 'dark');
    } else {
        document.body.removeAttribute('data-theme');
    }

    // PDF設定の反映
    if (appSettings.pdfOptions) {
        const pdfPageSize = document.getElementById('pdf-page-size');
        const pdfLandscape = document.getElementById('pdf-landscape');
        const pdfMargins = document.getElementById('pdf-margins');
        const pdfBackground = document.getElementById('pdf-print-background');
        const pdfHeaderFooter = document.getElementById('pdf-header-footer');
        const pdfToc = document.getElementById('pdf-toc');
        const pdfIncludeTitle = document.getElementById('pdf-include-title');
        const pdfPageRanges = document.getElementById('pdf-page-ranges');

        if (pdfPageSize) pdfPageSize.value = appSettings.pdfOptions.pageSize || 'A4';
        if (pdfLandscape) pdfLandscape.checked = appSettings.pdfOptions.landscape || false;
        if (pdfMargins) pdfMargins.value = appSettings.pdfOptions.marginsType !== undefined ? appSettings.pdfOptions.marginsType : 0;
        if (pdfBackground) pdfBackground.checked = appSettings.pdfOptions.printBackground !== undefined ? appSettings.pdfOptions.printBackground : true;
        if (pdfHeaderFooter) pdfHeaderFooter.checked = appSettings.pdfOptions.displayHeaderFooter || false;
        if (pdfToc) pdfToc.checked = appSettings.pdfOptions.enableToc || false;
        if (pdfIncludeTitle) pdfIncludeTitle.checked = appSettings.pdfOptions.includeTitle || false;
        if (pdfPageRanges) pdfPageRanges.value = appSettings.pdfOptions.pageRanges || '';
    }

    // CSS変数の更新 (エディタ以外のフォント等)
    document.documentElement.style.setProperty('--editor-font-size', appSettings.fontSize);
    document.documentElement.style.setProperty('--editor-font-family', appSettings.fontFamily);
}

function updateEditorSettings() {
    if (!globalEditorView) return;

    // CodeMirrorのテーマとスタイルを更新
    globalEditorView.dispatch({
        effects: [
            themeCompartment.reconfigure(appSettings.theme === 'dark' ? oneDark : []),
            editorStyleCompartment.reconfigure(EditorView.theme({
                ".cm-content": {
                    fontSize: appSettings.fontSize,
                    fontFamily: appSettings.fontFamily
                },
                ".cm-gutters": {
                    fontSize: appSettings.fontSize,
                    fontFamily: appSettings.fontFamily
                }
            }))
        ]
    });
}

// インデント設定をエディタに適用する関数
function updateIndentSettings() {
    if (!globalEditorView) return;

    const size = parseInt(appSettings.tabSize, 10);
    const useSpaces = appSettings.insertSpaces;

    // スペース挿入ならスペースN個、そうでなければタブ文字
    const indentString = useSpaces ? " ".repeat(size) : "\t";

    globalEditorView.dispatch({
        effects: [
            indentUnitCompartment.reconfigure(indentUnit.of(indentString)),
            tabSizeCompartment.reconfigure(EditorState.tabSize.of(size))
        ]
    });
}

// 設定画面のイベントリスナー
function setupSettingsListeners() {
    document.getElementById('font-size')?.addEventListener('change', (e) => {
        appSettings.fontSize = e.target.value;
        saveSettings();
        applySettingsToUI();
        updateEditorSettings();
    });

    document.getElementById('font-family')?.addEventListener('change', (e) => {
        appSettings.fontFamily = e.target.value;
        saveSettings();
        applySettingsToUI();
        updateEditorSettings();
    });

    document.getElementById('theme')?.addEventListener('change', (e) => {
        appSettings.theme = e.target.value;
        saveSettings();
        applySettingsToUI();
        updateEditorSettings();
    });

    document.getElementById('show-status-bar')?.addEventListener('change', (e) => { // + 追加
        appSettings.showStatusBar = e.target.checked;
        saveSettings();
        applySettingsToUI();
    });

    // ツールバー表示設定のリスナー
    document.getElementById('show-toolbar')?.addEventListener('change', (e) => {
        appSettings.showToolbar = e.target.checked;
        saveSettings();
        applySettingsToUI();
    });

    // ファイル名バー表示設定のリスナー
    document.getElementById('show-file-title-bar')?.addEventListener('change', (e) => {
        appSettings.showFileTitleBar = e.target.checked;
        saveSettings();
        applySettingsToUI();
    });

    // スペース可視化設定のリスナー
    document.getElementById('show-whitespace')?.addEventListener('change', (e) => {
        appSettings.showWhitespace = e.target.checked;
        saveSettings();
        // エディタに即時反映
        if (globalEditorView) {
            globalEditorView.dispatch({
                effects: whitespaceCompartment.reconfigure(
                    appSettings.showWhitespace ? customHighlightWhitespace : []
                )
            });
        }
    });

    // 透明度スライダーのリスナー
    const opacityInput = document.getElementById('window-opacity');
    if (opacityInput) {
        opacityInput.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);

            // 数値表示の更新
            const opacityValue = document.getElementById('window-opacity-value');
            if (opacityValue) opacityValue.textContent = `${val}%`;

            // 設定の更新と適用
            appSettings.windowTransparency = val;
            applyWindowOpacity(val);
        });

        // 変更確定時（マウスを離した時）に保存
        opacityInput.addEventListener('change', () => {
            saveSettings();
        });
    }

    document.getElementById('auto-save')?.addEventListener('change', (e) => {
        appSettings.autoSave = e.target.checked;
        saveSettings();
    });

    document.getElementById('auto-save-on-close')?.addEventListener('change', (e) => { // 新規
        appSettings.autoSaveOnClose = e.target.checked;
        saveSettings();
    });

    // 除外設定の保存とファイルツリー更新
    document.getElementById('exclude-patterns')?.addEventListener('change', (e) => {
        appSettings.excludePatterns = e.target.value;
        saveSettings();
        // ファイルツリーを再読み込みして設定を即時反映
        if (typeof initializeFileTreeWithState === 'function') {
            initializeFileTreeWithState();
        } else {
            initializeFileTree();
        }
    });

    // 画像保存場所設定
    document.getElementById('default-image-location')?.addEventListener('change', (e) => {
        appSettings.defaultImageLocation = e.target.value;
        saveSettings();
    });

    document.getElementById('word-wrap')?.addEventListener('change', (e) => {
        appSettings.wordWrap = e.target.checked;
        saveSettings();

        // エディタに即時反映
        if (globalEditorView) {
            globalEditorView.dispatch({
                effects: lineWrappingCompartment.reconfigure(
                    appSettings.wordWrap ? EditorView.lineWrapping : []
                )
            });
        }
    });

    // タブ幅変更
    document.getElementById('tab-size')?.addEventListener('change', (e) => {
        appSettings.tabSize = parseInt(e.target.value, 10);
        saveSettings();
        updateIndentSettings();
    });

    // 行間変更
    document.getElementById('line-height')?.addEventListener('change', (e) => {
        appSettings.lineHeight = e.target.value;
        saveSettings();
        applySettingsToUI(); // ここでCSS変数を更新
    });

    // スペース挿入切り替え
    document.getElementById('insert-spaces')?.addEventListener('change', (e) => {
        appSettings.insertSpaces = e.target.checked;
        saveSettings();
        updateIndentSettings();
    });

    // 行番号表示切り替え
    document.getElementById('show-line-numbers')?.addEventListener('change', (e) => {
        appSettings.showLineNumbers = e.target.checked;
        saveSettings();

        // エディタに即時反映
        if (globalEditorView) {
            globalEditorView.dispatch({
                effects: lineNumbersCompartment.reconfigure(
                    appSettings.showLineNumbers ? lineNumbers() : []
                )
            });
        }
    });

    // 括弧自動閉鎖切り替え
    document.getElementById('auto-close-brackets')?.addEventListener('change', (e) => {
        appSettings.autoCloseBrackets = e.target.checked;
        saveSettings();

        if (globalEditorView) {
            globalEditorView.dispatch({
                effects: autoCloseBracketsCompartment.reconfigure(
                    appSettings.autoCloseBrackets ? closeBrackets() : []
                )
            });
        }
    });

    // 現在行ハイライト切り替え
    document.getElementById('highlight-active-line')?.addEventListener('change', (e) => {
        appSettings.highlightActiveLine = e.target.checked;
        saveSettings();

        if (globalEditorView) {
            globalEditorView.dispatch({
                effects: activeLineCompartment.reconfigure(
                    appSettings.highlightActiveLine ? highlightActiveLine() : []
                )
            });
        }
    });

    // PDF設定のリスナー
    const updatePdfSettings = () => {
        appSettings.pdfOptions = {
            pageSize: document.getElementById('pdf-page-size').value,
            marginsType: parseInt(document.getElementById('pdf-margins').value),
            printBackground: document.getElementById('pdf-print-background').checked,
            displayHeaderFooter: document.getElementById('pdf-header-footer').checked,
            landscape: document.getElementById('pdf-landscape').checked,
            enableToc: document.getElementById('pdf-toc').checked,
            includeTitle: document.getElementById('pdf-include-title').checked,
            pageRanges: document.getElementById('pdf-page-ranges').value.trim()
        };
        saveSettings();

        // プレビューが表示中なら更新する
        if (isPdfPreviewVisible) {
            generatePdfPreview();
        }
    };

    document.getElementById('pdf-page-size')?.addEventListener('change', updatePdfSettings);
    document.getElementById('pdf-landscape')?.addEventListener('change', updatePdfSettings);
    document.getElementById('pdf-margins')?.addEventListener('change', updatePdfSettings);
    document.getElementById('pdf-print-background')?.addEventListener('change', updatePdfSettings);
    document.getElementById('pdf-header-footer')?.addEventListener('change', updatePdfSettings);
    document.getElementById('pdf-toc')?.addEventListener('change', updatePdfSettings);
    document.getElementById('pdf-include-title')?.addEventListener('change', updatePdfSettings);
    document.getElementById('pdf-page-ranges')?.addEventListener('input', updatePdfSettings); // inputイベントでリアルタイム反映
}

// 設定タブを開く処理（重複防止対応）
function openSettingsTab() {
    let settingsTab = document.getElementById('tab-settings');

    // タブが存在しない場合のみ作成
    if (!settingsTab) {
        settingsTab = document.createElement('div');
        settingsTab.className = 'tab';
        settingsTab.id = 'tab-settings';
        settingsTab.dataset.target = 'content-settings';
        settingsTab.innerHTML = '設定 <span class="close-tab" id="close-settings-tab">×</span>';

        if (editorTabsContainer) {
            editorTabsContainer.appendChild(settingsTab);
        }
    }

    // ビューを切り替え
    switchMainView('content-settings');
}

/**
 * 現在開いているファイルの中で、Untitled-N の N のうち、
 * 最も小さい空いている番号を探して返します。（穴埋めロジック）
 * @returns {number} 利用可能な最小の連番
 */
function getAvailableUntitledNumber() {
    // 現在開いている全てのファイルパスを取得
    const paths = Array.from(openedFiles.keys());

    let nextNumber = 1;

    // 1から順にチェックし、使われていない最初の番号を見つける
    // 最大 999 くらいまでチェックすれば十分でしょう
    while (nextNumber < 1000) {
        const targetName = `Untitled-${nextNumber}`;

        // 既存の openedFiles のキー（パス）の中に、
        // 仮想パスとして targetName が使われているかチェック
        // ※ 実際のパス ('/path/to/Untitled-1') はチェックしない
        const isUsed = paths.some(path => {
            const fileData = openedFiles.get(path);
            // 仮想ファイルで、かつファイル名が一致するか
            return fileData && fileData.isVirtual && fileData.fileName === targetName;
        });

        if (!isUsed) {
            // 使われていない番号が見つかった
            return nextNumber;
        }

        nextNumber++;
    }

    // 1000個以上の Untitled ファイルを開くことは稀なので、
    // 万が一の場合はカウンターをそのまま返して処理を続ける
    return nextNumber;
}

// 新規タブ作成用関数
function createNewTab() {
    // 空き番号を取得
    const nextNumber = getAvailableUntitledNumber();

    const fileName = `Untitled-${nextNumber}`;
    const virtualPath = fileName; // パスとして仮の名前を使用

    // 既に開いている場合は切り替え（通常ありえないが念のため）
    if (openedFiles.has(virtualPath)) {
        switchToFile(virtualPath);
        return;
    }

    // 仮想ファイルとして登録 (isVirtualフラグを付与)
    openedFiles.set(virtualPath, {
        content: '',
        fileName: fileName,
        isVirtual: true // 重要: 未保存ファイルであることを示すフラグ
    });

    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.filepath = virtualPath;
    // ● (未保存マーク) を最初からつけておく
    tab.innerHTML = `${fileName} ● <span class="close-tab" data-filepath="${virtualPath}">×</span>`;

    // タブコンテナに追加
    if (editorTabsContainer) {
        editorTabsContainer.appendChild(tab);
    }

    // 未保存状態として管理
    fileModificationState.set(virtualPath, true);

    switchToFile(virtualPath);

    // エディタにフォーカス
    if (globalEditorView) globalEditorView.focus();
}

/**
 * MarkdownをHTMLに変換する（目次・タイトル生成オプション対応）
 * @param {string} markdown - 生のMarkdownテキスト
 * @param {object} pdfOptions - PDF設定オブジェクト
 * @param {string} title - 文書タイトル（ファイル名）を受け取る
 */
async function convertMarkdownToHtml(markdown, pdfOptions, title) {
    // 1. 特殊記法の事前処理（LaTeXレンダリング含む）
    const processed = await processMarkdownForExport(markdown);

    // markedのレンダラー初期化
    const renderer = new marked.Renderer();
    const toc = [];

    // --- 目次収集ロジック ---
    if (pdfOptions && pdfOptions.enableToc) {
        renderer.heading = (text, level, raw) => {
            const anchor = raw.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-');
            toc.push({ anchor: anchor, level: level, text: text });
            return `<h${level} id="${anchor}">${text}</h${level}>\n`;
        };
    }

    // --- 画像のカスタムレンダラー (サイズ指定とパス解決) ---
    renderer.image = (href, title, text) => {
        // 1. サイズ指定の解析 ![alt|100](src) -> width="100"
        let width = null;
        let alt = text;
        if (text && text.includes('|')) {
            const parts = text.split('|');
            alt = parts[0]; // パイプより前をaltとする
            const sizePart = parts[1];
            // 数字のみ、または 数字x数字 の場合
            if (/^\d+$/.test(sizePart)) {
                width = sizePart;
            } else if (/^\d+x\d+$/.test(sizePart)) {
                width = sizePart.split('x')[0]; // 幅だけ使用
            }
        }

        // 2. パスの絶対パス化 (file://プロトコル)
        let src = href;
        // httpやdataスキーム以外（ローカルパス）の場合
        if (!/^https?:\/\//i.test(src) && !/^data:/i.test(src)) {
            try {
                // 基準となるディレクトリを決定
                // 開いているファイルがある場合はそのディレクトリ、なければルートディレクトリ
                let baseDir = currentDirectoryPath;
                if (currentFilePath && typeof path !== 'undefined') {
                    baseDir = path.dirname(currentFilePath);
                }

                if (baseDir) {
                    // 相対パスを絶対パスに変換
                    if (!path.isAbsolute(src)) {
                        src = path.join(baseDir, src);
                    }
                    // バックスラッシュをスラッシュに置換し、file:// を付与
                    src = 'file://' + src.replace(/\\/g, '/');
                }
            } catch (e) {
                console.warn('Image path resolution failed:', e);
            }
        }

        // HTML生成
        let out = `<img src="${src}" alt="${alt}"`;
        if (title) out += ` title="${title}"`;
        if (width) out += ` width="${width}"`;
        out += '>';
        return out;
    };

    // 本文のHTML変換
    const bodyHtml = marked.parse(processed, {
        breaks: true,
        gfm: true,
        renderer: renderer
    });

    let resultHtml = bodyHtml;

    // 目次の構築と追加
    if (pdfOptions && pdfOptions.enableToc && toc.length > 0) {
        let tocHtml = `
        <div class="toc">
            <div class="toc-title">目次</div>
            <ul class="toc-list">
        `;
        toc.forEach(item => {
            tocHtml += `
                <li class="toc-item toc-level-${item.level}">
                    <a href="#${item.anchor}" class="toc-link">${item.text}</a>
                </li>
            `;
        });
        tocHtml += `</ul></div>`;
        resultHtml = tocHtml + resultHtml;
    }

    // タイトルを含める設定
    if (pdfOptions && pdfOptions.includeTitle && title) {
        const titleHtml = `<h1 class="pdf-title">${title}</h1>`;
        resultHtml = titleHtml + resultHtml;
    }

    return resultHtml;
}

// ========== CodeMirror Initialization (LiveMark機能の統合) ==========

const codeLanguages = (info) => {
    return null;
};

// 変更後：拡張子に応じて言語設定とプラグインを切り替え
function getLanguageExtensions(filePath) {
    const lang = getPrismLanguageFromPath(filePath);

    // 基本拡張機能（言語フィールドとPrismハイライト）
    const extensions = [
        currentLanguageField.init(() => lang),
        prismHighlightPlugin
    ];

    if (lang === 'markdown') {
        // Markdownの場合のみ、Markdown関連の拡張を追加
        extensions.push(
            markdown({ base: markdownLanguage, codeLanguages: codeLanguages }),
            livePreviewPlugin,
            tablePlugin
        );
    }

    return extensions;
}

const startDoc = `# Markdown Editor マニュアル

Markdown記法をリアルタイムでプレビューしながら記述できるエディタです。
ショートカットキーやツールバーを利用して効率的に編集を行えます。

## テキスト装飾

| 機能 | 記法 | ショートカット |
| :--- | :--- | :--- |
| **太字** | \`**テキスト**\` | Ctrl + B |
| *斜体* | \`*テキスト*\` | Ctrl + I |
| ~~取り消し線~~ | \`~~テキスト~~\` | Ctrl + Shift + S |
| ==ハイライト== | \`==テキスト==\` | Ctrl + Shift + H |
| \`インラインコード\` | \` \`テキスト\` \` | Ctrl + E |

## 見出しと構成

# H1 見出し
## H2 見出し
### H3 見出し

- **リスト**: 行頭に \`- \` または \`* \` を入力
1. **番号付きリスト**: 行頭に \`1. \` を入力
- [ ] **タスクリスト**: 行頭に \`- [ ] \` を入力
> **引用**: 行頭に \`> \` を入力
---
**区切り線**: \`---\` を入力

## リンクとメディア

- **リンク**: \`[タイトル](URL)\`
- **画像**: \`![代替テキスト](画像URL)\`
- **ブックマーク**: \`@card URL\` と入力するとカード形式で表示されます

## コードブロック

バッククォート3つで囲むとコードブロックになります。言語を指定するとシンタックスハイライトが適用されます。

\`\`\`javascript
console.log("Hello, World!");
\`\`\`

## テーブル（表）

ツールバーのテーブルボタンから挿入可能です。
右クリックメニューから行・列の追加や削除ができます。

| Header 1 | Header 2 |
| :--- | :--- |
| Cell 1 | Cell 2 |

## その他の機能

- **検索・置換**: Ctrl + F で検索バーを表示
- **PDFエクスポート**: ツールバーのボタンからPDFとして保存
- **改ページ**: 印刷用の改ページ位置を指定するにはツールバーの改ページボタンを使用
  <div class="page-break"></div>
- **自動保存**: 入力停止後、自動的にファイルが保存されます
`;

// ========== リスト操作ロジック (Custom List Handling) ==========

const LIST_RE = /^(\s*)((- \[[ xX]\])|(?:[-*+]|\d+(?:-\d+)*\.))\s+/;
const ORDERED_RE = /^(\s*)(\d+(?:-\d+)*)\.\s/;

function incrementOrderedNumber(currentNum) {
    const parts = currentNum.split('-');
    const lastPart = parts.pop();
    if (!isNaN(lastPart)) {
        parts.push(String(parseInt(lastPart, 10) + 1));
        return parts.join('-');
    }
    return currentNum; // Fallback
}

const handleListNewline = (view) => {
    const { state, dispatch } = view;
    const { from, to, empty } = state.selection.main;
    if (!empty) return false;

    const line = state.doc.lineAt(from);
    const text = line.text;

    const match = text.match(LIST_RE);
    if (!match) return false;

    const fullMatch = match[0];
    const indent = match[1];
    const marker = match[2];

    if (from < line.from + fullMatch.length) return false;

    if (text.trim().length === fullMatch.trim().length) {
        dispatch({ changes: { from: line.from, to: line.to, insert: "" } });
        return true;
    }

    let nextMarker = marker;
    const changes = []; // 複数の変更（改行挿入＋番号更新）をまとめる配列

    const orderedMatch = text.match(ORDERED_RE);
    if (orderedMatch) {
        const currentNum = orderedMatch[2];
        // 挿入する行の番号を計算
        let nextNumStr = incrementOrderedNumber(currentNum);
        nextMarker = nextNumStr + ".";

        // --- 追加: 後続行の自動リナンバリング処理 ---
        let lineNum = line.number + 1;
        while (lineNum <= state.doc.lines) {
            const nextLine = state.doc.line(lineNum);
            const nextLineText = nextLine.text;
            const nextMatch = nextLineText.match(ORDERED_RE);

            // 同じインデントレベルの番号付きリストが続いているか確認
            if (nextMatch && nextMatch[1] === indent) {
                // 現在の番号部分の範囲を特定
                const numStart = nextLine.from + nextMatch[1].length;
                const numEnd = numStart + nextMatch[2].length; // "."の前まで

                // 次の番号を計算して更新 (1つずつずらす)
                nextNumStr = incrementOrderedNumber(nextNumStr);

                changes.push({
                    from: numStart,
                    to: numEnd,
                    insert: nextNumStr
                });
            } else {
                break; // リストが途切れたら終了
            }
            lineNum++;
        }
        // -------------------------------------------

    } else if (marker.startsWith("- [")) {
        nextMarker = "- [ ]";
    }

    const insertText = `\n${indent}${nextMarker} `;

    // 改行挿入自体もchangesに追加
    changes.push({ from: to, insert: insertText });

    dispatch({
        changes: changes,
        selection: { anchor: to + insertText.length }
    });
    return true;
};

/**
 * ドキュメント変更時にリスト番号の不整合を検知して自動修正する関数
 * (完全な階層構造スタック管理・Loose List対応版)
 */
function handleListRenumbering(view, changes) {
    const { state, dispatch } = view;
    const doc = state.doc;
    const changesSpec = [];

    // 1. 変更範囲の最小行（最も上の行）を特定
    let minChangedLine = doc.lines;
    changes.iterChangedRanges((fromA, toA, fromB) => {
        const line = doc.lineAt(fromB);
        if (line.number < minChangedLine) minChangedLine = line.number;
    });

    if (minChangedLine > doc.lines) return;

    // 2. リストブロックの「真の開始地点」を探すために上に遡る
    // 空行はスキップし、リストでない行が見つかるか、ファイル先頭に達するまで戻る
    let startLine = minChangedLine;
    for (let i = minChangedLine - 1; i >= 1; i--) {
        const line = doc.line(i);
        const text = line.text;

        // リスト行なら開始地点の候補として更新
        if (text.match(ORDERED_RE)) {
            startLine = i;
        }
        // 空行（Loose Listの合間）なら、まだリストブロック内の可能性があるので遡行継続
        else if (text.trim() === '') {
            continue;
        }
        // リストでも空行でもないなら、そこがリストブロックの境界
        else {
            break;
        }
    }

    // 3. 階層構造を管理するスタック
    // 各レベルの { indent: インデント文字数, count: 現在の番号 } を保持
    // 例: 1-2-1 ならスタックは3要素
    let stack = [];

    // 4. 開始地点から下に向かって順番にスキャン・修正
    for (let i = startLine; i <= doc.lines; i++) {
        const line = doc.line(i);
        const text = line.text;
        const match = text.match(ORDERED_RE);

        // --- リスト行でない場合 ---
        if (!match) {
            // 空行ならリスト継続とみなしてスキップ（スタックは維持）
            if (text.trim() === '') {
                continue;
            }
            // 変更範囲より下で、リスト以外の行が出たら終了
            if (i > minChangedLine) {
                break;
            }
            // まだ変更範囲前なら、スタックをリセットして次へ
            stack = [];
            continue;
        }

        // --- リスト行の場合 ---
        const indentStr = match[1];
        const currentNumStr = match[2];
        const indentLen = indentStr.length;

        // A. スタックとの比較・調整
        if (stack.length === 0) {
            // 初回: スタックに積む
            stack.push({ indentLen: indentLen, count: 1 });
        } else {
            const lastLevel = stack[stack.length - 1];

            if (indentLen > lastLevel.indentLen) {
                // インデントが深い -> 子階層へ (1. -> 1-1.)
                stack.push({ indentLen: indentLen, count: 1 });
            } else if (indentLen === lastLevel.indentLen) {
                // インデントが同じ -> 同階層の次の番号 (1-1. -> 1-2.)
                lastLevel.count++;
            } else {
                // インデントが浅い -> 親階層へ戻る (1-2-1. -> 1-3. or 2.)
                // スタックの後ろから見ていき、現在のインデント以下のレベルを探す
                while (stack.length > 0) {
                    const top = stack[stack.length - 1];
                    if (top.indentLen > indentLen) {
                        // 深すぎる階層を捨てる
                        stack.pop();
                    } else if (top.indentLen === indentLen) {
                        // 該当する階層が見つかったらインクリメントして終了
                        top.count++;
                        break;
                    } else {
                        // スタックにあるどの階層よりも浅い（または中途半端な）インデントの場合
                        // 新しい階層としてみなすか、最も近い親の下につけるか等の判断が必要だが
                        // ここでは「親が見つからなかったので新しい兄弟」として扱う
                        stack.push({ indentLen: indentLen, count: 1 });
                        break;
                    }
                }
                // もし全てpopしてしまった場合（ルートより浅い？ありえないが安全策）
                if (stack.length === 0) {
                    stack.push({ indentLen: indentLen, count: 1 });
                }
            }
        }

        // B. 正しい番号文字列の生成 (例: [1, 2, 1] -> "1-2-1")
        const expectedNumStr = stack.map(s => s.count).join('-');

        // C. 不整合があれば修正リストに追加
        if (currentNumStr !== expectedNumStr) {
            const numStart = line.from + indentStr.length;
            const numEnd = numStart + currentNumStr.length;
            changesSpec.push({
                from: numStart,
                to: numEnd,
                insert: expectedNumStr
            });
        }
    }

    // 5. 修正を実行
    if (changesSpec.length > 0) {
        dispatch({
            changes: changesSpec,
            annotations: ExternalChange.of(true)
        });
    }
}

const handleListIndent = (view) => {
    const { state, dispatch } = view;
    const { from, empty } = state.selection.main;

    if (!empty && state.selection.ranges.some(r => !r.empty)) {
        return indentMore(view);
    }

    const line = state.doc.lineAt(from);
    const text = line.text;
    const match = text.match(ORDERED_RE);

    if (match) {
        const currentIndent = match[1];
        const currentNum = match[2];

        let prevLineNumStr = "";
        if (line.number > 1) {
            const prevLine = state.doc.line(line.number - 1);
            const prevMatch = prevLine.text.match(ORDERED_RE);
            if (prevMatch) {
                prevLineNumStr = prevMatch[2];
            }
        }

        const newNum = prevLineNumStr ? `${prevLineNumStr}-1` : `${currentNum}-1`;
        const newMarker = `${newNum}.`;

        const indentUnitText = "    ";
        const changes = [
            { from: line.from, insert: indentUnitText },
            { from: line.from + match[1].length, to: line.from + match[1].length + match[2].length + 1, insert: newMarker }
        ];

        dispatch({ changes });
        return true;
    }

    return indentMore(view);
};

const handleListDedent = (view) => {
    const { state, dispatch } = view;
    const { from, empty } = state.selection.main;

    if (!empty && state.selection.ranges.some(r => !r.empty)) {
        return indentLess(view);
    }

    const line = state.doc.lineAt(from);
    const text = line.text;
    const match = text.match(ORDERED_RE);

    if (match) {
        const currentIndent = match[1];
        if (currentIndent.length === 0) return indentLess(view);

        let targetIndentLen = Math.max(0, currentIndent.length - 4);
        let nextNum = "1";

        for (let i = line.number - 1; i >= 1; i--) {
            const prevLine = state.doc.line(i);
            const prevMatch = prevLine.text.match(ORDERED_RE);

            if (prevMatch) {
                const prevIndent = prevMatch[1];
                if (prevIndent.length <= targetIndentLen) {
                    nextNum = incrementOrderedNumber(prevMatch[2]);
                    break;
                }
            }
        }

        const newMarker = `${nextNum}.`;

        let deleteLen = 0;
        if (text.startsWith("\t")) deleteLen = 1;
        else if (text.startsWith("    ")) deleteLen = 4;
        else if (text.startsWith(" ")) deleteLen = currentIndent.length;

        if (deleteLen > 0) {
            const changes = [
                { from: line.from, to: line.from + deleteLen, insert: "" },
                { from: line.from + match[1].length, to: line.from + match[1].length + match[2].length + 1, insert: newMarker }
            ];
            dispatch({ changes });
            return true;
        }
    }

    return indentLess(view);
};

/**
 * リストの文頭で「左」を押した際、マーカーを飛び越えて前の行の末尾へ移動する
 */
const handleListNavigationLeft = (view) => {
    const { state, dispatch } = view;
    const selection = state.selection.main;
    // 範囲選択中はデフォルトの挙動に任せる
    if (!selection.empty) return false;

    const head = selection.head;
    const line = state.doc.lineAt(head);
    const text = line.text;

    // 現在の行がリスト形式かどうか判定 (既存の定数 LIST_RE を使用)
    const match = text.match(LIST_RE);

    if (match) {
        // マーカー部分の長さ（インデント + 記号 + スペース）
        const markerLength = match[0].length;
        const contentStartPos = line.from + markerLength;

        // カーソルが「文章の開始位置（マーカーの直後）」にある場合
        if (head === contentStartPos) {
            // 1行目でなければ、前の行の末尾へ移動
            if (line.number > 1) {
                const prevLine = state.doc.line(line.number - 1);
                dispatch({
                    selection: { anchor: prevLine.to, head: prevLine.to },
                    scrollIntoView: true
                });
                return true; // 処理を行ったのでデフォルト挙動をキャンセル
            }
        }
    }
    return false; // デフォルト挙動
};

/**
 * 行末で「右」を押した際、次の行がリストならマーカーを飛び越えて文頭へ移動する
 */
const handleListNavigationRight = (view) => {
    const { state, dispatch } = view;
    const selection = state.selection.main;
    if (!selection.empty) return false;

    const head = selection.head;
    const line = state.doc.lineAt(head);

    // カーソルが行末にある場合
    if (head === line.to) {
        // 最終行でなければ
        if (line.number < state.doc.lines) {
            const nextLine = state.doc.line(line.number + 1);
            const nextText = nextLine.text;

            // 次の行がリストかどうか判定
            const match = nextText.match(LIST_RE);
            if (match) {
                // 次の行の「文章の開始位置」へジャンプ
                const markerLength = match[0].length;
                const targetPos = nextLine.from + markerLength;

                dispatch({
                    selection: { anchor: targetPos, head: targetPos },
                    scrollIntoView: true
                });
                return true;
            }
        }
    }
    return false;
};

const obsidianLikeListKeymap = [
    {
        key: "Enter",
        run: handleListNewline
    },
    {
        key: "Tab",
        run: handleListIndent
    },
    {
        key: "Shift-Tab",
        run: handleListDedent
    },
    {
        key: "ArrowLeft",
        run: handleListNavigationLeft
    },
    {
        key: "ArrowRight",
        run: handleListNavigationRight
    }
];

// ========== ペースト処理（URL貼り付け時のモーダル表示） ==========
function showPasteOptionModal(url, view) {
    const existingModal = document.querySelector('.modal-overlay');
    if (existingModal) existingModal.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.width = '400px';

    const message = document.createElement('div');
    message.className = 'modal-message';
    message.textContent = `URLが検出されました: ${url}\nどのように貼り付けますか？`;
    message.style.whiteSpace = 'pre-wrap';
    message.style.wordBreak = 'break-all';

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn';
    cancelBtn.textContent = 'キャンセル';

    const plainBtn = document.createElement('button');
    plainBtn.className = 'modal-btn';
    plainBtn.textContent = '通常のURL';

    const linkBtn = document.createElement('button');
    linkBtn.className = 'modal-btn';
    linkBtn.textContent = 'リンク';

    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.className = 'modal-btn primary';
    bookmarkBtn.textContent = 'ブックマーク';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(plainBtn);
    buttons.appendChild(linkBtn);
    buttons.appendChild(bookmarkBtn);

    content.appendChild(message);
    content.appendChild(buttons);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const closeModal = () => {
        overlay.remove();
        if (view) view.focus();
    };

    cancelBtn.addEventListener('click', closeModal);

    plainBtn.addEventListener('click', () => {
        view.dispatch(view.state.replaceSelection(url));
        closeModal();
    });

    linkBtn.addEventListener('click', async () => {
        linkBtn.disabled = true;
        linkBtn.textContent = '取得中...';

        try {
            let title = url;
            if (window.electronAPI && window.electronAPI.fetchUrlTitle) {
                title = await window.electronAPI.fetchUrlTitle(url);
            }
            view.dispatch(view.state.replaceSelection(`[${title}](${url})`));
            showNotification('リンクを作成しました', 'success');
        } catch (e) {
            console.error('Failed to fetch title', e);
            view.dispatch(view.state.replaceSelection(`[${url}](${url})`));
            showNotification('タイトルの取得に失敗しました', 'error');
        }
        closeModal();
    });

    bookmarkBtn.addEventListener('click', () => {
        const state = view.state;
        const doc = state.doc;
        const selection = state.selection.main;

        const hasNewlineBefore = selection.from === 0 || doc.sliceString(selection.from - 1, selection.from) === '\n';
        const hasNewlineAfter = selection.to === doc.length || doc.sliceString(selection.to, selection.to + 1) === '\n';

        let insertText = `@card ${url}`;

        if (!hasNewlineBefore) insertText = '\n' + insertText;
        if (!hasNewlineAfter) insertText = insertText + '\n';

        view.dispatch(view.state.replaceSelection(insertText));

        showNotification('ブックマークを作成しました', 'success');
        closeModal();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });
}

const pasteHandler = EditorView.domEventHandlers({
    paste(event, view) {
        const text = event.clipboardData.getData("text/plain");
        const urlRegex = /^(http|https):\/\/[^ "]+$/;

        if (urlRegex.test(text)) {
            event.preventDefault();
            showPasteOptionModal(text, view);
            return true;
        }

        // 画像貼り付け処理
        const items = event.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                event.preventDefault();
                const file = items[i].getAsFile();

                // ファイルが保存されていない（パスがない）場合は警告
                if (!currentFilePath) {
                    showNotification('画像を保存するには、まずファイルを保存してください。', 'error');
                    return true;
                }

                const reader = new FileReader();
                reader.onload = async (e) => {
                    const arrayBuffer = e.target.result;
                    try {
                        const targetDir = path.dirname(currentFilePath);
                        // バッファをUint8Arrayにして送信
                        const result = await window.electronAPI.saveClipboardImage(new Uint8Array(arrayBuffer), targetDir);

                        if (result.success) {
                            const insertText = `![image](${result.relativePath})\n`;
                            view.dispatch(view.state.replaceSelection(insertText));
                            showNotification('画像を保存しました', 'success');
                        } else {
                            showNotification(`保存失敗: ${result.error}`, 'error');
                        }
                    } catch (err) {
                        console.error(err);
                        showNotification(`エラー: ${err.message}`, 'error');
                    }
                };
                reader.readAsArrayBuffer(file);
                return true;
            }
        }

        return false;
    }
});

// 高機能ドロップハンドラー (dragover追加)
const dropHandler = EditorView.domEventHandlers({
    // これがないとドラッグ時に駐車禁止マークが出てドロップできません
    dragover(event, view) {
        event.preventDefault();
        return false;
    },
    drop(event, view) {
        const { dataTransfer } = event;

        // -------------------------------------------------
        // ケース1: ファイルがドロップされた場合 (ローカルファイル)
        // -------------------------------------------------
        if (dataTransfer.files && dataTransfer.files.length > 0) {
            event.preventDefault();

            const imageFiles = [];
            const textFiles = [];

            for (let i = 0; i < dataTransfer.files.length; i++) {
                const file = dataTransfer.files[i];
                if (file.type.startsWith('image/')) {
                    imageFiles.push(file);
                } else {
                    textFiles.push(file);
                }
            }

            // A. 画像ファイルの処理
            if (imageFiles.length > 0) {
                if (!currentFilePath || currentFilePath === 'README.md') {
                    showNotification('画像を保存するには、まずファイルを保存してください。', 'error');
                    return true;
                }

                imageFiles.forEach(file => {
                    const reader = new FileReader();
                    reader.onload = async (e) => {
                        const arrayBuffer = e.target.result;
                        try {
                            const targetDir = path.dirname(currentFilePath);
                            const result = await window.electronAPI.saveClipboardImage(new Uint8Array(arrayBuffer), targetDir);

                            if (result.success) {
                                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                                const insertPos = pos !== null ? pos : view.state.selection.main.head;
                                const insertText = `![image](${result.relativePath})\n`;

                                view.dispatch({
                                    changes: { from: insertPos, insert: insertText },
                                    selection: { anchor: insertPos + insertText.length }
                                });
                                showNotification('画像を保存しました', 'success');
                            } else {
                                showNotification(`保存失敗: ${result.error}`, 'error');
                            }
                        } catch (err) {
                            console.error(err);
                        }
                    };
                    reader.readAsArrayBuffer(file);
                });
            }

            // B. テキストファイル等の処理
            if (textFiles.length > 0) {
                const file = textFiles[0];
                if (file.path) {
                    openFile(file.path, file.name);
                }
            }
            return true;
        }

        // -------------------------------------------------
        // ケース2: Webページからの画像ドラッグ (HTML/URL)
        // -------------------------------------------------
        const html = dataTransfer.getData('text/html');
        if (html) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const img = doc.querySelector('img');

            if (img && img.src) {
                event.preventDefault();

                if (!currentFilePath || currentFilePath === 'README.md') {
                    showNotification('画像を保存するには、まずファイルを保存してください。', 'error');
                    return true;
                }

                (async () => {
                    try {
                        const targetDir = path.dirname(currentFilePath);

                        if (img.src.startsWith('data:')) {
                            const response = await fetch(img.src);
                            const blob = await response.blob();
                            const arrayBuffer = await blob.arrayBuffer();
                            const result = await window.electronAPI.saveClipboardImage(new Uint8Array(arrayBuffer), targetDir);
                            if (result.success) insertImageLink(result.relativePath);
                        }
                        else {
                            showNotification('Web画像をダウンロード中...', 'info');
                            const result = await window.electronAPI.downloadImage(img.src, targetDir);
                            if (result.success) {
                                insertImageLink(result.relativePath);
                                showNotification('Web画像を保存しました', 'success');
                            } else {
                                showNotification(`画像保存失敗: ${result.error}`, 'error');
                            }
                        }
                    } catch (e) {
                        console.error(e);
                        showNotification(`エラー: ${e.message}`, 'error');
                    }
                })();

                function insertImageLink(relPath) {
                    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                    const insertPos = pos !== null ? pos : view.state.selection.main.head;
                    const insertText = `![image](${relPath})\n`;
                    view.dispatch({
                        changes: { from: insertPos, insert: insertText },
                        selection: { anchor: insertPos + insertText.length }
                    });
                }
                return true;
            }
        }

        // -------------------------------------------------
        // ケース3: 通常のテキストドラッグ
        // -------------------------------------------------
        return false;
    }
});

// ========== 検索ウィジェット管理 ==========
let searchState = {
    query: "",
    replace: "",
    caseSensitive: false,
    regexp: false,
    wholeWord: false
};

let searchWidgetControl = null;

function setupSearchWidget(view) {
    const widget = document.getElementById('custom-search-widget');
    const searchInput = document.getElementById('search-input');
    const replaceInput = document.getElementById('replace-input');
    const replaceRow = document.getElementById('replace-row');
    const searchCount = document.getElementById('search-count');

    // Toggle Buttons
    const btnToggleReplace = document.getElementById('search-toggle-replace');
    const btnCase = document.getElementById('opt-case');
    const btnWord = document.getElementById('opt-word');
    const btnRegex = document.getElementById('opt-regex');

    // Action Buttons
    const btnPrev = document.getElementById('search-prev');
    const btnNext = document.getElementById('search-next');
    const btnCloseSearch = document.getElementById('search-close');
    const btnReplace = document.getElementById('replace-btn');
    const btnReplaceAll = document.getElementById('replace-all-btn');

    if (!widget) return;

    // デバウンス用のタイマー
    let debounceTimer = null;
    let lastQueryString = ""; // 最後に実行したクエリを保存

    const performSearch = () => {
        // 空クエリの場合は検索状態をクリアして終了
        if (!searchInput.value) {
            view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "", replace: "" })) });
            searchCount.textContent = "No results";
            lastQueryString = "";
            return;
        }

        try {
            // 現在の入力値を保存
            lastQueryString = searchInput.value;

            const query = new SearchQuery({
                search: searchInput.value,
                caseSensitive: searchState.caseSensitive,
                regexp: searchState.regexp,
                wholeWord: searchState.wholeWord,
                replace: replaceInput.value
            });

            // CodeMirrorに検索クエリをセット（ハイライト更新）
            view.dispatch({ effects: setSearchQuery.of(query) });

            // 件数カウント (負荷対策: 上限1000件で打ち切り)
            let count = 0;
            const cursor = query.getCursor(view.state);
            // 無限ループ防止のため最大1000件まで
            const MAX_SEARCH_COUNT = 1000;

            // next()の結果オブジェクトを確認してループ
            let item = cursor.next();
            while (!item.done) {
                count++;
                if (count >= MAX_SEARCH_COUNT) {
                    break;
                }
                item = cursor.next();
            }

            if (count > 0) {
                searchCount.textContent = count >= MAX_SEARCH_COUNT ? "1000+" : `${count} results`;
            } else {
                searchCount.textContent = "No results";
            }
        } catch (e) {
            // 正規表現エラーなどはここでキャッチ
            console.warn("Search Error:", e);
            searchCount.textContent = "Invalid Regex";
        }
    };

    const updateSearch = () => {
        // 入力ごとの即時実行を防ぐ（デバウンス）
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(performSearch, 300); // 300ms待機
    };

    // Event Listeners
    searchInput.addEventListener('input', updateSearch);
    replaceInput.addEventListener('input', updateSearch);

    // Options
    const toggleOption = (btn, key) => {
        searchState[key] = !searchState[key];
        btn.classList.toggle('active', searchState[key]);
        performSearch(); // オプション変更は即時実行
    };

    btnCase.addEventListener('click', () => toggleOption(btnCase, 'caseSensitive'));
    btnWord.addEventListener('click', () => toggleOption(btnWord, 'wholeWord'));
    btnRegex.addEventListener('click', () => toggleOption(btnRegex, 'regexp'));

    // Navigation
    btnNext.addEventListener('click', () => {
        // 現在のクエリが古い場合のみ実行
        if (searchInput.value !== lastQueryString) {
            performSearch();
        }
        findNext(view);
        view.focus();
    });
    btnPrev.addEventListener('click', () => {
        if (searchInput.value !== lastQueryString) {
            performSearch();
        }
        findPrevious(view);
        view.focus();
    });

    // Replace functions
    const executeReplace = (all = false) => {
        performSearch(); // 置換前に最新のクエリ状態を保証
        if (all) replaceAll(view);
        else replaceNext(view);
    };

    btnReplace.addEventListener('click', () => executeReplace(false));
    btnReplaceAll.addEventListener('click', () => executeReplace(true));

    btnToggleReplace.addEventListener('click', () => {
        const isHidden = replaceRow.classList.contains('hidden');
        if (isHidden) {
            replaceRow.classList.remove('hidden');
            btnToggleReplace.classList.add('expanded');
        } else {
            replaceRow.classList.add('hidden');
            btnToggleReplace.classList.remove('expanded');
        }
    });

    const closeWidget = () => {
        widget.classList.add('hidden');
        view.focus();
    };
    btnCloseSearch.addEventListener('click', closeWidget);

    // キーボード操作
    const handleKeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();

            // Enterキーが押された際、検索クエリが未反映なら実行する
            if (searchInput.value !== lastQueryString) {
                performSearch();
            }

            // その後で移動処理
            if (e.shiftKey) findPrevious(view);
            else if (e.ctrlKey && e.altKey) replaceAll(view);
            else findNext(view);

            // Note: Enterキーの場合は入力欄にフォーカスを残したままにする
            // drawSelection拡張により、フォーカスがなくても選択範囲（青色）が表示されるようになる
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeWidget();
        }
    };
    searchInput.addEventListener('keydown', handleKeydown);
    replaceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            if (searchInput.value !== lastQueryString) {
                performSearch();
            }
            replaceNext(view);
        } else {
            handleKeydown(e);
        }
    });

    return {
        open: () => {
            widget.classList.remove('hidden');
            searchInput.select();

            // 選択テキストがあれば検索ワードにセット
            const { from, to } = view.state.selection.main;
            if (from !== to) {
                const text = view.state.sliceDoc(from, to);
                searchInput.value = text;
                performSearch();
            }
        },
        toggleReplace: () => {
            widget.classList.remove('hidden');
            replaceRow.classList.remove('hidden');
            btnToggleReplace.classList.add('expanded');

            const { from, to } = view.state.selection.main;
            if (from !== to) {
                const text = view.state.sliceDoc(from, to);
                searchInput.value = text;
                performSearch();
            }
            replaceInput.focus();
        }
    };
}

/**
 * コマンドIDに対応するキーバインド設定を常に配列で取得するヘルパー
 * 既存の設定が文字列でも配列でもエラーにならないように吸収します
 */
function getKeybindingsForCommand(commandId) {
    const cmd = COMMANDS_REGISTRY.find(c => c.id === commandId);
    let current = undefined;

    if (appSettings.keybindings) {
        current = appSettings.keybindings[commandId];
    }

    // 設定値が undefined の場合はデフォルトを使用
    if (current === undefined) {
        return cmd && cmd.defaultKey ? [cmd.defaultKey] : [];
    }

    // 設定値が null の場合は無効化されているので空配列
    if (current === null) {
        return [];
    }

    // 文字列なら配列化、既に配列ならそのまま返す (ここが重要)
    return Array.isArray(current) ? current : [current];
}

// キーマップを動的に入れ替えるためのコンパートメント
const keybindingsCompartment = new Compartment();
// ファイルパスを受け取り、Markdownの場合のみリスト操作キーマップを含める
function getCombinedKeymap(filePath = null) {
    // 引数がなければ現在開いているパスを使用、それもなければデフォルト(Markdown扱い)
    const targetPath = filePath || currentFilePath || 'default.md';
    const isMarkdown = getPrismLanguageFromPath(targetPath) === 'markdown';

    const dynamicKeymap = [];

    // ユーザー設定のコマンド (COMMANDS_REGISTRY)
    COMMANDS_REGISTRY.filter(c => c.context === 'editor').forEach(cmd => {
        const keys = getKeybindingsForCommand(cmd.id);
        keys.forEach(key => {
            if (key && typeof key === 'string') {
                dynamicKeymap.push({
                    key: key,
                    run: (view) => {
                        cmd.run(view);
                        return true; // イベント伝播を停止
                    }
                });
            }
        });
    });

    // 検索ウィジェット用のEscapeキー処理
    dynamicKeymap.push({
        key: "Escape",
        run: (view) => {
            const widget = document.getElementById('custom-search-widget');
            if (widget && !widget.classList.contains('hidden')) {
                widget.classList.add('hidden');
                view.focus();
                return true;
            }
            return false;
        }
    });

    // Markdownの場合のみ、リスト操作(Enter/Tab等)のキーマップを結合
    if (isMarkdown) {
        return [
            ...dynamicKeymap,
            ...obsidianLikeListKeymap
        ];
    } else {
        return dynamicKeymap;
    }
}

// Prism.jsを使ってコードブロックまたはファイル全体をハイライトするカスタムプラグイン
const prismHighlightPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = this.getPrismDecorations(view);
    }

    update(update) {
        // ドキュメント変更、ビューポート変更、または言語ロード完了時の強制更新で装飾を再構築
        if (update.docChanged || update.viewportChanged || update.transactions.length > 0) {
            this.decorations = this.getPrismDecorations(update.view);
        }
    }

    getPrismDecorations(view) {
        const builder = new RangeSetBuilder();
        const doc = view.state.doc;
        const currentLang = view.state.field(currentLanguageField);

        // Prism本体が読み込まれているかチェック
        if (typeof Prism === 'undefined') return builder.finish();

        // 構文解析ツリーを利用 (Markdown用)
        const { syntaxTree } = require("@codemirror/language");

        // ケース1: Markdown以外の場合（ファイル全体をハイライト）
        if (currentLang !== 'markdown') {
            const grammar = Prism.languages[currentLang];
            if (!grammar) {
                // 言語定義がない場合はAutoloaderで読み込みを試みる
                if (currentLang && Prism.plugins && Prism.plugins.autoloader) {
                    try {
                        Prism.plugins.autoloader.loadLanguages(currentLang, () => {
                            view.dispatch({}); // 再描画トリガー
                        });
                    } catch (e) { }
                }
                return builder.finish();
            }

            const text = doc.toString();
            // 全体をトークン化
            const tokens = Prism.tokenize(text, grammar);

            let pos = 0;
            const processToken = (token) => {
                if (typeof token === "string") {
                    pos += token.length;
                } else {
                    const content = token.content;
                    if (Array.isArray(content)) {
                        content.forEach(processToken);
                    } else {
                        const type = token.type;
                        const alias = token.alias || "";
                        const className = `token ${type} ${alias}`;
                        const len = token.length;
                        builder.add(pos, pos + len, Decoration.mark({ class: className }));
                        pos += len;
                    }
                }
            };

            if (Array.isArray(tokens)) {
                tokens.forEach(processToken);
            }

            return builder.finish();
        }

        // ケース2: Markdownの場合（コードブロックのみハイライト）
        const processed = new Set();

        for (const { from, to } of view.visibleRanges) {
            syntaxTree(view.state).iterate({
                from,
                to,
                enter: (node) => {
                    if (node.name === "FencedCode") {
                        if (processed.has(node.from)) return;
                        processed.add(node.from);

                        const line = doc.lineAt(node.from);
                        const match = line.text.match(/^(\s*`{3,})([\w-]*)/);
                        if (!match) return;

                        let langName = match[2].toLowerCase();

                        // 言語名の正規化 (Prism用)
                        const langMap = {
                            'js': 'javascript', 'ts': 'typescript', 'py': 'python',
                            'sh': 'bash', 'zsh': 'bash', 'shell': 'bash',
                            'rb': 'ruby', 'cs': 'csharp', 'kt': 'kotlin',
                            'rs': 'rust', 'go': 'go', 'md': 'markdown',
                            'html': 'markup', 'xml': 'markup', 'svg': 'markup',
                            'c': 'c', 'cpp': 'cpp', 'bf': 'brainfuck'
                        };
                        if (langMap[langName]) langName = langMap[langName];

                        if (['whitespace', 'ws'].includes(langName)) return;

                        const grammar = Prism.languages[langName];
                        if (!grammar) {
                            if (langName && Prism.plugins && Prism.plugins.autoloader) {
                                try {
                                    Prism.plugins.autoloader.loadLanguages(langName, () => {
                                        view.dispatch({});
                                    });
                                } catch (e) { }
                            }
                            return;
                        }

                        const startLine = doc.lineAt(node.from).number;
                        const endLine = doc.lineAt(node.to).number;
                        if (startLine >= endLine - 1) return;

                        const bodyStart = doc.line(startLine + 1).from;
                        const bodyEnd = doc.line(endLine - 1).to;
                        const code = doc.sliceString(bodyStart, bodyEnd);
                        const tokens = Prism.tokenize(code, grammar);

                        let pos = bodyStart;
                        const addDeco = (token) => {
                            if (typeof token === "string") {
                                pos += token.length;
                            } else {
                                const type = token.type;
                                const alias = token.alias || "";
                                const className = `token ${type} ${alias}`;
                                if (Array.isArray(token.content)) {
                                    token.content.forEach(t => addDeco(t));
                                } else {
                                    builder.add(pos, pos + token.length, Decoration.mark({ class: className }));
                                    pos += token.length;
                                }
                            }
                        };

                        if (Array.isArray(tokens)) {
                            tokens.forEach(t => addDeco(t));
                        }
                    }
                }
            });
        }
        return builder.finish();
    }
}, {
    decorations: v => v.decorations
});

// getCombinedKeymapにfilePathを渡すように修正
function createEditorState(content, filePath) {
    const initialTheme = appSettings.theme === 'dark' ? oneDark : [];
    const initialStyle = EditorView.theme({
        ".cm-content": {
            fontSize: appSettings.fontSize,
            fontFamily: appSettings.fontFamily
        },
        ".cm-gutters": {
            fontSize: appSettings.fontSize,
            fontFamily: appSettings.fontFamily
        },
        "&": { height: "100%" },
        ".cm-scroller": { fontFamily: 'inherit' }
    });
    const indentString = appSettings.insertSpaces ? " ".repeat(appSettings.tabSize) : "\t";

    return EditorState.create({
        doc: content,
        extensions: [
            EditorState.phrases.of({ "Find": "検索...", }),
            themeCompartment.of(initialTheme),
            editorStyleCompartment.of(initialStyle),
            indentUnitCompartment.of(indentUnit.of(indentString)),
            tabSizeCompartment.of(EditorState.tabSize.of(appSettings.tabSize)),
            lineWrappingCompartment.of(appSettings.wordWrap ? EditorView.lineWrapping : []),

            // filePathを渡して、ファイルタイプに応じたキーマップを生成
            keybindingsCompartment.of(Prec.highest(keymap.of(getCombinedKeymap(filePath)))),

            pasteHandler,
            dropHandler,
            history(),
            search(),
            drawSelection(),
            dropCursor(),

            // デフォルトキーマップ (優先度低)
            keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),

            syntaxHighlighting(defaultHighlightStyle),
            languageCompartment.of(getLanguageExtensions(filePath)),
            activeLineCompartment.of(appSettings.highlightActiveLine ? highlightActiveLine() : []),
            autoCloseBracketsCompartment.of(appSettings.autoCloseBrackets ? closeBrackets() : []),
            lineNumbersCompartment.of(appSettings.showLineNumbers ? lineNumbers() : []),
            whitespaceCompartment.of(appSettings.showWhitespace ? customHighlightWhitespace : []),

            conflictField,

            EditorView.updateListener.of(update => {
                if (update.docChanged) {
                    // プログラムによる変更かどうかをチェック
                    const isExternal = update.transactions.some(tr => tr.annotation(ExternalChange));

                    // 外部変更でなければ、入力イベントとして処理（保存フラグなど）
                    onEditorInput(!isExternal);

                    // ユーザー操作による変更なら、リスト番号の自動修正を実行
                    if (!isExternal) {
                        handleListRenumbering(update.view, update.changes);
                    }
                }
            })
        ]
    });
}

// ========== Hotkey UI Logic ==========

let isRecordingKey = false;
let hotkeySearchFilter = "";
let hotkeyKeyFilter = null; // null or "Mod-s" string

// リストの描画（複数ショートカット対応版）
function renderHotkeysList() {
    const listContainer = document.getElementById('hotkeys-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    COMMANDS_REGISTRY.forEach(cmd => {
        // 設定されているキーの配列を取得
        const keys = getKeybindingsForCommand(cmd.id);

        // テキストフィルター
        if (hotkeySearchFilter) {
            const lowerFilter = hotkeySearchFilter.toLowerCase();
            const keysStr = keys.map(k => formatKeyDisplay(k)).join(' ').toLowerCase();
            if (!cmd.name.toLowerCase().includes(lowerFilter) &&
                !cmd.id.includes(lowerFilter) &&
                !keysStr.includes(lowerFilter)) {
                return;
            }
        }

        // キーフィルター (特定のキーバインドが含まれているか)
        if (hotkeyKeyFilter) {
            if (!keys.includes(hotkeyKeyFilter)) return;
        }

        // 行要素の作成
        const row = document.createElement('div');
        row.className = 'hotkey-item';

        // 設定があるかどうか
        const hasCustomSettings = appSettings.keybindings && appSettings.keybindings[cmd.id] !== undefined;

        // キーバッジのHTML生成
        const badgesContainer = document.createElement('div');
        badgesContainer.className = 'hotkey-badges';
        badgesContainer.style.display = 'flex';
        badgesContainer.style.flexWrap = 'wrap';
        badgesContainer.style.gap = '4px';
        badgesContainer.style.alignItems = 'center';

        keys.forEach(key => {
            const badge = document.createElement('div');
            badge.className = 'kbd-shortcut';
            badge.title = 'クリックして変更';
            badge.innerHTML = `
                <span>${formatKeyDisplay(key)}</span>
                <span class="remove-key-btn" title="削除" style="margin-left:6px; opacity:0.5; font-weight:bold; cursor:pointer;">×</span>
            `;

            // 変更イベント
            badge.addEventListener('click', (e) => {
                // 削除ボタンがクリックされた場合
                if (e.target.classList.contains('remove-key-btn')) {
                    e.stopPropagation();
                    updateKeybinding(cmd.id, null, key); // nullを渡して削除
                    renderHotkeysList();
                    return;
                }
                // バッジ本体クリックで変更 (oldKeyとして現在のキーを渡す)
                e.stopPropagation();
                startRecordingKey(cmd.id, badge, key);
            });

            badgesContainer.appendChild(badge);
        });

        // キーが一つもない場合の表示
        if (keys.length === 0) {
            const emptyBadge = document.createElement('div');
            emptyBadge.className = 'kbd-shortcut blank';
            emptyBadge.textContent = 'Unbound';
            badgesContainer.appendChild(emptyBadge);
        }

        row.innerHTML = `
            <div class="hotkey-label">
                <div class="command-name">${cmd.name}</div>
                <div class="command-id">${cmd.id}</div>
            </div>
            <div class="hotkey-controls" style="flex: 2; justify-content: flex-end;">
                </div>
        `;

        // コントロール部分に要素を追加
        const controlsDiv = row.querySelector('.hotkey-controls');
        controlsDiv.appendChild(badgesContainer);

        // 追加(+)ボタン
        const addBtn = document.createElement('button');
        addBtn.className = 'hotkey-action-btn add-btn';
        addBtn.title = 'ショートカットを追加';
        addBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
        `;
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // 入力用の一時的なバッジを作成してコンテナに追加
            const tempBadge = document.createElement('div');
            tempBadge.className = 'kbd-shortcut temp-badge';
            tempBadge.textContent = '...';
            badgesContainer.appendChild(tempBadge);

            // 新規追加モードで記録開始 (oldKey = null)
            startRecordingKey(cmd.id, tempBadge, null);
        });
        controlsDiv.appendChild(addBtn);

        // リセットボタン（設定がある場合のみ表示）
        if (hasCustomSettings) {
            const restoreBtn = document.createElement('button');
            restoreBtn.className = 'hotkey-action-btn restore-btn';
            restoreBtn.title = 'デフォルトに戻す';
            restoreBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                    <path d="M3 3v5h5"></path>
                </svg>
            `;
            restoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (appSettings.keybindings) {
                    delete appSettings.keybindings[cmd.id];
                }
                saveSettings();
                if (globalEditorView) {
                    globalEditorView.dispatch({
                        effects: keybindingsCompartment.reconfigure(
                            Prec.highest(keymap.of(getCombinedKeymap()))
                        )
                    });
                }
                renderHotkeysList();
                showNotification('デフォルト設定に戻しました', 'success');
            });
            controlsDiv.appendChild(restoreBtn);
        }

        listContainer.appendChild(row);
    });
}

// キー入力の記録モード
function startRecordingKey(commandId, element, oldKey = null) {
    if (isRecordingKey) return;
    isRecordingKey = true;

    // 元のHTMLを保存（バッジの中身など）
    const originalHTML = element.innerHTML;

    // UI上の見た目を入力待ち状態にする
    element.innerHTML = '<span style="font-size:10px;">Type key...</span>';
    element.classList.add('recording');

    const handleKeyDown = (e) => {
        e.preventDefault();
        e.stopPropagation();

        // 修飾キーのみの場合は無視
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

        // Escキーでキャンセル
        if (e.key === 'Escape') {
            cleanup(true);
            return;
        }

        // キーの生成 (例: Mod-Shift-f)
        const parts = [];
        if (e.metaKey || e.ctrlKey) parts.push('Mod');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');

        // Key名 (大文字小文字対応)
        let keyChar = e.key;
        if (keyChar === ' ') keyChar = 'Space';
        // 矢印キー等の正規化
        if (keyChar === 'ArrowUp') keyChar = 'ArrowUp';
        else if (keyChar === 'ArrowDown') keyChar = 'ArrowDown';
        else if (keyChar === 'ArrowLeft') keyChar = 'ArrowLeft';
        else if (keyChar === 'ArrowRight') keyChar = 'ArrowRight';
        else if (keyChar.length === 1) keyChar = keyChar.toLowerCase();

        parts.push(keyChar);
        const newKeyString = parts.join('-');

        // 保存（oldKeyがあれば置換、なければ追加）
        updateKeybinding(commandId, newKeyString, oldKey);

        cleanup(false);
    };

    const handleMouseDown = (e) => {
        // 外部クリックでキャンセル
        if (e.target !== element && !element.contains(e.target)) {
            cleanup(true);
        }
    };

    const cleanup = (cancelled = false) => {
        isRecordingKey = false;
        element.classList.remove('recording');
        window.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('mousedown', handleMouseDown);

        if (cancelled) {
            element.innerHTML = originalHTML; // 元に戻す
            // 新規追加用の仮要素（...）だった場合は削除する
            if (element.classList.contains('temp-badge')) {
                element.remove();
            }
        } else {
            // 成功した場合はリスト全体を再描画して反映
            renderHotkeysList();
        }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('mousedown', handleMouseDown);
}

// 設定の更新（追加・変更・削除対応）
function updateKeybinding(id, newKey, oldKeyToReplace = null) {
    if (!appSettings.keybindings) appSettings.keybindings = {};

    // 現在の設定を配列として取得
    let currentKeys = getKeybindingsForCommand(id);

    if (oldKeyToReplace) {
        // --- 既存キーの変更または削除 ---
        if (newKey) {
            // 置換 (Edit): 古いキーを探して新しいキーに変える
            currentKeys = currentKeys.map(k => k === oldKeyToReplace ? newKey : k);
        } else {
            // 削除 (Remove): newKeyがnullの場合は削除
            currentKeys = currentKeys.filter(k => k !== oldKeyToReplace);
        }
    } else {
        // --- 新規追加 ---
        if (newKey) {
            // 重複チェック: 同じキーがなければ追加
            if (!currentKeys.includes(newKey)) {
                currentKeys.push(newKey);
            }
        } else {
            // 全削除 (リセットなどで使用)
            currentKeys = [];
        }
    }

    // 空配列になった場合は null (無効) として保存、それ以外は配列として保存
    if (currentKeys.length === 0) {
        appSettings.keybindings[id] = null;
    } else {
        appSettings.keybindings[id] = currentKeys;
    }

    saveSettings();

    // 現在開いているエディタのキーマップを即座に更新
    if (globalEditorView) {
        globalEditorView.dispatch({
            effects: keybindingsCompartment.reconfigure(
                Prec.highest(keymap.of(getCombinedKeymap()))
            )
        });
    }
}

// 検索・フィルター機能のセットアップ
function setupHotkeySearch() {
    const input = document.getElementById('hotkey-search-input');
    const btnKeyFilter = document.getElementById('btn-hotkey-filter-by-key');
    const status = document.getElementById('hotkey-filter-status');

    if (input) {
        input.addEventListener('input', (e) => {
            hotkeySearchFilter = e.target.value;
            hotkeyKeyFilter = null;
            status.classList.add('hidden');
            renderHotkeysList();
        });
    }

    if (btnKeyFilter) {
        btnKeyFilter.addEventListener('click', () => {
            status.classList.remove('hidden');
            status.textContent = 'キーを入力してください...';

            const handler = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

                const parts = [];
                if (e.metaKey || e.ctrlKey) parts.push('Mod');
                if (e.altKey) parts.push('Alt');
                if (e.shiftKey) parts.push('Shift');
                let keyChar = e.key;
                if (keyChar.length === 1) keyChar = keyChar.toLowerCase();
                parts.push(keyChar);

                hotkeyKeyFilter = parts.join('-');
                hotkeySearchFilter = "";
                input.value = "";

                status.textContent = `Filter: ${formatKeyDisplay(hotkeyKeyFilter)} (Click to clear)`;
                renderHotkeysList();

                window.removeEventListener('keydown', handler, true);
            };
            window.addEventListener('keydown', handler, true);
        });
    }

    if (status) {
        status.addEventListener('click', () => {
            hotkeyKeyFilter = null;
            status.classList.add('hidden');
            renderHotkeysList();
        });
    }
}

function initEditor() {
    if (globalEditorView) return;

    // 初期状態（README相当）でステートを作成
    const state = createEditorState(startDoc, 'default.md');

    globalEditorView = new EditorView({
        state: state,
        parent: editorContainer,
    });

    // カスタム検索ウィジェットのセットアップ
    searchWidgetControl = setupSearchWidget(globalEditorView);
}

// ========== エディタ操作ヘルパー ==========
function toggleLinePrefix(view, prefix) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from } = state.selection.main;
    const line = state.doc.lineAt(from);
    const match = line.text.match(/^\s*(#+\s*|>\s*)/);

    let changes;
    let newCursorPos;

    if (match && match[1].trim() === prefix.trim()) {
        const matchLen = match[0].length;
        changes = { from: line.from, to: line.from + matchLen, insert: "" };
        newCursorPos = line.to - matchLen;
    } else {
        const insertText = prefix.endsWith(' ') ? prefix : prefix + ' ';
        if (match) {
            const matchLen = match[0].length;
            changes = { from: line.from, to: line.from + matchLen, insert: insertText };
            newCursorPos = line.to - matchLen + insertText.length;
        } else {
            changes = { from: line.from, to: line.from, insert: insertText };
            newCursorPos = line.to + insertText.length;
        }
    }

    dispatch({
        changes: changes,
        selection: { anchor: newCursorPos, head: newCursorPos }
    });
    view.focus();
}

function toggleMark(view, mark) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to, empty } = state.selection.main;
    const selectedText = state.sliceDoc(from, to);
    const extendedFrom = Math.max(0, from - mark.length);
    const extendedTo = Math.min(state.doc.length, to + mark.length);

    if (extendedFrom >= 0 && extendedTo <= state.doc.length) {
        const surroundingText = state.sliceDoc(extendedFrom, extendedTo);
        if (surroundingText.startsWith(mark) && surroundingText.endsWith(mark)) {
            dispatch({
                changes: { from: extendedFrom, to: extendedTo, insert: selectedText },
                selection: { anchor: extendedFrom, head: extendedFrom + selectedText.length }
            });
            view.focus(); return;
        }
    }

    dispatch({
        changes: { from: from, to: to, insert: `${mark}${selectedText}${mark}` },
        selection: empty
            ? { anchor: from + mark.length, head: from + mark.length }
            : { anchor: to + mark.length * 2, head: to + mark.length * 2 }
    });
    view.focus();
}

function toggleHighlightColor(view, color) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to } = state.selection.main;
    const selectedText = state.sliceDoc(from, to);

    // HTMLタグの形式
    const openTag = `<span style="background-color: ${color}">`;
    const closeTag = `</span>`;

    const insertText = `${openTag}${selectedText}${closeTag}`;

    dispatch({
        changes: { from, to, insert: insertText },
        selection: { anchor: from + insertText.length, head: from + insertText.length }
    });
    view.focus();
}

function toggleList(view, type) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to } = state.selection.main;
    const startLine = state.doc.lineAt(from);
    const endLine = state.doc.lineAt(to);
    let changes = [];
    let totalChangeLength = 0;

    for (let i = startLine.number; i <= endLine.number; i++) {
        const line = state.doc.line(i);
        const text = line.text;
        const bulletMatch = text.match(/^(\s*)([-*+] )\s*/);
        const orderedMatch = text.match(/^(\s*)(\d+(?:-\d+)*\. )\s*/);
        const checkMatch = text.match(/^(\s*)(- \[[ x]\] )\s*/);

        let diff = 0;

        if (type === 'ul') {
            if (bulletMatch) {
                const delLen = bulletMatch[0].length - bulletMatch[1].length;
                changes.push({ from: line.from + bulletMatch[1].length, to: line.from + bulletMatch[0].length, insert: "" });
                diff = -delLen;
            } else {
                changes.push({ from: line.from, insert: "- " });
                diff = 2;
            }
        } else if (type === 'ol') {
            if (orderedMatch) {
                const delLen = orderedMatch[0].length - orderedMatch[1].length;
                changes.push({ from: line.from + orderedMatch[1].length, to: line.from + orderedMatch[0].length, insert: "" });
                diff = -delLen;
            } else {
                changes.push({ from: line.from, insert: "1. " });
                diff = 3;
            }
        } else if (type === 'task') {
            if (checkMatch) {
                const delLen = checkMatch[0].length - checkMatch[1].length;
                changes.push({ from: line.from + checkMatch[1].length, to: line.from + checkMatch[0].length, insert: "" });
                diff = -delLen;
            } else {
                changes.push({ from: line.from, insert: "- [ ] " });
                diff = 6;
            }
        }
        totalChangeLength += diff;
    }

    const newHead = endLine.to + totalChangeLength;

    dispatch({
        changes: changes,
        selection: { anchor: newHead, head: newHead }
    });
    view.focus();
}

function insertLink(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to } = state.selection.main;
    const selectedText = state.sliceDoc(from, to);
    const text = selectedText || "link";
    dispatch({ changes: { from: from, to: to, insert: `[${text}](url)` }, selection: { anchor: from + text.length + 3, head: from + text.length + 6 } });
    view.focus();
}

function insertImage(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to } = state.selection.main;
    const selectedText = state.sliceDoc(from, to);
    const text = selectedText || "Image";
    dispatch({
        changes: { from: from, to: to, insert: `![${text}](url)` },
        selection: { anchor: from + 2 + text.length + 2, head: from + 2 + text.length + 5 }
    });
    view.focus();
}

function insertTable(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to } = state.selection.main;

    const table =
        `| Col 1 | Col 2 | Col 3 |
| :--- | :--- | :--- |
|  |  |  |
|  |  |  |
`;

    const lineStart = state.doc.lineAt(from).from;
    const needsNewline = from !== lineStart;
    const insertText = (needsNewline ? "\n" : "") + table;

    dispatch({
        changes: { from: from, to: to, insert: insertText },
        selection: { anchor: from + (needsNewline ? 1 : 0) + 2 }
    });
    view.focus();
}

function insertHorizontalRule(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from } = state.selection.main;
    const line = state.doc.lineAt(from);
    const insert = `\n---\n`;
    const newPos = line.to + insert.length;
    dispatch({
        changes: { from: line.to, insert: insert },
        selection: { anchor: newPos, head: newPos }
    });
    view.focus();
}

function insertPageBreak(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from } = state.selection.main;
    const line = state.doc.lineAt(from);

    const insert = `\n<div class="page-break"></div>\n`;
    const newPos = line.to + insert.length;

    dispatch({
        changes: { from: line.to, insert: insert },
        selection: { anchor: newPos, head: newPos }
    });
    view.focus();
}

function insertCodeBlock(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to } = state.selection.main;
    const selectedText = state.sliceDoc(from, to);
    const text = selectedText || "";
    const insert = `\`\`\`\n${text}\n\`\`\`\n`;

    dispatch({
        changes: { from: from, to: to, insert: insert },
        selection: { anchor: from + 4, head: from + 4 }
    });
    view.focus();
}

// テキストの配置を変更する関数
function setTextAlignment(view, alignment) {
    if (!view) return;
    const { state, dispatch } = view;
    const selection = state.selection.main;

    let from, to;
    let text;
    let insertText;

    // A. 範囲選択されている場合: その部分だけを囲む
    if (!selection.empty) {
        from = selection.from;
        to = selection.to;
        text = state.sliceDoc(from, to);

        // 既に同じタグで囲まれているかチェック (解除用)
        // 例: <p align="center">text</p>
        const fullTagRegex = new RegExp(`^<p\\s+align=["']${alignment}["']>(.*)<\\/p>$`, 'i');
        const match = text.match(fullTagRegex);

        if (match) {
            // 解除 (中身だけにする)
            insertText = match[1];
        } else {
            // 左揃え(標準)以外ならタグで囲む
            if (alignment === 'left') {
                // <p>タグの除去を試みる（異なる配置のリセット）
                insertText = text.replace(/^<p\s+align=["'](?:center|right)["']>(.*)<\/p>$/i, '$1');
            } else {
                // 選択範囲をタグで囲む
                insertText = `<p align="${alignment}">${text}</p>`;
            }
        }
    }
    // B. カーソルのみの場合: 行全体を対象にする (以前のロジック)
    else {
        const line = state.doc.lineAt(from = selection.from);
        to = line.to;
        from = line.from;
        text = line.text;

        const alignRegex = /^<p\s+align=["'](?:left|center|right)["']>(.*)<\/p>$/i;
        const match = text.match(alignRegex);

        let innerText = match ? match[1] : text;

        if (alignment === 'left') {
            insertText = innerText;
        } else {
            insertText = `<p align="${alignment}">${innerText}</p>`;
        }
    }

    dispatch({
        changes: { from, to, insert: insertText },
        // 処理後は挿入部分を選択状態にする
        selection: { anchor: from, head: from + insertText.length }
    });
    view.focus();
}

// ==========ツールバー ボタン イベントリスナー ==========
document.getElementById('btn-save')?.addEventListener('click', () => saveCurrentFile(false));
document.getElementById('toolbar-undo')?.addEventListener('click', () => { if (globalEditorView) { undo(globalEditorView); globalEditorView.focus(); } });
document.getElementById('toolbar-redo')?.addEventListener('click', () => { if (globalEditorView) { redo(globalEditorView); globalEditorView.focus(); } });

document.getElementById('btn-h2')?.addEventListener('click', () => toggleLinePrefix(globalEditorView, "##"));
document.getElementById('btn-h3')?.addEventListener('click', () => toggleLinePrefix(globalEditorView, "###"));

document.querySelectorAll('.dropdown-item[data-action^="h"]').forEach(item => {
    item.addEventListener('click', (e) => {
        const level = parseInt(e.target.dataset.action.replace('h', ''));
        const hashes = "#".repeat(level);
        toggleLinePrefix(globalEditorView, hashes);
    });
});

document.getElementById('bold-btn')?.addEventListener('click', () => toggleMark(globalEditorView, "**"));
document.getElementById('italic-btn')?.addEventListener('click', () => toggleMark(globalEditorView, "*"));
document.getElementById('strike-btn')?.addEventListener('click', () => toggleMark(globalEditorView, "~~"));
document.getElementById('highlight-btn')?.addEventListener('click', () => toggleMark(globalEditorView, "=="));

document.getElementById('link-btn')?.addEventListener('click', () => insertLink(globalEditorView));
document.getElementById('image-btn')?.addEventListener('click', () => insertImage(globalEditorView));
// ローカル画像挿入ボタンの処理
document.getElementById('local-image-btn')?.addEventListener('click', async () => {
    if (!globalEditorView) return;

    try {
        const result = await window.electronAPI.selectFile();
        if (result.success && result.path) {
            const absolutePath = result.path;
            let insertPath = absolutePath;

            // 可能であれば相対パスに変換
            if (currentDirectoryPath) {
                try {
                    // Windows環境でのパス区切り文字対策も含めて相対パス化
                    const relativePath = path.relative(currentDirectoryPath, absolutePath);
                    // 画像パスとしてはスラッシュ区切りが望ましいため置換
                    insertPath = relativePath.replace(/\\/g, '/');
                } catch (e) {
                    console.warn('Relative path calculation failed:', e);
                }
            }

            const fileName = path.basename(absolutePath);
            let insertText = `![${fileName}](${insertPath})\n`;

            const { state, dispatch } = globalEditorView;
            const { from, to } = state.selection.main;

            dispatch({
                changes: { from: from, to: to, insert: insertText },
                selection: { anchor: from + insertText.length }
            });
            globalEditorView.focus();
        }
    } catch (e) {
        console.error('Local image insertion failed:', e);
        showNotification(`エラー: ${e.message}`, 'error');
    }
});
document.getElementById('btn-table')?.addEventListener('click', () => insertTable(globalEditorView));

document.getElementById('code-btn')?.addEventListener('click', () => insertCodeBlock(globalEditorView));
document.getElementById('inline-code-btn')?.addEventListener('click', () => toggleMark(globalEditorView, "`"));
document.getElementById('quote-btn')?.addEventListener('click', () => toggleLinePrefix(globalEditorView, ">"));
document.getElementById('hr-btn')?.addEventListener('click', () => insertHorizontalRule(globalEditorView));
document.getElementById('btn-page-break')?.addEventListener('click', () => insertPageBreak(globalEditorView));

if (btnBulletList) btnBulletList.addEventListener('click', () => toggleList(globalEditorView, 'ul'));
if (btnNumberList) btnNumberList.addEventListener('click', () => toggleList(globalEditorView, 'ol'));
if (btnCheckList) btnCheckList.addEventListener('click', () => toggleList(globalEditorView, 'task'));

// 配置ボタンのリスナー
document.getElementById('btn-align-left')?.addEventListener('click', () => setTextAlignment(globalEditorView, 'left'));
document.getElementById('btn-align-center')?.addEventListener('click', () => setTextAlignment(globalEditorView, 'center'));
document.getElementById('btn-align-right')?.addEventListener('click', () => setTextAlignment(globalEditorView, 'right'));

// PDFエクスポート処理を共通関数として定義
async function executePdfExport() {
    if (!globalEditorView) return;
    const markdownContent = globalEditorView.state.doc.toString();

    if (!markdownContent.trim()) {
        showNotification('エクスポートするコンテンツがありません。', 'error');
        return;
    }

    try {
        // オプション取得
        const options = appSettings.pdfOptions || {
            pageSize: 'A4', marginsType: 0, printBackground: true,
            displayHeaderFooter: false, landscape: false, enableToc: false, includeTitle: false
        };

        // タイトルの取得
        const currentTitle = document.getElementById('file-title-input')?.value || 'Untitled';

        // 共通関数でHTML生成
        const htmlContent = await convertMarkdownToHtml(markdownContent, options, currentTitle);

        if (typeof window.electronAPI?.exportPdf === 'function') {
            const result = await window.electronAPI.exportPdf(htmlContent, options);

            if (result.success) {
                showNotification(`PDFの保存が完了しました: ${result.path}`, 'success');
            } else if (!result.canceled) {
                showNotification(`PDFの保存に失敗しました: ${result.error}`, 'error');
            }
        } else {
            showNotification('PDFエクスポート機能は利用できません。', 'error');
        }
    } catch (e) {
        console.error('PDF Export Error:', e);
        showNotification('予期せぬエラーが発生しました: ' + e.message, 'error');
    }
}
// ツールバーのPDFエクスポートボタン
const btnExportPdf = document.getElementById('btn-export-pdf');
if (btnExportPdf) {
    btnExportPdf.addEventListener('click', executePdfExport);
}
// サイドバーのPDFエクスポートボタン (新規追加)
const btnSidebarExportPdf = document.getElementById('btn-sidebar-export-pdf');
if (btnSidebarExportPdf) {
    btnSidebarExportPdf.addEventListener('click', executePdfExport);
}

// 1. ボタンをクリックしたら、隠しカラーピッカーを開く
colorBtn.addEventListener('click', () => {
    colorPicker.click();
});

// 2. カラーピッカーで色が選ばれたら、エディタに反映する
colorPicker.addEventListener('input', (e) => {
    const color = e.target.value;
    applyTextColor(color);

    // ボタンのアイコン色も選んだ色に合わせて更新すると直感的です
    if (colorBtn) {
        const iconSpan = colorBtn.querySelector('span');
        // spanが存在する場合のみ色を適用（エラー回避）
        if (iconSpan) {
            iconSpan.style.borderColor = color;
        }
    }
});

// 3. 選択範囲のテキストを<span>タグで囲んで色をつける関数
function applyTextColor(color) {
    // エディタがまだ準備できていない場合は何もしない
    if (!globalEditorView) return;

    const state = globalEditorView.state;
    if (!state) return;

    const { from, to } = state.selection.main;

    // 選択範囲がない（カーソルのみ）場合は何もしない
    if (from === to) return;

    // 選択されているテキストを取得
    let text = state.sliceDoc(from, to);

    // 既に色がついている場合（<span>で囲まれている場合）は、中身を取り出してネストを防ぐ
    // これにより、パレットを動かしている間に <span><span>...</span></span> と増殖するのを防ぎます
    const spanMatch = text.match(/^<span style="color: [^"]+">([\s\S]*?)<\/span>$/);
    if (spanMatch) {
        text = spanMatch[1];
    }

    // HTMLタグ形式で色を指定
    const coloredText = `<span style="color: ${color}">${text}</span>`;

    // エディタの内容を書き換える
    globalEditorView.dispatch({
        changes: { from, to, insert: coloredText },
        // 挿入後、挿入したテキスト全体を選択状態にする
        // これにより、連続して色を変更（ドラッグ操作）した際に、同じ範囲に対して色を上書きできます
        selection: { anchor: from, head: from + coloredText.length }
    });

    // エディタにフォーカスを戻す
    globalEditorView.focus();
}

// ========== ツールバーのレスポンシブ対応 (オーバーフローメニュー) ==========
const toolbarLeft = document.getElementById('toolbar-left');
const toolbarMoreBtn = document.getElementById('btn-toolbar-more');
const toolbarOverflowMenu = document.getElementById('toolbar-overflow-menu');

let originalToolbarItems = [];

function initToolbarOverflow() {
    if (!toolbarLeft || !toolbarMoreBtn) return;

    originalToolbarItems = Array.from(toolbarLeft.children).filter(el => el !== toolbarMoreBtn);

    const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => {
            handleToolbarResize();
        });
    });
    resizeObserver.observe(toolbarLeft);

    toolbarMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toolbarOverflowMenu.classList.toggle('hidden');

        const rect = toolbarMoreBtn.getBoundingClientRect();
        const toolbarRect = toolbarLeft.parentElement.getBoundingClientRect();

        const rightOffset = toolbarRect.right - rect.right;
        toolbarOverflowMenu.style.right = rightOffset + 'px';
        toolbarOverflowMenu.style.left = 'auto';
    });

    document.addEventListener('click', (e) => {
        if (!toolbarOverflowMenu.contains(e.target) && e.target !== toolbarMoreBtn) {
            toolbarOverflowMenu.classList.add('hidden');
        }
    });
}

function handleToolbarResize() {
    if (!toolbarLeft || originalToolbarItems.length === 0) return;

    const currentChildren = Array.from(toolbarLeft.children);
    const itemsInMenu = Array.from(toolbarOverflowMenu.children);

    itemsInMenu.forEach(item => {
        toolbarLeft.insertBefore(item, toolbarMoreBtn);
    });

    originalToolbarItems.forEach(item => {
        if (item.parentElement !== toolbarLeft) {
            toolbarLeft.insertBefore(item, toolbarMoreBtn);
        }
    });

    toolbarMoreBtn.classList.add('hidden');

    const containerWidth = toolbarLeft.clientWidth;
    const moreBtnWidth = 32;

    let currentWidth = 0;
    let overflowStartIndex = -1;

    for (let i = 0; i < originalToolbarItems.length; i++) {
        const item = originalToolbarItems[i];
        const itemWidth = item.offsetWidth + 4;

        if (currentWidth + itemWidth > containerWidth - moreBtnWidth - 10) {
            overflowStartIndex = i;
            break;
        }
        currentWidth += itemWidth;
    }

    if (overflowStartIndex !== -1) {
        toolbarMoreBtn.classList.remove('hidden');

        const fragment = document.createDocumentFragment();
        for (let i = overflowStartIndex; i < originalToolbarItems.length; i++) {
            fragment.appendChild(originalToolbarItems[i]);
        }
        toolbarOverflowMenu.appendChild(fragment);
    }
}

// ========== 基本機能 ==========
let autoSaveTimer = null; // 自動保存用タイマー

// カレントディレクトリをDOMに保存してプラグインから参照可能にする
function updateCurrentDirData() {
    if (currentDirectoryPath) {
        document.body.dataset.currentDir = currentDirectoryPath;
    } else {
        delete document.body.dataset.currentDir;
    }
}

function onEditorInput(markAsDirty = true) {
    // 1. 未保存マークの更新
    if (markAsDirty && currentFilePath && currentFilePath !== 'README.md') {
        fileModificationState.set(currentFilePath, true);
        const tab = document.querySelector(`[data-filepath="${CSS.escape(currentFilePath)}"]`);
        if (tab && !tab.innerHTML.includes('●')) {
            tab.innerHTML = tab.innerHTML.replace('<span class="close-tab"', ' ● <span class="close-tab"');
        }
    }

    // 2. アウトラインとPDFプレビューの更新
    if (window.outlineUpdateTimeout) clearTimeout(window.outlineUpdateTimeout);
    window.outlineUpdateTimeout = setTimeout(() => {
        updateOutline();
        syncOutlineWithCursor();
    }, 500);

    if (isPdfPreviewVisible) {
        if (window.pdfUpdateTimeout) clearTimeout(window.pdfUpdateTimeout);
        window.pdfUpdateTimeout = setTimeout(() => {
            generatePdfPreview();
        }, 1000);
    }

    updateFileStats();

    // 3. 自動保存の実装
    const fileData = openedFiles.get(currentFilePath);
    const isVirtual = fileData && fileData.isVirtual;

    if (appSettings.autoSave && currentFilePath && currentFilePath !== 'README.md' && !isVirtual) { // 仮想ファイルでない場合のみ実行
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        // 2秒間入力がなければ保存
        autoSaveTimer = setTimeout(() => {
            saveCurrentFile(false);
            console.log('Auto-saved:', currentFilePath);
        }, 2000);
    } else if (autoSaveTimer) {
        // 仮想ファイルに切り替わった場合や設定がOFFの場合にタイマーをクリア
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }
}

function updateFileStats() {
    if (!fileStatsElement || !globalEditorView) return;
    const text = globalEditorView.state.doc.toString();
    const charCount = text.length;
    const lineCount = globalEditorView.state.doc.lines;
    fileStatsElement.textContent = `文字数: ${charCount} | 行数: ${lineCount}`;
}

// ========== Terminal Logic (Integrated) ==========

async function initializeTerminal() {
    if (terminals.size > 0) return;

    console.log('Initializing Integrated Terminal...');
    try {
        terminalConfig = await window.electronAPI.getTerminalConfig();
        availableShells = await window.electronAPI.getAvailableShells();
    } catch (e) {
        console.error("Failed to load terminal config/shells:", e);
    }

    renderShellDropdown();

    if (newTerminalBtn) {
        const newBtn = newTerminalBtn.cloneNode(true);
        newTerminalBtn.parentNode.replaceChild(newBtn, newTerminalBtn);
        newBtn.addEventListener('click', () => createTerminalSession());
    }
    if (dropdownToggle) {
        const newToggle = dropdownToggle.cloneNode(true);
        dropdownToggle.parentNode.replaceChild(newToggle, dropdownToggle);

        newToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const rect = newToggle.getBoundingClientRect();
            if (shellDropdown) {
                shellDropdown.style.top = `${rect.bottom + 2}px`;
                shellDropdown.style.bottom = 'auto';

                const rightGap = window.innerWidth - rect.right;
                shellDropdown.style.right = `${Math.max(0, rightGap)}px`;
                shellDropdown.style.left = 'auto';

                shellDropdown.classList.toggle('hidden');
            }
        });
    }
    document.addEventListener('click', () => {
        if (shellDropdown) shellDropdown.classList.add('hidden');
    });

    window.electronAPI.onTerminalData(({ terminalId, data }) => {
        const term = terminals.get(terminalId);
        if (term) term.xterm.write(data);
    });

    window.electronAPI.onTerminalExit(({ terminalId }) => {
        closeTerminalSession(terminalId);
    });

    window.electronAPI.onRestoreState(async (state) => {
        if (state.terminals && state.terminals.length > 0) {
            for (const t of state.terminals) {
                await createTerminalSession(t.shellProfile);
            }
        }
    });

    if (isTerminalVisible && terminals.size === 0) {
        setTimeout(() => {
            if (terminals.size === 0) createTerminalSession();
        }, 300);
    }

    setupTerminalResizeObserver();
}

function setupTerminalResizeObserver() {
    const observer = new ResizeObserver(() => {
        if (activeTerminalId && isTerminalVisible) {
            requestAnimationFrame(() => {
                fitTerminal(activeTerminalId);
            });
        }
    });

    if (terminalContainer) observer.observe(terminalContainer);
    if (terminalBottomContainer) observer.observe(terminalBottomContainer);
}

function renderShellDropdown() {
    if (!shellDropdown) return;
    shellDropdown.innerHTML = '';
    if (availableShells.length === 0) {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.textContent = 'No shells detected';
        shellDropdown.appendChild(item);
        return;
    }
    availableShells.forEach(shell => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.textContent = shell.displayName;
        item.addEventListener('click', () => {
            createTerminalSession(shell.name);
        });
        shellDropdown.appendChild(item);
    });
}

function fitTerminal(terminalId) {
    if (document.body.classList.contains('is-layout-changing')) return;

    const term = terminals.get(terminalId);
    if (!term || !term.xterm || !term.fitAddon) return;

    if (term.element.offsetParent === null || term.element.clientWidth === 0 || term.element.clientHeight === 0) return;

    try {
        term.fitAddon.fit();
        const newCols = term.xterm.cols;
        const newRows = term.xterm.rows;

        if (newCols <= 0 || newRows <= 0) return;
        if (term.lastCols === newCols && term.lastRows === newRows) return;

        if (term.resizeTimeout) clearTimeout(term.resizeTimeout);

        term.resizeTimeout = setTimeout(() => {
            window.electronAPI.resizeTerminal(terminalId, newCols, newRows);
            term.lastCols = newCols;
            term.lastRows = newRows;

            term.xterm.refresh(0, newRows - 1);
        }, 50);

    } catch (e) {
        console.warn(`Fit terminal ${terminalId} failed:`, e);
    }
}

async function createTerminalSession(profileName = null) {
    try {
        const { terminalId, shellName } = await window.electronAPI.createTerminal({ profileName });

        const container = isPositionRight ? terminalContainer : terminalBottomContainer;
        if (!container) return;

        const xterm = new Terminal({
            cursorBlink: terminalConfig?.cursorBlink ?? true,
            fontSize: terminalConfig?.fontSize || 14,
            fontFamily: terminalConfig?.fontFamily || 'Consolas, "Courier New", monospace',
            theme: terminalConfig?.theme || { background: '#1e1e1e' },
            allowTransparency: true,
            windowsMode: navigator.platform.indexOf('Win') > -1
        });

        const fitAddon = new FitAddon.FitAddon();
        xterm.loadAddon(fitAddon);

        if (typeof WebLinksAddon !== 'undefined') {
            xterm.loadAddon(new WebLinksAddon.WebLinksAddon());
        }

        const el = document.createElement('div');
        el.className = 'terminal-instance';
        el.id = `term-${terminalId}`;
        el.style.visibility = 'hidden';
        el.style.opacity = '0';
        container.appendChild(el);

        xterm.open(el);

        xterm.onData(data => window.electronAPI.writeToTerminal(terminalId, data));

        terminals.set(terminalId, {
            xterm,
            fitAddon,
            element: el,
            lastCols: 0,
            lastRows: 0,
            resizeTimeout: null
        });

        const tab = document.createElement('div');
        tab.className = 'terminal-tab';
        tab.dataset.id = terminalId;
        tab.innerHTML = `<span class="terminal-tab-title">${shellName}</span><button class="terminal-tab-close">×</button>`;

        tab.addEventListener('click', () => switchTerminal(terminalId));
        tab.querySelector('.terminal-tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            closeTerminalSession(terminalId);
        });

        if (terminalTabsList) {
            terminalTabsList.appendChild(tab);
        }

        setTimeout(() => {
            switchTerminal(terminalId);
        }, 100);

    } catch (e) {
        console.error('Failed to create terminal', e);
    }
}

function switchTerminal(terminalId) {
    activeTerminalId = terminalId;

    if (terminalTabsList) {
        Array.from(terminalTabsList.children).forEach(tab => {
            tab.classList.toggle('active', tab.dataset.id == terminalId);
        });
    }

    terminals.forEach((term, id) => {
        const isActive = id === terminalId;

        if (isActive) {
            term.element.style.visibility = 'visible';
            term.element.style.opacity = '1';
            term.element.style.zIndex = '10';

            const targetContainer = isPositionRight ? terminalContainer : terminalBottomContainer;
            if (term.element.parentElement !== targetContainer) {
                targetContainer.appendChild(term.element);
            }

            setTimeout(() => {
                fitTerminal(id);
                term.xterm.focus();
            }, 5);
        } else {
            term.element.style.visibility = 'hidden';
            term.element.style.opacity = '0';
            term.element.style.zIndex = '0';
        }
    });
}

async function closeTerminalSession(terminalId) {
    const term = terminals.get(terminalId);
    if (!term) return;

    if (term.resizeTimeout) clearTimeout(term.resizeTimeout);
    if (term.xterm) term.xterm.dispose();
    if (term.element) term.element.remove();
    terminals.delete(terminalId);

    if (terminalTabsList) {
        const tab = terminalTabsList.querySelector(`.terminal-tab[data-id="${terminalId}"]`);
        if (tab) tab.remove();
    }

    await window.electronAPI.closeTerminal(terminalId);

    if (activeTerminalId === terminalId) {
        activeTerminalId = null;
        if (terminals.size > 0) {
            switchTerminal(terminals.keys().next().value);
        }
    }
}

// ========== ターミナル・右ペイン表示状態更新 ==========
function updateTerminalVisibility() {
    const mainContent = centerPane.parentElement;
    const rightActivityBarWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--activitybar-width')) || 50;

    const terminalHeader = document.getElementById('terminal-header');
    const pdfPreviewHeader = document.getElementById('pdf-preview-header');
    const pdfPreviewContainer = document.getElementById('pdf-preview-container');
    const showCalendar = window.calendarAPI ? window.calendarAPI.getVisible() : false;

    if (rightActivityBar) {
        rightActivityBar.classList.toggle('hidden', !isRightActivityBarVisible);
    }

    const showPdf = isPdfPreviewVisible;
    const showTerminalRight = isTerminalVisible && isPositionRight;
    const needRightPane = (showPdf || showTerminalRight || showCalendar) && isRightActivityBarVisible;

    const barWidth = isRightActivityBarVisible ? rightActivityBarWidth : 0;
    document.documentElement.style.setProperty('--right-activity-offset,', barWidth + 'px');

    // レイアウト変更中のフラグは一時的に立てるが、CSSトランジション削除に伴い即座に解除してOK
    document.body.classList.add('is-layout-changing');

    if (needRightPane) {
        rightPane.classList.remove('hidden');
        if (resizerRight) resizerRight.classList.remove('hidden');

        // 排他制御に応じたヘッダー/コンテンツの表示・非表示
        // まず全て隠す
        if (terminalHeader) terminalHeader.classList.add('hidden');
        if (terminalContainer) terminalContainer.classList.add('hidden');
        if (pdfPreviewHeader) pdfPreviewHeader.classList.add('hidden');
        if (pdfPreviewContainer) pdfPreviewContainer.classList.add('hidden');
        // カレンダーはAPI側でDOM操作しているので、ここでは干渉しないか、APIの状態に任せる
        // ただし、もし calendarAPI がDOMクラス操作だけで完結していない場合はここでも制御が必要だが、
        // 今回は calendarAPI.updateView() が呼ばれている前提で、他要素を隠すだけで良い。

        if (showCalendar) {
            // カレンダーが表示中の場合、他は既に隠されている
        } else if (showPdf) {
            if (pdfPreviewHeader) pdfPreviewHeader.classList.remove('hidden');
            if (pdfPreviewContainer) pdfPreviewContainer.classList.remove('hidden');
        } else if (showTerminalRight) {
            if (terminalHeader) terminalHeader.classList.remove('hidden');
            if (terminalContainer) terminalContainer.classList.remove('hidden');
        }

        const rightPaneWidth = rightPane.style.width || '350px';
        document.documentElement.style.setProperty('--right-pane-width', rightPaneWidth);

        mainContent.style.marginRight = (parseFloat(rightPaneWidth) + barWidth) + 'px';

    } else {
        rightPane.classList.add('hidden');
        if (resizerRight) resizerRight.classList.add('hidden');

        document.documentElement.style.setProperty('--right-pane-width', '0px');

        mainContent.style.marginRight = barWidth + 'px';
    }

    if (isTerminalVisible && !isPositionRight) {
        bottomPane.classList.remove('hidden');
        if (resizerBottom) resizerBottom.classList.remove('hidden');

        // ステータスバーの高さ (0px or 24px)
        const statusBarHeight = appSettings.showStatusBar ? 24 : 0;

        if (!bottomPane.style.height || bottomPane.style.height === '0px') {
            bottomPane.style.height = '200px';
            // resizerBottom の top を直接計算（status-bar-height CSS変数は bottom-pane の bottom に使用される）
            const newResizerTop = window.innerHeight - 200 - statusBarHeight;
            if (resizerBottom) resizerBottom.style.top = `${newResizerTop}px`;
        }

        const currentHeight = bottomPane.style.height || '200px';
        const heightVal = parseInt(currentHeight);

        centerPane.style.marginBottom = heightVal + 'px';

    } else {
        bottomPane.classList.add('hidden');
        if (resizerBottom) resizerBottom.classList.add('hidden');

        centerPane.style.marginBottom = '0px';
    }

    const tabsContainer = document.getElementById('terminal-tabs-container');
    const shellDropdown = document.getElementById('shell-dropdown');
    const rightHeader = document.getElementById('terminal-header');
    const bottomHeader = document.getElementById('bottom-terminal-header');
    const rightPaneEl = document.getElementById('right-pane');
    const bottomPaneEl = document.getElementById('bottom-pane');

    if (tabsContainer && rightHeader && bottomHeader) {
        if (isTerminalVisible && !isPositionRight) {
            if (!bottomHeader.contains(tabsContainer)) {
                bottomHeader.innerHTML = '';
                bottomHeader.appendChild(tabsContainer);
            }
            if (shellDropdown && bottomPaneEl && !bottomPaneEl.contains(shellDropdown)) {
                bottomPaneEl.appendChild(shellDropdown);
            }
        } else {
            if (!rightHeader.contains(tabsContainer)) {
                bottomHeader.innerHTML = 'ターミナル';
                rightHeader.appendChild(tabsContainer);
            }
            if (shellDropdown && rightPaneEl && !rightPaneEl.contains(shellDropdown)) {
                rightPaneEl.appendChild(shellDropdown);
            }
        }
    }

    if (btnTerminalRight) btnTerminalRight.classList.toggle('active', isTerminalVisible);
    if (btnPdfPreview) btnPdfPreview.classList.toggle('active', isPdfPreviewVisible);
    if (btnCalendar) btnCalendar.classList.toggle('active', showCalendar);

    // CSSのトランジションを削除したため、即座に完了処理を行う
    document.body.classList.remove('is-layout-changing');

    // レイアウト変更後にターミナルをリサイズする（少し待つ必要はほぼないが念のためRAF）
    requestAnimationFrame(() => {
        if (isTerminalVisible && activeTerminalId) {
            fitTerminal(activeTerminalId);
            const t = terminals.get(activeTerminalId);
            if (t) t.xterm.focus();
        }
    });

    if (isTerminalVisible) {
        if (terminals.size === 0) {
            initializeTerminal();
        } else if (activeTerminalId) {
            const targetContainer = isPositionRight ? terminalContainer : terminalBottomContainer;
            const term = terminals.get(activeTerminalId);
            if (term && term.element.parentElement !== targetContainer) {
                targetContainer.appendChild(term.element);
            }
        }
    }
}

// ========== ヘッダーボタン切り替え ==========
function switchHeaderButtons(targetId) {
    const headerButtonsFiles = document.getElementById('header-buttons-files');
    const headerButtonsGit = document.getElementById('header-buttons-git');
    const headerButtonsOutline = document.getElementById('header-buttons-outline');
    const headerButtonsRecent = document.getElementById('header-buttons-recent');
    const headerSearchContainer = document.getElementById('header-search-container');

    if (headerButtonsFiles) headerButtonsFiles.classList.add('content-hidden');
    if (headerButtonsGit) headerButtonsGit.classList.add('content-hidden');
    if (headerButtonsOutline) headerButtonsOutline.classList.add('content-hidden');
    if (headerButtonsRecent) headerButtonsRecent.classList.add('content-hidden');
    if (headerSearchContainer) headerSearchContainer.classList.add('content-hidden');

    if (targetId === 'files' && headerButtonsFiles) {
        headerButtonsFiles.classList.remove('content-hidden');
    } else if (targetId === 'git' && headerButtonsGit) {
        headerButtonsGit.classList.remove('content-hidden');
    } else if (targetId === 'outline' && headerButtonsOutline) {
        headerButtonsOutline.classList.remove('content-hidden');
    } else if (targetId === 'recent' && headerButtonsRecent) {
        headerButtonsRecent.classList.remove('content-hidden');
    } else if (targetId === 'search' && headerSearchContainer) {
        // 検索タブの時は検索ヘッダーを表示
        headerSearchContainer.classList.remove('content-hidden');
        // 入力欄にフォーカスを当てる
        const input = document.getElementById('project-search-input');
        if (input) setTimeout(() => input.focus(), 50);
    }
}

// ========== イベントリスナー設定 ==========

if (btnTerminalRight) {
    btnTerminalRight.addEventListener('click', () => {
        if (isTerminalVisible) {
            isTerminalVisible = false;
        } else {
            isTerminalVisible = true;
            isPdfPreviewVisible = false;
            if (window.calendarAPI) window.calendarAPI.hide();
        }
        updateTerminalVisibility();
    });
}

if (btnTogglePosition) {
    btnTogglePosition.addEventListener('click', () => {
        isPositionRight = !isPositionRight;
        requestAnimationFrame(() => {
            updateTerminalVisibility();
        });
    });
}

if (btnToggleLeftPane) {
    btnToggleLeftPane.addEventListener('click', () => {
        const willHide = !leftPane.classList.contains('hidden');

        document.body.classList.add('is-layout-changing');

        leftPane.classList.toggle('hidden', willHide);
        ideContainer.classList.toggle('left-pane-hidden', willHide);

        updateLeftPaneWidthVariable();

        leftPane.addEventListener('transitionend', () => {
            document.body.classList.remove('is-layout-changing');

            if (isTerminalVisible && !isPositionRight && activeTerminalId) {
                fitTerminal(activeTerminalId);
            }
        }, { once: true });

        setTimeout(() => {
            document.body.classList.remove('is-layout-changing');
        }, 300);
    });
}

topSideSwitchButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
        const targetId = btn.dataset.target;
        if (!targetId) return;

        leftPane.classList.remove('hidden');
        ideContainer.classList.remove('left-pane-hidden');
        updateLeftPaneWidthVariable();

        topSideSwitchButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        leftPaneContents.forEach(content => content.classList.add('content-hidden'));

        const fileContentContainer = document.getElementById('content-files');
        if (fileContentContainer) {
            if (targetId === 'files') {
                fileContentContainer.classList.remove('content-hidden');
            } else {
                fileContentContainer.classList.add('content-hidden');
            }
        }

        const targetContent = document.getElementById('content-' + targetId);
        if (targetContent) {
            targetContent.classList.remove('content-hidden');
            if (targetId === 'outline') {
                updateOutline();
                syncOutlineWithCursor();
            }
            // Gitタブ切り替え時の処理
            if (targetId === 'git') {
                refreshGitStatus();
            }
            // Recentタブ切り替え時の処理
            if (targetId === 'recent') {
                await loadRecentFiles(); // メインプロセスから最新の状態（削除済みを除外）を再取得
                renderRecentFiles();
            }
        }

        switchHeaderButtons(targetId);
    });
});

if (btnZen) {
    btnZen.addEventListener('click', () => {
        const enteringZenMode = !ideContainer.classList.contains('zen-mode-active');

        if (enteringZenMode) {
            savedRightActivityBarState = isRightActivityBarVisible;
            isTerminalVisible = false;
            isPdfPreviewVisible = false;
            isRightActivityBarVisible = false;
            updateTerminalVisibility();
        }

        ideContainer.classList.toggle('zen-mode-active');
    });
}

if (btnPdfPreview) { // togglePdfPreview関数を直接呼んでいる既存コードを修正
    btnPdfPreview.addEventListener('click', () => {
        if (isPdfPreviewVisible) {
            isPdfPreviewVisible = false;
        } else {
            // 排他制御: PDFプレビューを開くときは他を閉じる
            isPdfPreviewVisible = true;
            isTerminalVisible = false;
            if (window.calendarAPI) window.calendarAPI.hide();
            generatePdfPreview(); // PDF生成
        }
        updateTerminalVisibility();
    });
}

if (btnCalendar) {
    btnCalendar.addEventListener('click', () => {
        // calendarAPIが存在するか確認
        if (!window.calendarAPI) return;

        const isCalendarVisible = window.calendarAPI.getVisible();

        if (isCalendarVisible) {
            window.calendarAPI.hide();
        } else {
            // 排他制御: カレンダーを開くときは他を閉じる
            window.calendarAPI.show();
            isTerminalVisible = false;
            isPdfPreviewVisible = false;
        }
        updateTerminalVisibility();
    });
}

async function generatePdfPreview() {
    try {
        if (!globalEditorView) return;
        const markdownContent = globalEditorView.state.doc.toString();

        if (!markdownContent.trim()) {
            const canvas = document.getElementById('pdf-canvas');
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            return;
        }

        // オプション取得
        const options = appSettings.pdfOptions || {
            pageSize: 'A4', marginsType: 0, printBackground: true,
            displayHeaderFooter: false, landscape: false, enableToc: false, includeTitle: false
        };

        // カスタムCSSを取得してオプションに追加
        if (typeof getActiveCssContent === 'function') {
            options.customCss = getActiveCssContent();
        } else {
            console.warn('getActiveCssContent function not found');
        }

        // タイトルの取得 (入力欄の値を使用)
        const currentTitle = document.getElementById('file-title-input')?.value || 'Untitled';

        // 共通関数でHTML生成（目次処理含む）
        const htmlContent = await convertMarkdownToHtml(markdownContent, options, currentTitle);

        if (typeof window.electronAPI?.generatePdf === 'function') {
            await renderHtmlToPdf(htmlContent, options);
        } else {
            console.warn('PDF generation API not available, using fallback');
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = htmlContent;
            await createCanvasBasedPreview(tempDiv);
        }
    } catch (error) {
        console.error('Failed to generate PDF preview:', error);
    }
}

async function processMarkdownForExport(markdown) {
    let processed = markdown;

    // 1. LaTeX Block ($$...$$) のレンダリング
    // KaTeXを使ってHTML文字列に変換します
    processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (match, tex) => {
        try {
            if (window.katex) {
                return window.katex.renderToString(tex, {
                    displayMode: true,
                    throwOnError: false
                });
            }
            return match;
        } catch (e) {
            console.error(e);
            return match;
        }
    });

    // 2. LaTeX Inline ($...$) のレンダリング
    processed = processed.replace(/(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)/g, (match, tex) => {
        try {
            if (window.katex) {
                return window.katex.renderToString(tex, {
                    displayMode: false,
                    throwOnError: false
                });
            }
            return match;
        } catch (e) {
            return match;
        }
    });

    // 3. ハイライト (==text==)
    processed = processed.replace(/==([^=]+)==/g, '<mark>$1</mark>');

    // 4. リストのネスト用インデント調整
    processed = processed.replace(/^(\s+)(\d+(?:-\d+)+\.)/gm, (match, indent, marker) => {
        return '&nbsp;'.repeat(indent.length) + marker;
    });

    // 5. ブックマーク (@card URL) のHTML化
    const bookmarkRegex = /^@card\s+(https?:\/\/[^\s]+)$/gm;
    const matches = [...processed.matchAll(bookmarkRegex)];

    if (matches.length > 0) {
        const replacements = await Promise.all(matches.map(async (match) => {
            const url = match[1];
            let data = null;

            if (!window.pdfMetadataCache) window.pdfMetadataCache = new Map();

            if (window.pdfMetadataCache.has(url)) {
                data = window.pdfMetadataCache.get(url);
            } else {
                try {
                    const result = await window.electronAPI.fetchUrlMetadata(url);
                    if (result.success) {
                        data = result.data;
                        window.pdfMetadataCache.set(url, data);
                    }
                } catch (e) {
                    console.error(e);
                }
            }

            if (!data) {
                return {
                    original: match[0],
                    replacement: `<div class="cm-bookmark-widget"><div class="cm-bookmark-content"><div class="cm-bookmark-title"><a href="${url}">${url}</a></div></div></div>`
                };
            }

            const faviconUrl = `https://www.google.com/s2/favicons?domain=${data.domain}&sz=32`;
            const html = `<div class="cm-bookmark-widget">
                <div class="cm-bookmark-content">
                    <div class="cm-bookmark-title">${data.title}</div>
                    <div class="cm-bookmark-desc">${data.description}</div>
                    <div class="cm-bookmark-meta">
                        <img src="${faviconUrl}" class="cm-bookmark-favicon">
                        <span class="cm-bookmark-domain">${data.domain}</span>
                    </div>
                </div>
                ${data.image ? `<div class="cm-bookmark-cover"><img src="${data.image}" class="cm-bookmark-image"></div>` : ''}
            </div>`;

            return { original: match[0], replacement: html };
        }));

        for (const item of replacements) {
            processed = processed.replaceAll(item.original, item.replacement);
        }
    }

    return processed;
}

async function renderHtmlToPdf(htmlContent, options = {}) {
    try {
        const pdfData = await window.electronAPI.generatePdf(htmlContent, options);
        if (pdfData) {
            await displayPdfFromData(pdfData);
        }
    } catch (error) {
        console.error('Error rendering HTML to PDF:', error);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlContent;
        await createCanvasBasedPreview(tempDiv);
    }
}

async function createCanvasBasedPreview(htmlElement) {
    const canvas = document.getElementById('pdf-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    canvas.width = 794;
    canvas.height = 1123;

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'black';
    ctx.font = '14px Arial';

    const text = htmlElement.textContent;
    const lines = text.split('\n');
    const lineHeight = 20;
    const maxLines = Math.floor((canvas.height - 80) / lineHeight);
    const currentPageLines = lines.slice(0, maxLines);

    let y = 50;
    currentPageLines.forEach(line => {
        const words = line.split(' ');
        let currentLine = '';
        const maxWidth = canvas.width - 100;

        words.forEach(word => {
            const testLine = currentLine + word + ' ';
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && currentLine !== '') {
                ctx.fillText(currentLine, 50, y);
                currentLine = word + ' ';
                y += lineHeight;
            } else {
                currentLine = testLine;
            }
        });
        ctx.fillText(currentLine, 50, y);
        y += lineHeight;
    });
}

async function displayPdfFromData(pdfData) {
    try {

        const pdfDataArray = Uint8Array.from(atob(pdfData), c => c.charCodeAt(0));
        const loadingTask = pdfjsLib.getDocument({ data: pdfDataArray });
        pdfDocument = await loadingTask.promise;

        const pageInfo = document.getElementById('pdf-page-info');
        if (pageInfo) {
            pageInfo.textContent = `全 ${pdfDocument.numPages} ページ`;
        }

        const container = document.getElementById('pdf-preview-container');
        if (!container) return;
        container.innerHTML = '';

        for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
            await renderPageToContainer(pageNum, container);
        }

    } catch (error) {
        console.error('Error displaying PDF:', error);
    }
}

async function renderPageToContainer(pageNumber, container) {
    try {
        const page = await pdfDocument.getPage(pageNumber);
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        container.appendChild(canvas);

        const context = canvas.getContext('2d');
        const viewport = page.getViewport({ scale: 1.5 });

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const renderContext = {
            canvasContext: context,
            viewport: viewport
        };

        await page.render(renderContext).promise;

    } catch (error) {
        console.error(`Error rendering page ${pageNumber}:`, error);
    }
}

// ========== Recent Files Logic ==========

async function loadRecentFiles() {
    try {
        if (window.electronAPI && window.electronAPI.loadRecentFiles) {
            recentFiles = await window.electronAPI.loadRecentFiles();
        }
    } catch (e) {
        console.error("Failed to load recent files", e);
    }
}

async function saveRecentFiles() {
    try {
        if (window.electronAPI && window.electronAPI.saveRecentFiles) {
            await window.electronAPI.saveRecentFiles(recentFiles);
        }
    } catch (e) {
        console.error("Failed to save recent files", e);
    }
}

async function addToRecentFiles(filePath) {
    if (!filePath || filePath === 'README.md') return;

    const now = Date.now();
    // 既存のエントリがあれば削除
    recentFiles = recentFiles.filter(item => item.path !== filePath);

    // 先頭に追加
    recentFiles.unshift({
        path: filePath,
        lastOpened: now
    });

    // 最大50件に制限
    if (recentFiles.length > 50) {
        recentFiles = recentFiles.slice(0, 50);
    }

    await saveRecentFiles();

    // Recentパネルが表示中なら更新
    if (document.getElementById('content-recent') && !document.getElementById('content-recent').classList.contains('content-hidden')) {
        renderRecentFiles();
    }
}

function formatRecentTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'たった今';
    if (diffMins < 60) return `${diffMins}分前`;
    if (diffHours < 24) return `${diffHours}時間前`;
    if (diffDays < 7) return `${diffDays}日前`;

    return `${date.getFullYear()}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
}

function renderRecentFiles() {
    if (!recentFilesList) return;
    recentFilesList.innerHTML = '';

    // 現在のディレクトリ配下のファイルのみにフィルタリング
    const filteredFiles = recentFiles.filter(item => {
        if (!currentDirectoryPath) return true;
        try {
            // 現在のディレクトリからの相対パスを取得
            const rel = path.relative(currentDirectoryPath, item.path);
            // '..' で始まらず、かつ絶対パスでない（別のドライブ等でない）場合はフォルダ内とみなす
            return !rel.startsWith('..') && !path.isAbsolute(rel);
        } catch (e) {
            return false;
        }
    });

    if (filteredFiles.length === 0) {
        recentFilesList.innerHTML = '<li style="padding: 10px; color: #888; font-size: 12px;">このフォルダの履歴はありません</li>';
        return;
    }

    filteredFiles.forEach(item => {
        const separator = item.path.includes('\\') ? '\\' : '/';
        const fileName = item.path.split(separator).pop();

        // フォルダ内での相対パスを表示用に計算
        let displayPath = path.relative(currentDirectoryPath, item.path);
        const dirPart = path.dirname(displayPath);

        // 直下の場合は "./" 等はつけず、サブフォルダがある場合のみ表示
        let displayDir = dirPart === '.' ? '' : dirPart + '/';

        const li = document.createElement('li');
        li.className = 'recent-file-item';
        li.title = item.path; // ホバーでフルパス表示
        li.innerHTML = `
            <div class="recent-file-name">${fileName}</div>
            <div class="recent-file-info">
                <span class="recent-file-path">${displayDir}</span>
                <span class="recent-file-time">${formatRecentTime(item.lastOpened)}</span>
            </div>
        `;

        li.addEventListener('click', () => {
            openFile(item.path, fileName);
        });

        recentFilesList.appendChild(li);
    });
}

function updateRecentFilesAfterRename(oldPath, newPath) {
    let changed = false;
    recentFiles = recentFiles.map(file => {
        if (file.path === oldPath) {
            changed = true;
            return { ...file, path: newPath };
        }
        return file;
    });
    if (changed) {
        saveRecentFiles();
        if (document.getElementById('content-recent') && !document.getElementById('content-recent').classList.contains('content-hidden')) {
            renderRecentFiles();
        }
    }
}

if (btnRecentClear) {
    btnRecentClear.addEventListener('click', () => {
        showClearHistoryModal();
    });
}

// ========== 履歴削除用のカスタムモーダル ==========
function showClearHistoryModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';
    // ボタンが増えるため少し幅を広げる
    content.style.width = '450px';

    const message = document.createElement('div');
    message.className = 'modal-message';
    message.textContent = '履歴を削除しますか？\n(実際のファイルは削除されません)';
    message.style.whiteSpace = 'pre-wrap';
    message.style.marginBottom = '20px';

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';
    // ボタンのレイアウト調整（必要に応じて折り返し）
    buttons.style.flexWrap = 'wrap';

    // キャンセルボタン
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.onclick = () => overlay.remove();

    // 全削除ボタン
    const clearAllBtn = document.createElement('button');
    clearAllBtn.className = 'modal-btn';
    // 注意を引くため赤色系のスタイルを適用
    clearAllBtn.style.backgroundColor = '#d9534f';
    clearAllBtn.style.color = 'white';
    clearAllBtn.style.borderColor = '#d43f3a';
    clearAllBtn.textContent = 'すべての履歴を削除';

    clearAllBtn.onclick = async () => {
        recentFiles = [];
        await saveRecentFiles();
        renderRecentFiles();
        showNotification('すべての履歴を消去しました', 'success');
        overlay.remove();
    };

    // ボタンの追加順序（キャンセルを左、アクションを右へ）
    buttons.appendChild(cancelBtn);
    buttons.appendChild(clearAllBtn);

    // フォルダを開いている場合のみ「フォルダ以下削除」ボタンを追加
    if (currentDirectoryPath) {
        const clearDirBtn = document.createElement('button');
        clearDirBtn.className = 'modal-btn primary'; // 青色（Primary）
        clearDirBtn.textContent = '現在のフォルダ以下のみ削除';

        clearDirBtn.onclick = async () => {
            // フィルタリング処理
            recentFiles = recentFiles.filter(item => {
                try {
                    const rel = path.relative(currentDirectoryPath, item.path);
                    // 親ディレクトリ以上(..)または別ドライブ(絶対パス)なら残す
                    return rel.startsWith('..') || path.isAbsolute(rel);
                } catch (e) {
                    return true;
                }
            });
            await saveRecentFiles();
            renderRecentFiles();
            showNotification('現在のフォルダ以下の履歴を消去しました', 'success');
            overlay.remove();
        };

        // 一番右（推奨アクション）として追加
        buttons.appendChild(clearDirBtn);
    }

    content.appendChild(message);
    content.appendChild(buttons);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    // 背景クリックで閉じる
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        if (ideContainer.classList.contains('zen-mode-active')) {
            ideContainer.classList.remove('zen-mode-active');
            isRightActivityBarVisible = savedRightActivityBarState;
            updateTerminalVisibility();
        }
    }
});

if (btnSettings) {
    btnSettings.addEventListener('click', () => {
        openSettingsTab();
    });
}

if (btnToggleRightActivity) {
    btnToggleRightActivity.addEventListener('click', () => {
        isRightActivityBarVisible = !isRightActivityBarVisible;
        updateTerminalVisibility();
    });
}

if (btnMinimize) {
    btnMinimize.addEventListener('click', () => {
        window.electronAPI.minimizeWindow();
    });
}

if (btnMaximize) {
    btnMaximize.addEventListener('click', () => {
        window.electronAPI.maximizeWindow();
        isMaximized = !isMaximized;

        const iconMax = btnMaximize.querySelector('.icon-maximize');
        const iconRestore = btnMaximize.querySelector('.icon-restore');

        if (isMaximized) {
            if (iconMax) iconMax.classList.add('hidden');
            if (iconRestore) iconRestore.classList.remove('hidden');
            btnMaximize.title = "元に戻す";
        } else {
            if (iconMax) iconMax.classList.remove('hidden');
            if (iconRestore) iconRestore.classList.add('hidden');
            btnMaximize.title = "最大化";
        }
    });
}

if (btnClose) {
    btnClose.addEventListener('click', () => {
        window.electronAPI.closeWindow();
    });
}

const btnSortAsc = document.getElementById('btn-sort-asc');
const btnSortDesc = document.getElementById('btn-sort-desc');

if (btnSortAsc) {
    btnSortAsc.addEventListener('click', () => {
        currentSortOrder = 'asc';
        initializeFileTree();
    });
}

if (btnSortDesc) {
    btnSortDesc.addEventListener('click', () => {
        currentSortOrder = 'desc';
        initializeFileTree();
    });
}

// ========== Git 機能の実装 (履歴機能統合済み) ==========

/**
 * Gitステータスを更新して表示する
 * (履歴更新処理も呼び出す)
 */
async function refreshGitStatus() {
    if (!currentDirectoryPath) return;

    if (btnGitRefresh) btnGitRefresh.classList.add('syncing');

    try {
        const result = await window.electronAPI.gitStatus(currentDirectoryPath);

        // ステータスバーも同時に更新
        updateStatusBarGitInfo();

        if (result.success) {
            // リポジトリ有効時: UIを表示
            setGitViewMode(true);

            // リポジトリであることが確定してからリモートUIをセットアップ
            await setupGitRemoteUI();

            // 成功したらリストを表示
            renderGitList(gitUnstagedList, result.unstaged, 'unstaged');
            renderGitList(gitStagedList, result.staged, 'staged');

            // ステージングが1件もない場合はセクションごと非表示にする
            const stagedSection = document.getElementById('section-staged');
            if (stagedSection) {
                if (result.staged && result.staged.length > 0) {
                    stagedSection.style.display = 'block';
                } else {
                    stagedSection.style.display = 'none';
                }
            }

            // コミットエリアを有効化
            if (gitMessageInput) gitMessageInput.disabled = false;
            if (btnGitCommit) btnGitCommit.disabled = false;

            // 履歴を更新
            refreshGitHistory();

        } else {
            console.warn('Git status error:', result.error);

            // リポジトリではない場合、初期化UIを表示
            if (result.error.includes('not a git repository') || result.error.includes('Could not find HEAD') || result.error.includes('no such file or directory')) {
                // リポジトリ無効時: 不要なUIを隠す (ボタン類もここで非表示になる)
                setGitViewMode(false);

                renderGitInitUI(gitUnstagedList);
                gitStagedList.innerHTML = '';
                if (gitHistoryList) gitHistoryList.innerHTML = ''; // 履歴クリア

                // コミットエリアを無効化
                if (gitMessageInput) gitMessageInput.disabled = true;
                if (btnGitCommit) btnGitCommit.disabled = true;
            } else {
                // その他のエラー時はUIを表示したままメッセージを出す
                setGitViewMode(true);
                // エラー時でも操作できるようリモートUI等は出しておく
                await setupGitRemoteUI();

                gitUnstagedList.innerHTML = `<div class="git-empty-msg">エラー: ${result.error}</div>`;
                gitStagedList.innerHTML = '';
            }
        }
    } catch (e) {
        console.error('Failed to refresh git status:', e);
    } finally {
        if (btnGitRefresh) btnGitRefresh.classList.remove('syncing');
    }
}

/**
 * リポジトリの有無に応じてGitパネルの表示要素を切り替えるヘルパー関数
 * @param {boolean} isRepository 
 */
function setGitViewMode(isRepository) {
    const commitArea = document.querySelector('.git-commit-area');
    const historyContainer = document.querySelector('.git-history-container');

    // Stagedセクション
    const stagedList = document.getElementById('git-staged');
    const stagedSection = stagedList ? stagedList.closest('.git-section') : null;

    // Unstagedセクションのタイトル
    const unstagedList = document.getElementById('git-unstaged');
    const unstagedSection = unstagedList ? unstagedList.closest('.git-section') : null;
    const unstagedTitle = unstagedSection ? unstagedSection.querySelector('.git-section-title') : null;

    // ヘッダーのGit操作ボタン群 (7つのボタン)
    const headerButtons = document.getElementById('header-buttons-git');

    // リモート設定ボタン
    const remoteBtn = document.getElementById('btn-git-remote-settings');
    // リモートボタンの親コンテナ（タイトル横に配置したdiv）も一緒に隠すとなお良いですが、
    // ここではボタン自体を制御します（親コンテナが見つかればそれも）
    const remoteBtnContainer = remoteBtn ? remoteBtn.parentElement : null;

    const displayVal = isRepository ? '' : 'none';

    if (commitArea) commitArea.style.display = displayVal;
    if (historyContainer) historyContainer.style.display = displayVal;
    if (stagedSection) stagedSection.style.display = displayVal;
    if (unstagedTitle) unstagedTitle.style.display = displayVal;

    // ヘッダーボタンの表示制御
    // isRepositoryがtrueのときは '' (CSSのdefault/flexに戻る)、falseなら 'none'
    if (headerButtons) {
        // 元のスタイルが display: flex なので、空文字を入れるとCSSクラスの指定に戻ります
        // ただし style="display: flex..." とHTMLに直書きしている場合は上書きに注意が必要ですが、
        // display='none' と display='' (removeProperty) で制御するのが安全です。
        if (isRepository) {
            headerButtons.style.display = 'flex'; // 明示的にflexに戻す
        } else {
            headerButtons.style.display = 'none';
        }
    }

    // リモート設定ボタンの表示制御
    if (remoteBtn) {
        // 親コンテナ（タイトル横のflexコンテナ）があればそれを、なければボタン単体を隠す
        if (remoteBtnContainer && remoteBtnContainer.classList.contains('git-remote-container-wrapper')) {
            // コンテナにクラスを付けて特定できるならそこを隠すが、
            // 今回は動的生成時の構造に依存するためボタン単体を隠すか、親を隠す
            remoteBtnContainer.style.display = isRepository ? 'flex' : 'none';
        } else {
            remoteBtn.style.display = displayVal;
        }
    }
}

/**
 * 初期化ボタンを表示する関数
 */
function renderGitInitUI(container) {
    container.innerHTML = `
        <div class="git-init-container">
            <p>このフォルダはGitリポジトリではありません。</p>
            <button id="btn-git-init-action" class="git-init-btn">リポジトリを初期化 (Init)</button>
        </div>
    `;

    const btn = document.getElementById('btn-git-init-action');
    if (btn) {
        btn.addEventListener('click', async () => {
            try {
                const result = await window.electronAPI.gitInit(currentDirectoryPath);
                if (result.success) {
                    showNotification('Gitリポジトリを初期化しました', 'success');
                    refreshGitStatus();
                } else {
                    showNotification(`初期化エラー: ${result.error}`, 'error');
                }
            } catch (e) {
                showNotification(`エラー: ${e.message}`, 'error');
            }
        });
    }
}

/**
 * Gitファイルリストを描画するヘルパー関数
 */
function renderGitList(container, files, type) {
    container.innerHTML = '';

    if (!files || files.length === 0) {
        // container.innerHTML = '<div class="git-empty-msg">変更なし</div>';
        return;
    }

    files.forEach(file => {
        const item = document.createElement('div');
        item.className = 'git-file-item';
        item.dataset.path = file.filepath;

        // ステータスアイコンの決定
        let statusChar = 'M';
        let statusClass = 'modified';

        if (file.status === 'new' || file.status === 'added') {
            statusChar = 'A';
            statusClass = 'added';
        } else if (file.status === 'deleted') {
            statusChar = 'D';
            statusClass = 'deleted';
        } else if (file.status === 'modified') {
            statusChar = 'M';
            statusClass = 'modified';
        }

        // パス操作 (簡易版)
        const fileName = file.filepath.split(/[/\\]/).pop();
        const dirName = file.filepath.substring(0, file.filepath.length - fileName.length);
        const displayPath = dirName === '' ? '' : dirName;

        const actionBtnIcon = type === 'unstaged' ? '+' : '−';
        const actionTitle = type === 'unstaged' ? 'ステージする' : 'ステージを取り消す';

        item.innerHTML = `
            <div class="git-file-left">
                <span class="git-file-name">${fileName} <span class="git-file-dir">${displayPath}</span></span>
            </div>
            <div class="git-file-right">
                <span class="git-status-badge ${statusClass}">${statusChar}</span>
                <div class="git-actions">
                    <button class="git-action-btn-small" title="${actionTitle}">${actionBtnIcon}</button>
                </div>
            </div>
        `;

        // ファイルクリックで開く
        item.addEventListener('click', (e) => {
            if (e.target.closest('.git-action-btn-small')) return;

            // Unstaged（変更）の場合はDiffビューを開く
            if (type === 'unstaged' && file.status === 'modified') {
                openDiffView(file.filepath);
            } else {
                // 新規ファイル(new)や削除(deleted)、Stagedの場合は通常通り開く（または何もしない）
                const separator = currentDirectoryPath.includes('\\') ? '\\' : '/';
                const fullPath = currentDirectoryPath + (currentDirectoryPath.endsWith(separator) ? '' : separator) + file.filepath;

                // 削除されたファイルでなければ開く
                if (file.status !== 'deleted') {
                    openFile(fullPath, fileName);
                }
            }
        });

        // アクションボタンクリック
        const actionBtn = item.querySelector('.git-action-btn-small');
        actionBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                if (type === 'unstaged') {
                    if (file.status === 'deleted') {
                        await window.electronAPI.gitRemove(currentDirectoryPath, file.filepath);
                    } else {
                        await window.electronAPI.gitAdd(currentDirectoryPath, file.filepath);
                    }
                } else {
                    await window.electronAPI.gitReset(currentDirectoryPath, file.filepath);
                }
                refreshGitStatus();
            } catch (err) {
                console.error(err);
                showNotification(`Git操作エラー: ${err.message}`, 'error');
            }
        });

        container.appendChild(item);
    });
}

/**
 * Git履歴を描画する
 */
async function refreshGitHistory() {
    if (!gitHistoryList) return;
    try {
        // window.electronAPI.gitHistoryが存在するか確認（古いpreload.jsの場合のエラー回避）
        if (typeof window.electronAPI.gitHistory !== 'function') {
            console.warn("gitHistory function is not available in preload script.");
            return;
        }

        const result = await window.electronAPI.gitHistory(currentDirectoryPath, 20); // 最新20件
        if (result.success) {
            if (gitCurrentBranchBadge) {
                gitCurrentBranchBadge.textContent = result.currentBranch;
            }
            renderGitGraph(result.history, result.currentBranch);
        } else {
            // エラー時（まだコミットがない場合など）は静かに
            console.log("Git history status:", result.error);
        }
    } catch (e) {
        console.error("Git history failed:", e);
    }
}

/**
 * コミットグラフとリストの描画
 */
function renderGitGraph(commits, currentBranch) {
    gitHistoryList.innerHTML = '';

    if (commits.length === 0) {
        gitHistoryList.innerHTML = '<div class="git-empty-msg">No commits yet</div>';
        return;
    }

    commits.forEach((commit, index) => {
        const row = document.createElement('div');
        row.className = 'git-history-row';
        row.dataset.oid = commit.oid;

        // タイムラインの線とドット
        const timeline = document.createElement('div');
        timeline.className = 'git-timeline';
        const line = document.createElement('div');
        line.className = 'git-timeline-line';
        if (index === commits.length - 1) line.classList.add('last');

        const dot = document.createElement('div');
        dot.className = 'git-timeline-dot';

        timeline.appendChild(line);
        timeline.appendChild(dot);

        // コンテンツ
        const content = document.createElement('div');
        content.className = 'git-history-content';

        // メッセージとRefs
        const header = document.createElement('div');
        header.className = 'git-history-header';

        // Refs (ブランチバッジ)
        if (commit.refs && commit.refs.length > 0) {
            const refsContainer = document.createElement('span');
            refsContainer.className = 'git-refs';
            commit.refs.forEach(ref => {
                const badge = document.createElement('span');
                badge.className = 'git-ref-badge';
                // リモートかローカルかで色分け
                if (ref.name.startsWith('origin/') || ref.name.startsWith('remotes/')) {
                    badge.classList.add('remote');
                    badge.textContent = `☁ ${ref.name.replace('remotes/', '')}`;
                } else {
                    badge.textContent = ref.name;
                    // 現在のブランチの場合、クラスを追加して強調する
                    if (ref.name === currentBranch) {
                        badge.classList.add('current-branch');
                    }
                    if (ref.name === 'main' || ref.name === 'master') badge.classList.add('main');
                }
                refsContainer.appendChild(badge);
            });
            header.appendChild(refsContainer);
        }

        const msgSpan = document.createElement('span');
        msgSpan.className = 'git-history-message';
        msgSpan.textContent = commit.message.split('\n')[0]; // 1行目のみ
        header.appendChild(msgSpan);

        // Author & Date
        const meta = document.createElement('div');
        meta.className = 'git-history-meta';
        const authorName = commit.author.name;
        // 日時のフォーマット
        const date = new Date(commit.author.timestamp * 1000);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        meta.textContent = `${authorName}, ${dateStr}`;

        content.appendChild(header);
        content.appendChild(meta);

        row.appendChild(timeline);
        row.appendChild(content);

        // イベントリスナー: ツールチップ表示
        row.addEventListener('mouseenter', (e) => showCommitTooltip(e, commit));
        row.addEventListener('mouseleave', () => hideCommitTooltip());

        // 右クリックでコンテキストメニュー表示
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            // ツールチップを隠す
            hideCommitTooltip();
            showCommitContextMenu(e.pageX, e.pageY, commit);
        });

        gitHistoryList.appendChild(row);
    });
}

// ツールチップの状態管理
let tooltipTimeout;

async function showCommitTooltip(e, commit) {
    if (!gitCommitTooltip) return;

    // 表示位置の計算（行の右側、または下）
    const rect = e.currentTarget.getBoundingClientRect();
    gitCommitTooltip.style.top = `${rect.top}px`;
    gitCommitTooltip.style.left = `${rect.right + 10}px`; // 右側に表示
    gitCommitTooltip.classList.remove('hidden');

    // 基本情報のセット
    document.getElementById('tooltip-author').textContent = commit.author.name;
    const date = new Date(commit.author.timestamp * 1000);
    document.getElementById('tooltip-date').textContent = date.toLocaleString();
    document.getElementById('tooltip-hash').textContent = commit.oid.substring(0, 8);

    // ブランチ情報のセット
    const branchEl = document.getElementById('tooltip-branch');
    if (commit.refs && commit.refs.length > 0) {
        branchEl.textContent = commit.refs.map(r => r.name).join(', ');
        branchEl.style.display = 'block';
    } else {
        branchEl.style.display = 'none';
    }

    // 統計情報のローディング表示
    const statsEl = document.getElementById('tooltip-stats');
    statsEl.textContent = 'Loading stats...';

    // 詳細情報の非同期取得
    clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(async () => {
        try {
            if (typeof window.electronAPI.gitGetCommitDetail === 'function') {
                const result = await window.electronAPI.gitGetCommitDetail(currentDirectoryPath, commit.oid);
                if (result.success) {
                    const stats = result.stats;
                    statsEl.innerHTML = `
                        <span style="color:var(--text-color)">${stats.filesChanged} files changed</span>
                    `;
                } else {
                    statsEl.textContent = 'No stats available';
                }
            } else {
                statsEl.textContent = '';
            }
        } catch (e) {
            statsEl.textContent = 'Error loading stats';
        }
    }, 200); // 少し遅延させて、素早いマウス移動時の負荷を減らす
}

function hideCommitTooltip() {
    if (gitCommitTooltip) {
        gitCommitTooltip.classList.add('hidden');
        clearTimeout(tooltipTimeout);
    }
}

// ========== ステータスバーのGit表示更新 ==========
async function updateStatusBarGitInfo() {
    if (!statusBarBranch) return;

    // ディレクトリが開かれていない場合は非表示
    if (!currentDirectoryPath) {
        statusBarBranch.classList.add('hidden');
        return;
    }

    try {
        // ブランチ情報を取得（.gitがあるかどうかの確認も兼ねる）
        const result = await window.electronAPI.gitGetBranches(currentDirectoryPath);

        if (result.success && result.current) {
            // 成功したら表示：アイコン + ブランチ名
            statusBarBranch.textContent = `🌿 ${result.current}`;
            statusBarBranch.classList.remove('hidden');
        } else {
            // Gitリポジトリでない、またはエラーの場合は非表示
            statusBarBranch.classList.add('hidden');
        }
    } catch (e) {
        // エラー時は非表示
        statusBarBranch.classList.add('hidden');
    }
}

// ========== コンパクトな入力ダイアログ ==========
function showCompactInputModal(message, placeholder, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.width = 'auto';
    content.style.minWidth = '320px';
    content.style.maxWidth = '400px';
    content.style.padding = '15px 20px';
    content.style.textAlign = 'center';

    const msgDiv = document.createElement('div');
    msgDiv.className = 'modal-message';
    msgDiv.textContent = message;
    msgDiv.style.marginBottom = '15px';
    msgDiv.style.fontSize = '13px';
    msgDiv.style.fontWeight = 'bold';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'search-input'; // 既存のスタイルを流用
    input.style.width = '100%';
    input.style.marginBottom = '20px';
    input.style.padding = '6px';
    input.style.boxSizing = 'border-box';
    input.placeholder = placeholder || '';

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';
    buttons.style.justifyContent = 'center';
    buttons.style.gap = '15px';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.style.minWidth = '80px';
    cancelBtn.onclick = () => overlay.remove();

    const okBtn = document.createElement('button');
    okBtn.className = 'modal-btn primary';
    okBtn.textContent = '作成';
    okBtn.style.minWidth = '80px';

    const submit = () => {
        const val = input.value.trim();
        if (val) {
            overlay.remove();
            onConfirm(val);
        }
    };

    okBtn.onclick = submit;

    // Enterキーで送信
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') overlay.remove();
    });

    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);

    content.appendChild(msgDiv);
    content.appendChild(input);
    content.appendChild(buttons);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    input.focus();

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

// ========== コンパクトな確認ダイアログ (confirm代替) ==========
function showCompactConfirmModal(message, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';

    // スタイルを上書きしてコンパクトにする
    content.style.width = 'auto';
    content.style.minWidth = '320px';
    content.style.maxWidth = '500px';
    content.style.padding = '15px 20px';
    content.style.textAlign = 'center';

    const msgDiv = document.createElement('div');
    msgDiv.className = 'modal-message';
    msgDiv.textContent = message;
    // 1行に収めるためのスタイル
    msgDiv.style.marginBottom = '20px';
    msgDiv.style.whiteSpace = 'nowrap';
    msgDiv.style.overflow = 'hidden';
    msgDiv.style.textOverflow = 'ellipsis';
    msgDiv.style.fontSize = '13px';

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';
    buttons.style.justifyContent = 'center';
    buttons.style.gap = '15px';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.style.minWidth = '80px';
    cancelBtn.onclick = () => overlay.remove();

    const okBtn = document.createElement('button');
    okBtn.className = 'modal-btn primary';
    okBtn.textContent = 'OK';
    okBtn.style.minWidth = '80px';
    okBtn.onclick = () => {
        overlay.remove();
        onConfirm();
    };

    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);

    content.appendChild(msgDiv);
    content.appendChild(buttons);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    // エンターキー等ですぐ押せるようにフォーカス
    okBtn.focus();

    // 背景クリックで閉じる
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

// Git操作ボタン イベントリスナー
// 既存の btnGitRefresh リスナーを修正 (Fetchも実行するようにする)
if (btnGitRefresh) {
    btnGitRefresh.addEventListener('click', async () => {
        if (!currentDirectoryPath) return;

        btnGitRefresh.classList.add('syncing');

        // Fetchを実行（リモートの最新情報を取得）
        try {
            console.log('Fetching...');
            await window.electronAPI.gitFetch(currentDirectoryPath);
        } catch (e) {
            console.warn('Fetch failed:', e);
        }

        // その後、ステータスと履歴を更新
        await refreshGitStatus();

        btnGitRefresh.classList.remove('syncing');
    });
}

// Pullボタンのリスナー
const btnGitPull = document.getElementById('git-pull-btn');
if (btnGitPull) {
    btnGitPull.addEventListener('click', async () => {
        if (!currentDirectoryPath) return;

        try {
            btnGitPull.disabled = true;
            btnGitPull.textContent = 'Pulling...';

            const result = await window.electronAPI.gitPull(currentDirectoryPath);

            if (result.success) {
                showNotification('プル完了', 'success');
                refreshGitStatus(); // 画面更新
            } else {
                showNotification(`プルエラー: ${result.error}`, 'error');
            }
        } catch (e) {
            showNotification(`エラー: ${e.message}`, 'error');
        } finally {
            btnGitPull.disabled = false;
            btnGitPull.textContent = 'Pull';
        }
    });
}

const btnGitPullNoFF = document.getElementById('git-pull-no-ff-btn');
if (btnGitPullNoFF) {
    btnGitPullNoFF.addEventListener('click', async () => {
        if (!currentDirectoryPath) return;

        try {
            btnGitPullNoFF.disabled = true;
            btnGitPullNoFF.classList.add('syncing'); // 回転アニメーションなどがあれば

            showNotification('Pull (--no-ff) を実行中...', 'info');

            // main.js で定義したハンドラーを呼び出し
            const result = await window.electronAPI.gitPullNoFF(currentDirectoryPath);

            if (result.success) {
                showNotification('Pull (--no-ff) 完了', 'success');
                refreshGitStatus(); // Git表示更新
            } else {
                showNotification(`Pullエラー: ${result.error}`, 'error');
                refreshGitStatus(); // エラー時もステータス更新（コンフリクト検知のため）
            }

            // ★重要: コンフリクトマーカーなどを表示するためにファイルを強制リロード
            if (currentFilePath && !openedFiles.get(currentFilePath)?.isVirtual) {
                await reloadFileFromDisk(currentFilePath);
            }

        } catch (e) {
            showNotification(`エラー: ${e.message}`, 'error');
        } finally {
            btnGitPullNoFF.disabled = false;
            btnGitPullNoFF.classList.remove('syncing');
        }
    });
}

if (btnGitStage) {
    btnGitStage.addEventListener('click', async () => {
        if (!currentDirectoryPath) return;
        try {

            // 先にステータスを確認し、ステージすべき変更がない場合は終了する
            const status = await window.electronAPI.gitStatus(currentDirectoryPath);
            if (!status.success || status.unstaged.length === 0) {
                return; // 何もしない
            }

            // 変更がある場合のみステージングを実行
            const result = await window.electronAPI.gitStageAll(currentDirectoryPath);

            // 成功したかどうかチェック
            if (result.success) {
                refreshGitStatus();
                showNotification('すべての変更をステージしました', 'success');
            }
            // else {
            //     // エラーなら例外を投げて catch ブロックへ
            //     throw new Error(result.error);
            // }
        } catch (e) {
            showNotification(`ステージエラー: ${e.message}`, 'error');
        }
    });
}

if (btnGitUnstage) {
    btnGitUnstage.addEventListener('click', async () => {
        if (!currentDirectoryPath) return;
        try {
            const result = await window.electronAPI.gitStatus(currentDirectoryPath);
            if (result.success && result.staged.length > 0) {
                for (const file of result.staged) {
                    await window.electronAPI.gitReset(currentDirectoryPath, file.filepath);
                }
                refreshGitStatus();
                showNotification('すべての変更をアンステージしました', 'success');
            }
        } catch (e) {
            showNotification(`アンステージエラー: ${e.message}`, 'error');
        }
    });
}

if (btnGitCommit) {
    btnGitCommit.addEventListener('click', async () => {
        const message = gitMessageInput.value;
        if (!message.trim()) {
            showNotification('コミットメッセージを入力してください', 'error');
            return;
        }

        const status = await window.electronAPI.gitStatus(currentDirectoryPath);
        if (!status.success || status.staged.length === 0) {
            showNotification('ステージされているファイルがありません', 'error');
            return;
        }

        try {
            btnGitCommit.disabled = true;
            btnGitCommit.textContent = 'Committing...';

            const result = await window.electronAPI.gitCommit(currentDirectoryPath, message);

            if (result.success) {
                gitMessageInput.value = '';
                refreshGitStatus();
                showNotification(`コミット完了: ${result.sha.substring(0, 7)}`, 'success');
            } else {
                showNotification(`コミットエラー: ${result.error}`, 'error');
            }
        } catch (e) {
            showNotification(`エラー: ${e.message}`, 'error');
        } finally {
            btnGitCommit.disabled = false;
            btnGitCommit.textContent = 'Commit';
        }
    });
}

if (btnGitPush) {
    btnGitPush.addEventListener('click', async () => {
        if (!currentDirectoryPath) return;

        try {
            btnGitPush.disabled = true;
            btnGitPush.textContent = 'Pushing...';

            const result = await window.electronAPI.gitPush(currentDirectoryPath);

            if (result.success) {
                showNotification('プッシュ完了', 'success');
            } else {
                showNotification(`プッシュエラー: ${result.error}`, 'error');
            }
        } catch (e) {
            showNotification(`エラー: ${e.message}`, 'error');
        } finally {
            btnGitPush.disabled = false;
            btnGitPush.textContent = 'Push';
        }
    });
}

// ========== GitHub認証ボタンの実装 ==========
// const btnGithubAuth = document.getElementById('btn-github-auth');
// const authStatus = document.getElementById('github-auth-status');

// if (btnGithubAuth) {
//     btnGithubAuth.addEventListener('click', async () => {
//         btnGithubAuth.disabled = true;
//         btnGithubAuth.textContent = '認証中...';

//         try {
//             const result = await window.electronAPI.authGitHub();

//             if (result.success) {
//                 showNotification('GitHub連携に成功しました', 'success');
//                 btnGithubAuth.style.display = 'none'; // ボタンを隠す
//                 if (authStatus) authStatus.style.display = 'block'; // 完了メッセージ表示
//             } else {
//                 showNotification(`認証失敗: ${result.error}`, 'error');
//                 btnGithubAuth.innerHTML = '<svg height="16" viewBox="0 0 16 16" width="16" fill="white"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg> GitHubでサインイン';
//             }
//         } catch (e) {
//             showNotification(`エラー: ${e.message}`, 'error');
//             btnGithubAuth.disabled = false;
//         } finally {
//             if (btnGithubAuth.style.display !== 'none') {
//                 btnGithubAuth.disabled = false;
//             }
//         }
//     });
// }

/**
 * Gitパネルにリモート設定ボタンを表示・更新する関数
 */
async function setupGitRemoteUI() {
    // ボタンを追加する場所（Gitパネルのタイトル横など）
    const gitContent = document.getElementById('content-git');
    if (!gitContent || !currentDirectoryPath) return;

    // 既存のボタンがあれば取得、なければ作成
    let remoteBtn = document.getElementById('btn-git-remote-settings');

    if (!remoteBtn) {
        // ボタンを作成して配置（"Git: 変更" というタイトルの横あたりに追加）
        const titleEl = gitContent.querySelector('strong'); // "Git: 変更" の要素
        if (titleEl) {
            const container = document.createElement('div');
            container.style.display = 'flex';
            container.style.justifyContent = 'space-between';
            container.style.alignItems = 'center';
            container.style.marginBottom = '10px';

            // タイトルをコンテナに移動
            titleEl.parentNode.insertBefore(container, titleEl);
            container.appendChild(titleEl);

            // リモート設定ボタン作成
            remoteBtn = document.createElement('button');
            remoteBtn.id = 'btn-git-remote-settings';
            remoteBtn.className = 'git-action-btn-small'; // 既存のスタイルを流用
            remoteBtn.style.fontSize = '12px';
            remoteBtn.style.padding = '2px 8px';
            remoteBtn.style.marginLeft = 'auto'; // 右寄せ

            container.appendChild(remoteBtn);

            // クリックイベント
            remoteBtn.addEventListener('click', handleRemoteSettingsClick);
        }
    }

    // 現在のURL状態を確認してボタンの表示を変える
    try {
        const result = await window.electronAPI.gitGetRemoteUrl(currentDirectoryPath);
        if (result.success && result.url) {
            remoteBtn.textContent = '⚙ Remote設定 (変更)';
            remoteBtn.title = `現在のリモート: ${result.url}`;
            remoteBtn.dataset.currentUrl = result.url;
            remoteBtn.dataset.hasRemote = 'true';
        } else {
            remoteBtn.textContent = '➕ Remote追加';
            remoteBtn.title = 'リモートリポジトリ(origin)が未設定です';
            remoteBtn.dataset.currentUrl = '';
            remoteBtn.dataset.hasRemote = 'false';
        }
    } catch (e) {
        console.error('Remote check failed:', e);
    }
}

/**
 * リモート設定ボタンクリック時の処理
 */
function handleRemoteSettingsClick(e) {
    const btn = e.target;
    const hasRemote = btn.dataset.hasRemote === 'true';
    const currentUrl = btn.dataset.currentUrl || '';

    const title = hasRemote ? 'リモートURLを変更' : 'リモートURLを登録';
    const placeholder = 'https://github.com/username/repo.git';

    // 既存のモーダル機能を利用して入力させる
    showCompactInputModal(`${title}\n(GitHubなどのリポジトリURLを入力)`, currentUrl || placeholder, async (inputUrl) => {
        if (!inputUrl) return;

        const url = inputUrl.trim();
        let result;

        try {
            if (hasRemote) {
                // 変更 (set-url)
                result = await window.electronAPI.gitSetRemoteUrl(currentDirectoryPath, url);
                if (result.success) {
                    showNotification('リモートURLを変更しました', 'success');
                }
            } else {
                // 新規登録 (add)
                result = await window.electronAPI.gitAddRemote(currentDirectoryPath, url);
                if (result.success) {
                    showNotification('リモートURLを登録しました', 'success');
                }
            }

            if (!result.success) {
                showNotification(`エラー: ${result.error}`, 'error');
            } else {
                // 表示を更新
                setupGitRemoteUI();
            }
        } catch (err) {
            showNotification(`エラー: ${err.message}`, 'error');
        }
    });
}

/**
 * Git操作用の拡張ボタン群にイベントリスナーを設定する関数
 */
function setupGitExtraButtons() {
    // ボタン要素の取得
    const btnIgnore = document.getElementById('btn-git-ignore-apply');
    const btnHistory = document.getElementById('btn-git-delete-history');
    const btnAmend = document.getElementById('btn-git-amend');
    const btnForce = document.getElementById('btn-git-force-push');

    // リスナー設定用ヘルパー: すでに設定済みならスキップするためのフラグ管理などは
    // DOM要素が静的なので、DOMContentLoaded時に一度だけ呼ばれる前提でシンプルに記述します

    // --- 1. .gitignore再適用ボタン ---
    if (btnIgnore) {
        // 重複登録防止のため、クローンして置換（簡易的なリスナーリセット）
        const newBtn = btnIgnore.cloneNode(true);
        btnIgnore.parentNode.replaceChild(newBtn, btnIgnore);

        newBtn.addEventListener('click', async () => {
            showCompactConfirmModal('.gitignoreを再適用しますか？\n(キャッシュを削除して再コミットします)', async () => {
                await executeGitAction(newBtn, () => window.electronAPI.gitApplyGitignore(currentDirectoryPath), '.gitignoreを適用しました');
            });
        });
    }

    // --- 2. 履歴全削除ボタン ---
    if (btnHistory) {
        const newBtn = btnHistory.cloneNode(true);
        btnHistory.parentNode.replaceChild(newBtn, btnHistory);

        newBtn.addEventListener('click', async () => {
            showCompactConfirmModal('【危険】履歴を全削除しますか？\n現在のファイル状態を「最初のコミット」として履歴をリセットします。', async () => {
                await executeGitAction(newBtn, () => window.electronAPI.gitDeleteHistory(currentDirectoryPath), '履歴をリセットしました');
            });
        });
    }

    // --- 3. Amendボタン ---
    if (btnAmend) {
        const newBtn = btnAmend.cloneNode(true);
        btnAmend.parentNode.replaceChild(newBtn, btnAmend);

        newBtn.addEventListener('click', async () => {
            // ▼ 事前チェック: ステージングがあるか確認
            try {
                const status = await window.electronAPI.gitStatus(currentDirectoryPath);
                if (!status.success || !status.staged || status.staged.length === 0) {
                    showNotification('上書きする変更（ステージ済みファイル）がありません', 'error');
                    return;
                }
            } catch (e) {
                console.error(e);
                return;
            }

            showCompactConfirmModal('直前のコミットを上書きしますか？\n(現在のステージング内容が含まれます)', async () => {
                await executeGitAction(newBtn, () => window.electronAPI.gitCommitAmend(currentDirectoryPath), 'コミットを上書きしました');
            });
        });
    }

    // --- 4. Force Pushボタン ---
    if (btnForce) {
        const newBtn = btnForce.cloneNode(true);
        btnForce.parentNode.replaceChild(newBtn, btnForce);

        newBtn.addEventListener('click', async () => {
            // ▼ 事前チェック: リモートがあるか確認
            try {
                const remote = await window.electronAPI.gitGetRemoteUrl(currentDirectoryPath);
                if (!remote.success || !remote.url) {
                    showNotification('リモートリポジトリ(origin)が設定されていません', 'error');
                    return;
                }
            } catch (e) {
                console.error(e);
                return;
            }

            showCompactConfirmModal('強制プッシュしますか？\n(リモートの履歴が上書きされます)', async () => {
                await executeGitAction(newBtn, () => window.electronAPI.gitPushForce(currentDirectoryPath), '強制プッシュ完了');
            });
        });
    }
}

// ヘルパー: ボタン作成
function createHeaderBtn(icon, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'header-btn';
    btn.innerHTML = icon;
    btn.title = title;
    btn.addEventListener('click', () => onClick(btn));
    return btn;
}

// ヘルパー: Gitアクション実行ラッパー
async function executeGitAction(btn, apiCall, successMsg) {
    if (!currentDirectoryPath) return;
    try {
        btn.classList.add('syncing'); // 回転などのアニメーションがあれば
        btn.disabled = true;

        const result = await apiCall();

        if (result.success) {
            showNotification(successMsg, 'success');
            refreshGitStatus(); // 画面更新
        } else {
            showNotification(`エラー: ${result.error}`, 'error');
        }
    } catch (e) {
        showNotification(`予期せぬエラー: ${e.message}`, 'error');
    } finally {
        btn.classList.remove('syncing');
        btn.disabled = false;
    }
}

const outlineTree = document.getElementById('outline-tree');
const btnOutlineCollapse = document.getElementById('btn-outline-collapse');
const btnOutlineExpand = document.getElementById('btn-outline-expand');

function updateOutline() {
    if (!outlineTree || !globalEditorView) return;

    const content = globalEditorView.state.doc.toString();
    const headers = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
        const match = line.match(/^(#{1,6})\s+(.*)/);
        if (match) {
            headers.push({
                level: match[1].length,
                text: match[2],
                lineNumber: index
            });
        }
    });

    if (headers.length === 0) {
        outlineTree.innerHTML = '<li style="color: #999; padding: 5px;">見出しがありません</li>';
        return;
    }

    let html = '';
    headers.forEach((header, i) => {
        const paddingLeft = (header.level - 1) * 15 + 5;
        const fontSize = Math.max(14 - (header.level - 1), 11);

        html += `<li class="outline-item" data-line="${header.lineNumber}" data-level="${header.level}" style="padding-left: ${paddingLeft}px; font-size: ${fontSize}px;">
            <span class="outline-text">${header.text}</span>
        </li>`;
    });

    outlineTree.innerHTML = html;

    const items = outlineTree.querySelectorAll('.outline-item');
    items.forEach(item => {
        item.addEventListener('click', () => {
            const lineNum = parseInt(item.dataset.line);
            scrollToLine(lineNum);
            items.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
        });
    });
}

function syncOutlineWithCursor() {
    if (!globalEditorView || !outlineTree) return;

    const outlineContent = document.getElementById('content-outline');
    if (!outlineContent || outlineContent.classList.contains('content-hidden')) return;

    const cursorPos = globalEditorView.state.selection.main.head;
    const currentLine = globalEditorView.state.doc.lineAt(cursorPos).number - 1;

    const items = Array.from(outlineTree.querySelectorAll('.outline-item'));
    let activeItem = null;

    for (let i = 0; i < items.length; i++) {
        const itemLine = parseInt(items[i].dataset.line);
        if (itemLine > currentLine) {
            break;
        }
        activeItem = items[i];
    }

    items.forEach(i => i.classList.remove('active'));
    if (activeItem) {
        activeItem.classList.add('active');
    }
}

function scrollToLine(lineNumber) {
    if (!globalEditorView) return;
    const line = globalEditorView.state.doc.line(lineNumber + 1);

    globalEditorView.dispatch({
        selection: { anchor: line.from },
        scrollIntoView: true
    });
    globalEditorView.focus();
}

if (btnOutlineCollapse) {
    btnOutlineCollapse.addEventListener('click', () => {
        const items = outlineTree.querySelectorAll('.outline-item');
        items.forEach(item => {
            const level = parseInt(item.dataset.level);
            if (level > 1) {
                item.classList.add('hidden-outline-item');
            } else {
                item.classList.remove('hidden-outline-item');
            }
        });
    });
}

if (btnOutlineExpand) {
    btnOutlineExpand.addEventListener('click', () => {
        const items = outlineTree.querySelectorAll('.outline-item');
        items.forEach(item => {
            item.classList.remove('hidden-outline-item');
        });
    });
}

const resizerRight = document.getElementById('resizer-right');
const resizerBottom = document.getElementById('resizer-bottom');
const resizerLeft = document.getElementById('resizer-left');
let isResizingRight = false;
let isResizingBottom = false;
let isResizingLeft = false;

if (resizerRight) {
    resizerRight.addEventListener('mousedown', () => {
        isResizingRight = true;
        resizerRight.classList.add('resizing');
        document.body.classList.add('is-resizing-col');
    });
}

if (resizerLeft) {
    resizerLeft.addEventListener('mousedown', () => {
        isResizingLeft = true;
        resizerLeft.classList.add('resizing');
        document.body.classList.add('is-resizing-col');
    });
}

if (resizerBottom) {
    resizerBottom.addEventListener('mousedown', () => {
        isResizingBottom = true;
        resizerBottom.classList.add('resizing');
        document.body.classList.add('is-resizing-row');
    });
}

document.addEventListener('mousemove', (e) => {

    if (isResizingLeft && resizerLeft) {
        const activityBarWidth = 50; // CSS変数の値と合わせる
        // マウス位置からアクティビティバーの幅を引いてサイドバーの幅を算出
        let newWidth = e.clientX - activityBarWidth;

        // 最小幅・最大幅の制限 (例: 150px ~ 600px)
        if (newWidth < 160) newWidth = 160;
        if (newWidth > 600) newWidth = 600;

        const widthStr = newWidth + 'px';

        // CSS変数を更新して幅を変更
        document.documentElement.style.setProperty('--leftpane-width', widthStr);
        // トップバーの左側コントロール幅も同期させる
        document.documentElement.style.setProperty('--current-left-pane-width', widthStr);
    }

    if (isResizingRight && resizerRight) {
        const rightActivityBarWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--activitybar-width')) || 50;
        const newWidth = window.innerWidth - e.clientX - rightActivityBarWidth;

        if (newWidth > 100 && newWidth < 800) {
            rightPane.style.width = newWidth + 'px';
            resizerRight.style.right = (newWidth + rightActivityBarWidth) + 'px';
            document.documentElement.style.setProperty('--right-pane-width', newWidth + 'px');
            const mainContent = centerPane.parentElement;
            mainContent.style.marginRight = (newWidth + rightActivityBarWidth) + 'px';

            if (activeTerminalId) {
                requestAnimationFrame(() => fitTerminal(activeTerminalId));
            }
        }
    }

    if (isResizingBottom && resizerBottom) {
        const newHeight = window.innerHeight - e.clientY - 24;

        if (newHeight > 50 && newHeight < window.innerHeight - 200) {
            bottomPane.style.height = newHeight + 'px';
            resizerBottom.style.top = (window.innerHeight - newHeight - 24) + 'px';

            centerPane.style.marginBottom = newHeight + 'px';

            if (activeTerminalId) {
                requestAnimationFrame(() => fitTerminal(activeTerminalId));
            }
        }
    }
});

document.addEventListener('mouseup', () => {
    if (isResizingLeft) {
        isResizingLeft = false;
        if (resizerLeft) resizerLeft.classList.remove('resizing');
        document.body.classList.remove('is-resizing-col');
    }
    if (isResizingRight) {
        isResizingRight = false;
        if (resizerRight) resizerRight.classList.remove('resizing');
        document.body.classList.remove('is-resizing-col');
        if (activeTerminalId) setTimeout(() => fitTerminal(activeTerminalId), 50);
    }
    if (isResizingBottom) {
        isResizingBottom = false;
        if (resizerBottom) resizerBottom.classList.remove('resizing');
        document.body.classList.remove('is-resizing-row');
        if (activeTerminalId) setTimeout(() => fitTerminal(activeTerminalId), 50);
    }
});

if (fileTitleInput) {
    fileTitleInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            fileTitleInput.blur();
        }
    });

    fileTitleInput.addEventListener('blur', async () => {
        const newName = fileTitleInput.value.trim();

        if (!newName || !currentFilePath) return;

        const separator = currentFilePath.includes('\\') ? '\\' : '/';
        const currentFileName = currentFilePath.split(separator).pop();
        const currentExt = currentFileName.includes('.') ? '.' + currentFileName.split('.').pop() : '';
        const currentNameWithoutExt = currentFileName.replace(currentExt, '');

        if (newName === currentNameWithoutExt) return;

        try {
            if (typeof window.electronAPI?.renameFile === 'function') {
                const oldPath = currentFilePath; // 現在のパスを保存
                const result = await window.electronAPI.renameFile(currentFilePath, newName);

                if (result.success) {
                    const newPath = result.path;
                    const newFileName = newPath.split(separator).pop();

                    const fileData = openedFiles.get(oldPath);
                    if (fileData) {
                        fileData.fileName = newFileName;
                        openedFiles.set(newPath, fileData);
                        openedFiles.delete(oldPath);
                    }

                    if (fileModificationState.has(oldPath)) {
                        fileModificationState.set(newPath, fileModificationState.get(oldPath));
                        fileModificationState.delete(oldPath);
                    }

                    currentFilePath = newPath;
                    document.title = `${newFileName} - Markdown IDE`;

                    const tab = document.querySelector(`[data-filepath="${CSS.escape(oldPath)}"]`);
                    if (tab) {
                        tab.dataset.filepath = newPath;
                        const closeBtn = tab.querySelector('.close-tab');
                        if (closeBtn) {
                            closeBtn.dataset.filepath = newPath;
                        }
                        const isDirty = tab.innerHTML.includes('●');
                        tab.innerHTML = `${newFileName} ${isDirty ? '● ' : ''}<span class="close-tab" data-filepath="${newPath}">×</span>`;
                    }

                    initializeFileTreeWithState();
                    updateRecentFilesAfterRename(oldPath, newPath); // Recent Filesも更新

                    console.log(`Renamed ${oldPath} to ${newPath}`);
                } else {
                    console.error('Rename failed:', result.error);
                    showNotification(`ファイル名の変更に失敗しました: ${result.error}`, 'error');
                    fileTitleInput.value = currentNameWithoutExt;
                }
            }
        } catch (e) {
            console.error('Error during rename:', e);
            fileTitleInput.value = currentNameWithoutExt;
        }
    });
}

function updateTabsAfterRename(oldPath, newPath, newName) {
    const fileData = openedFiles.get(oldPath);
    if (fileData) {
        fileData.fileName = newName;
        openedFiles.set(newPath, fileData);
        openedFiles.delete(oldPath);
    }

    if (fileModificationState.has(oldPath)) {
        fileModificationState.set(newPath, fileModificationState.get(oldPath));
        fileModificationState.delete(oldPath);
    }

    if (currentFilePath === oldPath) {
        currentFilePath = newPath;
        document.title = `${newName} - Markdown IDE`;

        if (fileTitleInput) {
            const extIndex = newName.lastIndexOf('.');
            const nameNoExt = extIndex > 0 ? newName.substring(0, extIndex) : newName;
            fileTitleInput.value = nameNoExt;
        }
    }

    const tab = document.querySelector(`[data-filepath="${CSS.escape(oldPath)}"]`);
    if (tab) {
        tab.dataset.filepath = newPath;
        const closeBtn = tab.querySelector('.close-tab');
        if (closeBtn) {
            closeBtn.dataset.filepath = newPath;
        }

        const isDirty = tab.innerHTML.includes('●');
        tab.childNodes[0].textContent = newName + ' ';
    }
}

function startRenaming(treeItem) {
    const labelSpan = treeItem.querySelector('.tree-label');
    if (!labelSpan) return;

    const originalName = treeItem.dataset.name;
    const originalPath = treeItem.dataset.path;

    labelSpan.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = originalName;

    treeItem.appendChild(input);
    input.focus();

    const lastDotIndex = originalName.lastIndexOf('.');
    if (lastDotIndex > 0) {
        input.setSelectionRange(0, lastDotIndex);
    } else {
        input.select();
    }

    let isCommitted = false;

    const finish = async (shouldCommit) => {
        if (isCommitted) return;
        isCommitted = true;

        const newName = input.value.trim();

        input.remove();
        labelSpan.style.display = '';

        if (shouldCommit && newName && newName !== originalName) {
            try {
                if (typeof window.electronAPI?.renameFile === 'function') {
                    const result = await window.electronAPI.renameFile(originalPath, newName);
                    if (result.success) {
                        showNotification(`名前を変更しました: ${newName}`, 'success');

                        updateTabsAfterRename(originalPath, result.path, newName);
                        updateRecentFilesAfterRename(originalPath, result.path); // Recent Filesも更新

                        initializeFileTreeWithState();
                    } else {
                        showNotification(`名前の変更に失敗しました: ${result.error}`, 'error');
                    }
                }
            } catch (e) {
                console.error(e);
                showNotification(`エラー: ${e.message}`, 'error');
            }
        }
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            finish(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
        }
    });

    input.addEventListener('blur', () => {
        finish(true);
    });

    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('dragstart', (e) => e.stopPropagation());
}

function showNotification(message, type = 'info') {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `notification-toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => {
            toast.remove();
        });
    }, 3000);
}

function setupFileExplorerEvents() {
    const fileContentContainer = document.getElementById('content-files');
    if (fileContentContainer) {

        // ========== キーボードショートカット (Undo/Redo) ==========
        fileContentContainer.addEventListener('keydown', async (e) => {
            // 入力フォームなどがアクティブな場合は無視
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            // Ctrl+Z (Undo)
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();

                try {
                    const result = await window.electronAPI.undoFileOperation();
                    if (result.success) {
                        showNotification(`元に戻しました: ${result.path || result.dest}`, 'success');

                        // 作成取り消しの場合、タブを閉じる
                        if (result.operation === 'delete') {
                            const tab = document.querySelector(`[data-filepath="${CSS.escape(result.path)}"]`);
                            if (tab) closeTab(tab, false);
                        }
                        // リネーム/移動取り消しの場合、タブ情報を更新する
                        else if (result.operation === 'rename' || result.operation === 'move') {
                            const fileName = result.dest.split(/[/\\]/).pop();
                            updateTabsAfterRename(result.src, result.dest, fileName);
                            updateRecentFilesAfterRename(result.src, result.dest);
                        }

                        initializeFileTreeWithState();
                    } else if (result.message) {
                        showNotification(result.message, 'info');
                    }
                } catch (err) {
                    showNotification(`Undoエラー: ${err.message}`, 'error');
                }
            }

            // Ctrl+Shift+Z or Ctrl+Y (Redo)
            if (
                ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.shiftKey) ||
                ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y')
            ) {
                e.preventDefault();
                e.stopPropagation();

                try {
                    const result = await window.electronAPI.redoFileOperation();
                    if (result.success) {
                        showNotification(`やり直しました: ${result.path || result.dest}`, 'success');

                        // リネーム/移動やり直しの場合、タブ情報を更新する
                        if (result.operation === 'rename' || result.operation === 'move') {
                            const fileName = result.dest.split(/[/\\]/).pop();
                            updateTabsAfterRename(result.src, result.dest, fileName);
                            updateRecentFilesAfterRename(result.src, result.dest);
                        }

                        initializeFileTreeWithState();
                    } else if (result.message) {
                        showNotification(result.message, 'info');
                    }
                } catch (err) {
                    showNotification(`Redoエラー: ${err.message}`, 'error');
                }
            }

            // Delete Key (Delete or Backspace)
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();

                const selectedItem = fileContentContainer.querySelector('.tree-item.selected');
                if (selectedItem && selectedItem.dataset.path) {
                    // 削除確認はconfirmAndDelete内で行っている
                    await confirmAndDelete(selectedItem.dataset.path);
                }
            }
        });

        fileContentContainer.addEventListener('click', (e) => {
            if (e.target.closest('.tree-item')) return;

            const container = document.getElementById('content-files');
            if (container) {
                container.focus();
                const selectedItems = container.querySelectorAll('.tree-item.selected');
                selectedItems.forEach(el => el.classList.remove('selected'));
            }
        });

        // 空白部分での右クリックメニュー
        fileContentContainer.addEventListener('contextmenu', (e) => {
            // ツリーアイテム上のクリックは、initializeFileTree内のイベントリスナーに任せる
            if (e.target.closest('.tree-item')) return;

            e.preventDefault();

            // 選択状態を解除（ルートフォルダに対する操作であることを視覚的に示す）
            const container = document.getElementById('content-files');
            if (container) {
                container.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
            }

            showEmptySpaceContextMenu(e.pageX, e.pageY);
        });
    }
}

// 設定画面のUIロジック
function setupSyncSettings() {
    if (!syncServiceSelect) return;

    syncServiceSelect.addEventListener('change', (e) => {
        const service = e.target.value;
        appSettings.cloudSync = appSettings.cloudSync || {};
        appSettings.cloudSync.service = service;

        // 表示切り替え
        syncSettingsDropbox.classList.toggle('hidden', service !== 'dropbox');
        syncSettingsGDrive.classList.toggle('hidden', service !== 'gdrive');

        saveSettings();
    });

    // 初期表示設定
    const currentService = appSettings.cloudSync?.service || 'none';
    syncServiceSelect.value = currentService;
    syncSettingsDropbox.classList.toggle('hidden', currentService !== 'dropbox');
    syncSettingsGDrive.classList.toggle('hidden', currentService !== 'gdrive');

    // 連携状態表示
    if (appSettings.cloudSync?.dropbox) {
        updateAuthStatus('dropbox', !!appSettings.cloudSync.dropbox.accessToken);
    }
    if (appSettings.cloudSync?.gdrive) {
        updateAuthStatus('gdrive', !!appSettings.cloudSync.gdrive.tokens);
    }

    // 認証ボタン (Dropbox)
    btnAuthDropbox.addEventListener('click', async () => {
        btnAuthDropbox.disabled = true;
        btnAuthDropbox.textContent = '認証中...';

        try {
            // パターンB: 引数なしで呼び出す（バックエンド側のキーを使用）
            const result = await window.electronAPI.authDropbox();

            if (result.success) {
                showNotification('Dropbox連携に成功しました', 'success');
                updateAuthStatus('dropbox', true);
                await loadSettings();
            } else {
                showNotification(`認証失敗: ${result.error}`, 'error');
            }
        } catch (e) {
            showNotification(`エラー: ${e.message}`, 'error');
        } finally {
            btnAuthDropbox.disabled = false;
            btnAuthDropbox.textContent = 'Dropboxと連携 (認証)';
        }
    });

    // 認証ボタン (Google Drive)
    btnAuthGDrive.addEventListener('click', async () => {
        btnAuthGDrive.disabled = true;
        btnAuthGDrive.textContent = '認証中...';

        try {
            const result = await window.electronAPI.authGDrive();
            if (result.success) {
                showNotification('Google Drive連携に成功しました', 'success');
                updateAuthStatus('gdrive', true);
                await loadSettings();
            } else {
                showNotification(`認証失敗: ${result.error}`, 'error');
            }
        } catch (e) {
            showNotification(`エラー: ${e.message}`, 'error');
        } finally {
            btnAuthGDrive.disabled = false;
            btnAuthGDrive.textContent = 'Google Driveと連携 (認証)';
        }
    });
}

function updateAuthStatus(service, isAuthenticated) {
    const el = document.getElementById(`${service}-status`);
    if (el) {
        el.textContent = isAuthenticated ? '連携済み ✅' : '未連携';
        el.className = `auth-status ${isAuthenticated ? 'authenticated' : 'unauthenticated'}`;
    }
}

// ツールバーの同期ボタン
if (btnCloudSync) {
    btnCloudSync.addEventListener('click', async () => {
        // 設定チェック
        if (!appSettings.cloudSync || appSettings.cloudSync.service === 'none') {
            showNotification('設定画面で同期サービスを選択・認証してください', 'error');
            openSettingsTab();
            return;
        }

        btnCloudSync.classList.add('syncing');
        if (syncStatusText) syncStatusText.textContent = '同期中...';

        try {
            const result = await window.electronAPI.startCloudSync();
            if (result.success) {
                showNotification('同期が完了しました', 'success');
            } else {
                showNotification(`同期エラー: ${result.error}`, 'error');
            }
        } catch (e) {
            showNotification(`予期せぬエラー: ${e.message}`, 'error');
        } finally {
            btnCloudSync.classList.remove('syncing');
            if (syncStatusText) syncStatusText.textContent = '';
            // ファイルツリーを更新
            initializeFileTreeWithState();
        }
    });
}

/**
 * 左下のアカウントボタンのセットアップ
 */
function setupAccountButton() {
    const btnAccounts = document.getElementById('btn-accounts');
    if (!btnAccounts) return;

    btnAccounts.addEventListener('click', async (e) => {
        e.stopPropagation();

        if (activeContextMenu) {
            activeContextMenu.remove();
            activeContextMenu = null;
            return;
        }

        let user = null;
        try {
            user = await window.electronAPI.getGitHubUser();
        } catch (err) {
            console.error(err);
        }

        const menu = document.createElement('div');
        menu.className = 'account-menu'; // CSSでcontext-menuと同様のスタイルを適用済み

        // 共通ヘッダー
        const header = document.createElement('div');
        header.className = 'account-menu-item';
        header.style.pointerEvents = 'none';
        header.style.fontSize = '11px';
        header.style.opacity = '0.7';
        header.style.borderBottom = 'none'; // CSSで制御するためリセット
        header.textContent = 'ACCOUNTS';
        menu.appendChild(header);

        // ヘッダー下のセパレータ
        const headerSep = document.createElement('div');
        headerSep.className = 'account-menu-separator';
        menu.appendChild(headerSep);

        if (user) {
            // ログイン済み
            const userItem = document.createElement('div');
            userItem.className = 'account-menu-item';
            userItem.innerHTML = `<span>${user.login} (GitHub)</span>`;
            menu.appendChild(userItem);

            const sep = document.createElement('div');
            sep.className = 'account-menu-separator';
            menu.appendChild(sep);

            const logoutItem = document.createElement('div');
            logoutItem.className = 'account-menu-item';
            logoutItem.textContent = 'ログアウト';
            logoutItem.addEventListener('click', async () => {
                menu.remove();
                activeContextMenu = null;
                await window.electronAPI.logoutGitHub();
                showNotification('ログアウトしました', 'success');
            });
            menu.appendChild(logoutItem);

        } else {
            // 未ログイン
            const signInItem = document.createElement('div');
            signInItem.className = 'account-menu-item';
            signInItem.innerHTML = '<span>GitHub 連携 (Sign in)</span>';
            signInItem.addEventListener('click', async () => {
                menu.remove();
                activeContextMenu = null;
                showNotification('GitHub認証を開始します...', 'info');
                try {
                    const result = await window.electronAPI.authGitHub();
                    if (result.success) {
                        showNotification('GitHub連携に成功しました！', 'success');
                    } else {
                        showNotification(`認証失敗: ${result.error}`, 'error');
                    }
                } catch (err) {
                    showNotification(`エラー: ${err.message}`, 'error');
                }
            });
            menu.appendChild(signInItem);
        }

        document.body.appendChild(menu);
        activeContextMenu = menu;
    });
}

// ========== プロジェクト全体検索 (Grep) ==========
const projectSearchInput = document.getElementById('project-search-input');
const projectSearchResults = document.getElementById('project-search-results');
const projectSearchStatus = document.getElementById('project-search-status');
const projectSearchClearBtn = document.getElementById('project-search-clear');

// 検索実行関数
async function executeProjectSearch() {
    if (!currentDirectoryPath) {
        if (projectSearchStatus) projectSearchStatus.textContent = "フォルダが開かれていません";
        return;
    }

    const query = projectSearchInput.value.trim();
    if (!query) return;

    if (projectSearchStatus) projectSearchStatus.textContent = "検索中...";
    if (projectSearchResults) projectSearchResults.innerHTML = "";

    try {
        const result = await window.electronAPI.grepSearch(query, currentDirectoryPath);

        if (result.success) {
            renderSearchResults(result.results, query);
        } else {
            if (projectSearchStatus) projectSearchStatus.textContent = `エラー: ${result.error}`;
        }
    } catch (e) {
        console.error(e);
        if (projectSearchStatus) projectSearchStatus.textContent = "検索エラーが発生しました";
    }
}

// 検索結果のレンダリング
function renderSearchResults(results, query) {
    if (!projectSearchResults) return;
    projectSearchResults.innerHTML = "";

    if (results.length === 0) {
        if (projectSearchStatus) projectSearchStatus.textContent = "見つかりませんでした";
        return;
    }

    if (projectSearchStatus) {
        // ファイル数とマッチ数を計算（簡易）
        const fileCount = new Set(results.map(r => r.filePath)).size;
        projectSearchStatus.textContent = `${results.length} 件の結果 (${fileCount} ファイル)`;
    }

    // ファイルごとに結果をグループ化
    const grouped = {};
    results.forEach(item => {
        if (!grouped[item.filePath]) grouped[item.filePath] = [];
        grouped[item.filePath].push(item);
    });

    // ファイルごとのブロックを作成
    Object.keys(grouped).forEach(filePath => {
        const matches = grouped[filePath];

        // ファイル名の表示用パス (相対パス)
        let displayPath = filePath;
        if (currentDirectoryPath && filePath.startsWith(currentDirectoryPath)) {
            displayPath = path.relative(currentDirectoryPath, filePath);
        }
        const fileName = path.basename(filePath);
        const dirName = path.dirname(displayPath); // ディレクトリ部分のみ

        const fileBlock = document.createElement('div');
        fileBlock.className = 'search-result-file';

        // ヘッダー (ファイル名)
        const header = document.createElement('div');
        header.className = 'search-result-file-header';
        header.title = filePath;
        header.innerHTML = `
            <span style="font-weight:bold;">${fileName}</span>
            <span style="color:#888; font-size:0.9em; margin-left:6px;">${dirName}</span>
            <span style="margin-left:auto; background:#ccc; color:#fff; border-radius:10px; padding:0 6px; font-size:10px;">${matches.length}</span>
        `;

        // ヘッダークリックで開閉（トグル）
        header.addEventListener('click', () => {
            const container = header.nextElementSibling;
            if (container) {
                container.style.display = container.style.display === 'none' ? 'flex' : 'none';
            }
        });

        fileBlock.appendChild(header);

        // マッチ行リスト
        const matchesContainer = document.createElement('div');
        matchesContainer.className = 'search-result-matches';

        matches.forEach(match => {
            const item = document.createElement('div');
            item.className = 'search-result-match';
            item.title = match.content; // ホバーで全文表示

            // キーワードハイライト処理
            // HTMLエスケープ後にハイライトタグを挿入
            const safeContent = escapeHtml(match.content);
            const safeQuery = escapeHtml(query);
            // 大文字小文字を無視して置換
            const highlightedContent = safeContent.replace(
                new RegExp(escapeRegExp(safeQuery), 'gi'),
                (m) => `<span class="match-highlight">${m}</span>`
            );

            item.innerHTML = `
                <span class="search-match-line">${match.lineNum}</span>
                <span>${highlightedContent}</span>
            `;

            // クリックで行へジャンプ
            item.addEventListener('click', async () => {
                await openFile(match.filePath, fileName);
                // ファイルが開くまで少し待つか、openFileが完了した後にジャンプ
                setTimeout(() => {
                    scrollToLine(match.lineNum - 1); // 0-indexedに変換
                    // ハイライト（選択）
                    if (globalEditorView) {
                        const line = globalEditorView.state.doc.line(match.lineNum);
                        globalEditorView.dispatch({
                            selection: { anchor: line.from, head: line.to },
                            scrollIntoView: true
                        });
                        globalEditorView.focus();
                    }
                }, 100);
            });

            matchesContainer.appendChild(item);
        });

        fileBlock.appendChild(matchesContainer);
        projectSearchResults.appendChild(fileBlock);
    });
}

// ヘルパー: HTMLエスケープ
function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ヘルパー: 正規表現エスケープ
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// イベントリスナー設定 (window.onload内などで呼び出し)
if (projectSearchInput) {
    // 入力時にクリアボタンの表示制御と、空になった時の結果クリアを行う
    projectSearchInput.addEventListener('input', () => {
        const hasText = projectSearchInput.value.length > 0;

        // ボタンの表示切り替え
        if (projectSearchClearBtn) {
            projectSearchClearBtn.style.display = hasText ? 'flex' : 'none';
        }

        // 文字が空になったら検索結果とステータスをクリア
        if (!hasText) {
            if (projectSearchResults) projectSearchResults.innerHTML = '';
            if (projectSearchStatus) projectSearchStatus.textContent = '';
        }
    });

    projectSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            executeProjectSearch();
        }
    });
}

// クリアボタンのクリックイベント
if (projectSearchClearBtn) {
    projectSearchClearBtn.addEventListener('click', () => {
        if (projectSearchInput) {
            projectSearchInput.value = '';
            projectSearchInput.focus();
        }
        projectSearchClearBtn.style.display = 'none';

        // 結果とステータスをクリア
        if (projectSearchResults) projectSearchResults.innerHTML = '';
        if (projectSearchStatus) projectSearchStatus.textContent = '';
    });
}

window.addEventListener('load', async () => {
    console.log('Markdown IDE loaded');

    await loadSettings();
    await loadRecentFiles();
    setupSettingsListeners();
    setupSyncSettings();
    setupSettingsNavigation(); // 設定画面のナビゲーション初期化

    setupSnippetEvents();
    renderCssSnippetsList();

    setupHotkeySearch();

    // 設定画面のメニューがクリックされたらリストを描画
    const hotkeyNav = document.querySelector('.settings-nav-item[data-section="hotkeys"]');
    if (hotkeyNav) {
        hotkeyNav.addEventListener('click', () => {
            renderHotkeysList();
        });
    }

    // 状態監視リスナー
    if (window.electronAPI && window.electronAPI.onSyncStatusChange) {
        window.electronAPI.onSyncStatusChange((status) => {
            if (status === 'syncing') {
                if (btnCloudSync) btnCloudSync.classList.add('syncing');
                if (syncStatusText) syncStatusText.textContent = '同期中...';
            } else if (status === 'idle') {
                if (btnCloudSync) btnCloudSync.classList.remove('syncing');
                if (syncStatusText) syncStatusText.textContent = '';
            } else if (status === 'error') {
                if (btnCloudSync) btnCloudSync.classList.remove('syncing');
                if (syncStatusText) syncStatusText.textContent = 'エラー';
                setTimeout(() => { if (syncStatusText) syncStatusText.textContent = ''; }, 3000);
            }
        });
    }

    initEditor();
    showWelcomeReadme();
    initializeFileTree();
    setupFileExplorerEvents();
    updateOutline();
    updateLeftPaneWidthVariable();
    initToolbarOverflow();
    setupToolbarDropdownPositioning();

    // カレンダー機能の初期化
    if (window.calendarAPI) {
        window.calendarAPI.init();
    }

    if (isTerminalVisible) {
        initializeTerminal();
    }
    updateTerminalVisibility();

    if (document.querySelector('.side-switch.active')) {
        switchHeaderButtons(document.querySelector('.side-switch.active').dataset.target);
    }

    // アプリ起動時にステータスバーのGit情報を更新
    updateStatusBarGitInfo();

    // ファイルシステムの変更を監視
    if (typeof window.electronAPI?.onFileSystemChanged === 'function') {
        window.electronAPI.onFileSystemChanged((payload) => {
            // 1. ファイルツリーの更新 (既存ロジック)
            if (window.fileTreeUpdateTimeout) clearTimeout(window.fileTreeUpdateTimeout);
            window.fileTreeUpdateTimeout = setTimeout(() => {
                initializeFileTreeWithState();
                if (typeof refreshGitStatus === 'function') {
                    refreshGitStatus();
                }
            }, 500);

            // 2. 現在開いているファイルの自動再読み込み判定
            // (renameイベントはファイル消失の可能性があるため、changeイベントのみ対象とするのが安全ですが、
            //  エディタによっては保存時に rename -> change の順で走ることもあるため、
            //  ここではファイルが存在するか確認してから処理します)
            if (currentFilePath && payload.filename) {
                // パスの正規化と判定
                // fs.watchのfilenameは、監視ルートからの相対パスの場合が多い
                let changedFullPath = payload.filename;

                // 絶対パスでない場合、カレントディレクトリと結合して絶対パス化を試みる
                if (!path.isAbsolute(payload.filename) && currentDirectoryPath) {
                    changedFullPath = path.join(currentDirectoryPath, payload.filename);
                }

                // パス区切り文字の正規化 (Windows対策)
                const normalizedCurrent = currentFilePath.replace(/\\/g, '/');
                const normalizedChanged = changedFullPath.replace(/\\/g, '/');

                // 現在開いているファイルと一致する場合
                if (normalizedCurrent === normalizedChanged) {
                    // デバウンス処理 (短時間の連続発火を防ぐ)
                    if (window.activeFileReloadTimeout) clearTimeout(window.activeFileReloadTimeout);
                    window.activeFileReloadTimeout = setTimeout(() => {
                        checkExternalFileChange(currentFilePath);
                    }, 600); // ツリー更新より少し遅らせて実行
                }
            }
        });
    }

    // エディタのコンテキストメニューリスナー設定
    if (editorContainer) {
        editorContainer.addEventListener('contextmenu', (e) => {
            if (!globalEditorView) return;
            e.preventDefault();
            // ネイティブメニューではなく、HTML製のカスタムメニューを表示する
            showEditorContextMenu(e.pageX, e.pageY);
        });
    }

    // プラスボタンのイベントリスナー
    const btnNewTab = document.getElementById('btn-new-tab');
    if (btnNewTab) {
        btnNewTab.addEventListener('click', () => {
            createNewTab();
        });
    }

    // Gitセクションの開閉（アコーディオン）機能
    const setupGitToggle = (headerId, listId) => {
        const header = document.getElementById(headerId);
        const list = document.getElementById(listId);

        if (header && list) {
            header.addEventListener('click', () => {
                const isHidden = list.style.display === 'none';

                if (isHidden) {
                    // 開く
                    list.style.display = 'block';
                    header.classList.remove('collapsed');
                } else {
                    // 閉じる
                    list.style.display = 'none';
                    header.classList.add('collapsed');
                }
            });
        }
    };

    setupGitToggle('header-unstaged', 'git-unstaged');
    setupGitToggle('header-staged', 'git-staged');

    // ブランチ切り替え機能の初期化
    setupGitBranchSwitching();
    // .gitignoreボタンのセットアップ
    setupGitExtraButtons();
    // アカウントボタンのセットアップ
    setupAccountButton();

    // メインプロセスからのコンテキストメニューコマンド受信
    window.electronAPI.onEditorContextMenuCommand((command) => {
        if (!globalEditorView) return;

        if (typeof command === 'string') {
            switch (command) {
                case 'bold':
                    toggleMark(globalEditorView, '**');
                    break;
                case 'insert-table':
                    insertTable(globalEditorView);
                    break;
                case 'code-block':
                    insertCodeBlock(globalEditorView);
                    break;
            }
        } else if (typeof command === 'object' && command.action === 'highlight') {
            toggleHighlightColor(globalEditorView, command.color);
        }
    });
});

// ブランチ切り替え機能のセットアップ (サイドバー & ステータスバー)
function setupGitBranchSwitching() {
    // 共通のクリックハンドラ
    const handleBranchClick = async (e) => {
        if (!currentDirectoryPath) return;
        e.stopPropagation();

        // awaitの前にクリックされた要素を変数に保存しておく
        const targetElement = e.currentTarget;

        if (activeContextMenu) {
            activeContextMenu.remove();
            activeContextMenu = null;
        }

        try {
            // 非同期処理 (ここで時間がかかると e.currentTarget が null になる)
            const result = await window.electronAPI.gitGetBranches(currentDirectoryPath);

            if (!result.success) {
                showNotification(`ブランチ情報の取得に失敗: ${result.error}`, 'error');
                return;
            }

            // 保存しておいた targetElement を使用する
            if (targetElement) {
                showBranchMenu(targetElement, result.branches, result.current);
            }

        } catch (err) {
            console.error(err);
            showNotification(`エラー: ${err.message}`, 'error');
        }
    };

    // 1. サイドバーのGitパネル内のバッジ
    const branchBadge = document.getElementById('git-current-branch');
    if (branchBadge) {
        branchBadge.title = "クリックしてブランチを切り替え";
        // 重複登録防止のため、一度削除してから追加（念のため）
        branchBadge.removeEventListener('click', handleBranchClick);
        branchBadge.addEventListener('click', handleBranchClick);
    }

    // 2. ステータスバーのブランチ表示
    if (statusBarBranch) {
        statusBarBranch.removeEventListener('click', handleBranchClick);
        statusBarBranch.addEventListener('click', handleBranchClick);
    }
}

// ブランチ選択メニューの表示（リモート対応・作成・削除機能付き）
function showBranchMenu(targetElement, branches, currentBranch) {
    const rect = targetElement.getBoundingClientRect();

    const menu = document.createElement('div');
    menu.className = 'branch-menu';

    // ▼表示位置の自動調整（ステータスバー対応）
    // ターゲットが画面の下半分にある場合は上に、そうでない場合は下に表示する
    if (rect.top > window.innerHeight / 2) {
        // 上に表示 (bottomプロパティを使用)
        menu.style.bottom = `${window.innerHeight - rect.top + 5}px`;
        menu.style.top = 'auto';
        // 画面上部にはみ出さないように高さを制限
        menu.style.maxHeight = `${rect.top - 10}px`;
    } else {
        // 下に表示 (topプロパティを使用)
        menu.style.top = `${rect.bottom + 5}px`;
        menu.style.bottom = 'auto';
        // 画面下部にはみ出さないように高さを制限
        menu.style.maxHeight = `${window.innerHeight - rect.bottom - 10}px`;
    }

    menu.style.left = `${rect.left}px`;

    // --- 新規ブランチ作成項目 ---
    const createItem = document.createElement('div');
    createItem.className = 'branch-menu-item';
    createItem.innerHTML = `<span style="color: #007acc; font-weight: bold;">+ 新規ブランチ作成</span>`;
    createItem.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        showCompactInputModal('新規ブランチ名を入力してください', 'feature/new-func', async (newName) => {
            if (!newName) return;
            showNotification(`ブランチ作成中: ${newName}`, 'info');
            try {
                // 作成してチェックアウト
                const result = await window.electronAPI.gitCreateBranch(currentDirectoryPath, newName);
                if (result.success) {
                    showNotification(`ブランチを作成・切り替えました: ${newName}`, 'success');
                    refreshGitStatus();
                    initializeFileTreeWithState();
                } else {
                    showNotification(`作成エラー: ${result.error}`, 'error');
                }
            } catch (e) {
                showNotification(`エラー: ${e.message}`, 'error');
            }
        });
    });
    menu.appendChild(createItem);

    // 区切り線
    const sep = document.createElement('div');
    sep.style.height = '1px';
    sep.style.backgroundColor = 'rgba(128, 128, 128, 0.3)';
    sep.style.margin = '4px 0';
    menu.appendChild(sep);

    // ブランチ一覧
    branches.forEach(branch => {
        const item = document.createElement('div');
        item.className = 'branch-menu-item';

        // コンテナのスタイル調整（削除ボタンを右端に配置するため）
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'space-between';

        // 現在のブランチにはスタイルを適用
        const isCurrent = branch === currentBranch;
        if (isCurrent) {
            item.classList.add('current');
        }

        // リモートブランチかどうかの判定
        const isRemote = branch.startsWith('origin/');
        const displayIcon = isRemote ? '☁ ' : '🌿 ';
        const displayName = branch;

        // ブランチ名部分（クリックで切り替え）
        const nameSpan = document.createElement('span');
        nameSpan.innerHTML = `${displayIcon}${displayName} ${isCurrent ? '<span class="branch-check">✓</span>' : ''}`;
        nameSpan.style.flex = '1'; // 残りの幅を埋める

        nameSpan.addEventListener('click', async () => {
            menu.remove();
            activeContextMenu = null;

            if (isCurrent) return;

            try {
                showNotification(`'${displayName}' に切り替えています...`, 'info');
                const result = await window.electronAPI.gitCheckout(currentDirectoryPath, branch);

                if (result.success) {
                    showNotification(`切り替え完了: ${branch}`, 'success');
                    refreshGitStatus();
                    initializeFileTreeWithState();
                    if (currentFilePath && openedFiles.has(currentFilePath)) {
                        openFile(currentFilePath, openedFiles.get(currentFilePath).fileName);
                    }
                } else {
                    showNotification(`切り替えエラー: ${result.error}`, 'error');
                }
            } catch (e) {
                showNotification(`エラー: ${e.message}`, 'error');
            }
        });

        item.appendChild(nameSpan);

        // 削除ボタン (ローカルかつ現在以外のブランチのみ)
        if (!isRemote && !isCurrent) {
            const deleteBtn = document.createElement('span');
            deleteBtn.innerHTML = '🗑';
            deleteBtn.title = 'このブランチを削除';
            deleteBtn.style.cursor = 'pointer';
            deleteBtn.style.fontSize = '12px';
            deleteBtn.style.padding = '2px 6px';
            deleteBtn.style.marginLeft = '8px';
            deleteBtn.style.color = '#888';
            deleteBtn.style.borderRadius = '3px';

            deleteBtn.onmouseover = () => { deleteBtn.style.color = '#d9534f'; deleteBtn.style.backgroundColor = 'rgba(0,0,0,0.1)'; };
            deleteBtn.onmouseout = () => { deleteBtn.style.color = '#888'; deleteBtn.style.backgroundColor = 'transparent'; };

            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 切り替えイベントの発火を防ぐ
                menu.remove();
                activeContextMenu = null;

                showCompactConfirmModal(`ブランチ '${branch}' を削除しますか？\n(マージされていない変更は失われる可能性があります)`, async () => {
                    try {
                        const result = await window.electronAPI.gitDeleteBranch(currentDirectoryPath, branch);
                        if (result.success) {
                            showNotification(`ブランチを削除しました: ${branch}`, 'success');
                            refreshGitStatus();
                        } else {
                            showNotification(`削除エラー: ${result.error}`, 'error');
                        }
                    } catch (err) {
                        showNotification(`エラー: ${err.message}`, 'error');
                    }
                });
            });
            item.appendChild(deleteBtn);
        }

        menu.appendChild(item);
    });

    document.body.appendChild(menu);
    activeContextMenu = menu;
}

// ========== ファイルシステム操作 ==========

/**
 * ファイルパスからファイルタイプを判定するヘルパー
 */
function getFileType(filePath) {
    if (!filePath) return 'text';
    const ext = path.extname(filePath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'].includes(ext)) {
        return 'image';
    }
    if (ext === '.pdf') {
        return 'pdf';
    }
    return 'text';
}

/**
 * 画像やPDFを #media-view に描画する関数
 */
async function renderMediaContent(filePath, type) {
    const container = document.getElementById('media-view');
    if (!container) return;
    container.innerHTML = '';

    if (type === 'image') {
        const img = document.createElement('img');
        // Windowsパスのバックスラッシュをスラッシュに置換して file:// プロトコルで使用
        img.src = `file://${filePath.replace(/\\/g, '/')}`;
        img.style.maxWidth = '100%';
        img.style.boxShadow = '0 0 10px rgba(0,0,0,0.1)';
        container.appendChild(img);
    } else if (type === 'pdf') {
        const loading = document.createElement('div');
        loading.textContent = 'Loading PDF...';
        loading.style.color = '#888';
        loading.style.marginTop = '20px';
        container.appendChild(loading);

        try {

            const url = `file://${filePath.replace(/\\/g, '/')}`;
            const loadingTask = pdfjsLib.getDocument(url);
            const pdf = await loadingTask.promise;

            // ロードが完了したら、ローディングメッセージを削除
            container.removeChild(loading);

            // 新しい描画関数を呼び出し、コントロールUIと全ページを描画
            await renderAllPdfPages(pdf, container, filePath);

        } catch (e) {
            loading.textContent = `Error loading PDF: ${e.message}`;
            console.error(e);
        }
    }
}

// ========== コンフリクト解消機能の実装 (修正版) ==========

// 1. ボタンを表示するためのウィジェット
class ConflictWidget extends WidgetType {
    constructor(startLine, midLine, endLine) {
        super();
        this.startLine = startLine;
        this.midLine = midLine;
        this.endLine = endLine;
    }

    eq(other) {
        return other.startLine === this.startLine &&
            other.midLine === this.midLine &&
            other.endLine === this.endLine;
    }

    toDOM(view) {
        const div = document.createElement("div");
        div.className = "conflict-actions-widget";

        const label = document.createElement("span");
        label.textContent = "コンフリクト:";
        label.style.fontWeight = "bold";
        label.style.fontSize = "11px";
        label.style.marginRight = "8px";

        const createBtn = (text, cls, type) => {
            const btn = document.createElement("button");
            btn.textContent = text;
            btn.className = `conflict-btn ${cls}`;
            // マウスダウンイベントを止めてカーソル移動を防ぐ
            btn.onmousedown = (e) => e.preventDefault();
            btn.onclick = (e) => {
                e.preventDefault();
                this.resolve(view, type);
            };
            return btn;
        };

        div.appendChild(label);
        div.appendChild(createBtn("自分の変更 (Current)", "current", "current"));
        div.appendChild(createBtn("相手の変更 (Incoming)", "incoming", "incoming"));
        div.appendChild(createBtn("両方残す", "both", "both"));

        return div;
    }

    resolve(view, type) {
        const doc = view.state.doc;
        // 行番号から位置を取得
        const startPos = doc.line(this.startLine).from;
        const endPos = doc.line(this.endLine).to;

        let insertText = "";

        if (type === 'current') {
            // 中身がある場合のみ抽出
            if (this.midLine > this.startLine + 1) {
                const textStart = doc.line(this.startLine + 1).from;
                const textEnd = doc.line(this.midLine - 1).to;
                insertText = doc.sliceString(textStart, textEnd);
            }
        } else if (type === 'incoming') {
            if (this.endLine > this.midLine + 1) {
                const textStart = doc.line(this.midLine + 1).from;
                const textEnd = doc.line(this.endLine - 1).to;
                insertText = doc.sliceString(textStart, textEnd);
            }
        } else if (type === 'both') {
            const current = (this.midLine > this.startLine + 1)
                ? doc.sliceString(doc.line(this.startLine + 1).from, doc.line(this.midLine - 1).to)
                : "";
            const incoming = (this.endLine > this.midLine + 1)
                ? doc.sliceString(doc.line(this.midLine + 1).from, doc.line(this.endLine - 1).to)
                : "";
            // 両方残す場合は間に改行を入れて結合
            insertText = current + (current && incoming ? "\n" : "") + incoming;
        }

        view.dispatch({
            changes: { from: startPos, to: endPos, insert: insertText },
            scrollIntoView: true
        });
    }
}

// 2. ハイライトロジック (引数を state に変更)
function conflictHighlighter(state) {
    const builder = new RangeSetBuilder();
    const doc = state.doc; // view.state.doc ではなく state.doc を使用
    
    let startLine = -1;
    let midLine = -1;

    // ドキュメント全体を走査
    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const text = line.text;

        // 正規表現でインデントがあっても検出できるように修正
        if (/^\s*<<<<<<< /.test(text) || text.trim() === '<<<<<<<') {
            startLine = i;
            midLine = -1;
        } else if (/^\s*=======/.test(text) && startLine !== -1) {
            midLine = i;
        } else if (/^\s*>>>>>>>/.test(text) && startLine !== -1 && midLine !== -1) {
            const endLine = i;

            // RangeSetBuilderには「位置の昇順」で追加する必要があります
            
            const startPos = doc.line(startLine).from;
            
            // 1. 開始行 (<<<<<<<)
            // ウィジェット (ボタン) を追加
            builder.add(startPos, startPos, Decoration.widget({
                widget: new ConflictWidget(startLine, midLine, endLine),
                side: -1,
                block: true
            }));
            
            // マーカー行の色付け
            builder.add(startPos, startPos, Decoration.line({ class: "cm-conflict-marker" }));

            // 2. 自分の変更 (Current) エリア
            if (midLine > startLine + 1) {
                for (let l = startLine + 1; l < midLine; l++) {
                    const pos = doc.line(l).from;
                    builder.add(pos, pos, Decoration.line({ class: "cm-conflict-current-content" }));
                }
            }

            // 3. 中間行 (=======)
            const midPos = doc.line(midLine).from;
            builder.add(midPos, midPos, Decoration.line({ class: "cm-conflict-marker" }));

            // 4. 相手の変更 (Incoming) エリア
            if (endLine > midLine + 1) {
                for (let l = midLine + 1; l < endLine; l++) {
                    const pos = doc.line(l).from;
                    builder.add(pos, pos, Decoration.line({ class: "cm-conflict-incoming-content" }));
                }
            }

            // 5. 終了行 (>>>>>>>)
            const endPos = doc.line(endLine).from;
            builder.add(endPos, endPos, Decoration.line({ class: "cm-conflict-marker" }));

            // リセットして次の検索へ
            startLine = -1;
            midLine = -1;
        }
    }
    return builder.finish();
}

// 3. プラグイン定義 (StateFieldに変更)
const conflictField = StateField.define({
    create(state) {
        return conflictHighlighter(state);
    },
    update(decorations, tr) {
        // ドキュメントが変更された場合のみ再計算
        if (tr.docChanged) {
            return conflictHighlighter(tr.state);
        }
        // 変更がない場合は位置のマッピングだけ行う（高速化）
        return decorations.map(tr.changes);
    },
    provide: f => EditorView.decorations.from(f)
});

/**
 * Git Diffビューを新しいタブで開く関数
 * @param {string} filePath - リポジトリルートからの相対パス
 */
async function openDiffView(filePath) {
    if (!currentDirectoryPath) return;

    // 1. Diff用の仮想パスを作成
    const diffPath = `DIFF://${filePath}`;

    // 2. 既に開いている場合はそのタブに切り替え
    if (openedFiles.has(diffPath)) {
        switchToFile(diffPath);
        return;
    }

    try {
        // 3. データ取得 (HEAD vs Local)
        // A: HEADの内容 (Original / Left)
        const headResult = await window.electronAPI.gitShow(currentDirectoryPath, 'HEAD', filePath);
        const headContent = headResult.success ? headResult.content : "";

        // B: ワーキングツリーの内容 (Modified / Right)
        const absolutePath = path.join(currentDirectoryPath, filePath);
        let localContent = "";
        try {
            localContent = await window.electronAPI.loadFile(absolutePath);
        } catch (e) {
            localContent = "";
        }

        const fileName = path.basename(filePath);
        const tabName = `Diff: ${fileName}`;

        // 4. 仮想ファイルとして登録
        openedFiles.set(diffPath, {
            type: 'diff', // 新しいタイプ
            fileName: tabName,
            content: localContent, // 保存用に現在の内容を保持
            headContent: headContent, // 比較用
            originalPath: absolutePath, // 上書き保存先
            isVirtual: true
        });

        // 5. タブを作成
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.dataset.filepath = diffPath;
        // 閉じるボタン付きのタブHTML
        tab.innerHTML = `<span class="tab-filename">${tabName}</span> <span class="close-tab" data-filepath="${diffPath}">×</span>`;
        editorTabsContainer.appendChild(tab);

        // 6. そのタブを開く
        switchToFile(diffPath);

    } catch (e) {
        console.error('Failed to open diff view:', e);
        showNotification(`Diff表示エラー: ${e.message}`, 'error');
    }
}

async function openFile(filePath, fileName) {
    // パスを正規化して統一
    const normalizedPath = path.resolve(filePath);

    // 履歴に追加
    addToRecentFiles(normalizedPath);

    try {
        if (openedFiles.has('README.md')) {
            closeWelcomeReadme();
        }

        // 既に開いているかチェック
        let tab = document.querySelector(`[data-filepath="${CSS.escape(normalizedPath)}"]`);

        if (tab) {
            switchToFile(normalizedPath);
            return;
        }

        // ファイルタイプ判定
        const fileType = getFileType(normalizedPath);
        let fileContent = '';

        // テキストファイルの場合のみ内容を読み込む
        if (fileType === 'text') {
            if (typeof window.electronAPI?.loadFile === 'function') {
                try {
                    fileContent = await window.electronAPI.loadFile(normalizedPath);
                } catch (error) {
                    console.error('Failed to load file content:', error);
                    fileContent = `ファイルを読み込めません: ${error.message}`;
                }
            } else {
                fileContent = `ファイル: ${fileName}\n(内容は読み込めません)`;
            }
        } else {
            // 画像やPDFの場合は内容は空でOK（パスを使って表示するため）
            fileContent = null;
        }

        if (!tab) {
            tab = document.createElement('div');
            tab.className = 'tab';
            tab.dataset.filepath = normalizedPath;
            tab.innerHTML = `<span class="tab-filename">${fileName}</span> <span class="close-tab" data-filepath="${normalizedPath}">×</span>`;
            editorTabsContainer.appendChild(tab);

            // type情報を保存
            openedFiles.set(normalizedPath, {
                content: fileContent,
                fileName: fileName,
                type: fileType
            });
        }

        switchToFile(normalizedPath);
    } catch (error) {
        console.error('Failed to open file:', error);
    }
}

function showWelcomeReadme() {
    const readmePath = 'README.md';
    if (openedFiles.has(readmePath)) return;

    openedFiles.set(readmePath, {
        content: startDoc,
        fileName: 'README.md',
        isVirtual: true
    });

    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.filepath = readmePath;
    tab.innerHTML = `README.md`;

    if (editorTabsContainer) {
        editorTabsContainer.appendChild(tab);
    }

    switchToFile(readmePath);
}

function closeWelcomeReadme() {
    const readmePath = 'README.md';
    const readmeTab = document.querySelector(`[data-filepath="${readmePath}"]`);

    if (readmeTab) {
        readmeTab.remove();
        openedFiles.delete(readmePath);
        fileModificationState.delete(readmePath);
    }
}

function switchToFile(filePath) {
    // 古いパスを保存
    const previouslyActivePath = currentFilePath;

    // --- Diffビューからの切り替え時のクリーンアップ ---
    if (globalDiffView) {
        // Diffビューを破棄してエディタをクリア
        const editorEl = document.getElementById('editor');
        if (editorEl) {
            editorEl.innerHTML = '';
            // Flex設定を解除してブロック要素に戻す（重要）
            editorEl.style.display = 'block';
            editorEl.style.flexDirection = '';
            editorEl.style.overflow = '';
        }

        globalDiffView = null;
        isDiffMode = false;

        // 通常のエディタ(globalEditorView)も再作成が必要になるため破棄
        globalEditorView = null;
        initEditor(); // 再初期化
    }
    // -------------------------------------------------------

    // ファイル切り替え時に古いファイルの自動保存タイマーをクリア
    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }

    // 1. 現在開いているファイルの状態を保存する (テキストファイルの場合のみ)
    if (previouslyActivePath && globalEditorView && openedFiles.has(previouslyActivePath)) {
        const currentFileData = openedFiles.get(previouslyActivePath);
        if (!currentFileData.type || currentFileData.type === 'text') {
            currentFileData.editorState = globalEditorView.state;
            currentFileData.content = globalEditorView.state.doc.toString();
        }
    }

    // 2. パスを更新
    currentFilePath = filePath;
    const fileData = openedFiles.get(filePath);

    // タイプ判定 (diffタイプを追加)
    const fileType = fileData ? (fileData.type || 'text') : getFileType(filePath);
    const isVirtualReadme = fileData && fileData.isVirtual === true;

    // DOM要素取得
    const editorEl = document.getElementById('editor');
    const mediaViewEl = document.getElementById('media-view');
    const toolbar = document.querySelector('.toolbar');
    const searchWidget = document.getElementById('custom-search-widget');
    const fileTitleBarEl = document.getElementById('file-title-bar');

    // 親コンテナを表示
    switchMainView('content-readme');

    // Diffモードの処理
    if (fileType === 'diff') {
        if (editorEl) {
            editorEl.style.display = 'flex'; // Flexboxにして高さを確保
            editorEl.style.flexDirection = 'column';
            editorEl.style.overflow = 'hidden';
        }
        if (mediaViewEl) mediaViewEl.classList.add('hidden');
        if (toolbar) toolbar.classList.add('hidden'); // Diff時はツールバーを隠す
        if (fileTitleBarEl) fileTitleBarEl.classList.add('hidden');

        // コンテナクリア
        editorEl.innerHTML = '';
        isDiffMode = true;

        // CodeMirrorの拡張機能セット (カーソル・行番号・キー操作を有効化)
        const extensions = [
            EditorView.lineWrapping,
            syntaxHighlighting(defaultHighlightStyle),
            appSettings.theme === 'dark' ? oneDark : [],
            lineNumbers(),           // 行番号
            highlightActiveLine(),   // 現在行ハイライト
            drawSelection(),         // 選択範囲の描画
            dropCursor(),            // ドラッグ時のカーソル
            history(),               // Undo/Redo
            conflictField,         // コンフリクト解消プラグイン
            keymap.of([...defaultKeymap, ...historyKeymap]), // キーボードショートカット

            // テーマ設定 (高さ100%確保と差分色調整)
            EditorView.theme({
                "&": { height: "100%" },
                ".cm-scroller": { overflow: "auto" },
                ".cm-gutters": {
                    backgroundColor: "var(--sidebar-bg)",
                    borderRight: "1px solid var(--sidebar-border)",
                    color: "var(--text-color)",
                    minWidth: "30px"
                },
                ".cm-merge-a .cm-changedLine": { backgroundColor: "rgba(200, 50, 50, 0.1)" },
                ".cm-merge-b .cm-changedLine": { backgroundColor: "rgba(50, 200, 50, 0.1)" }
            })
        ];

        // シンタックスハイライト用
        if (fileData.originalPath) {
            const langExt = getLanguageExtensions(fileData.originalPath);
            if (langExt) extensions.push(langExt);
        }

        // MergeView (Diffエディタ) の生成
        globalDiffView = new MergeView({
            a: {
                doc: fileData.headContent || "",
                extensions: [
                    ...extensions,
                    EditorView.editable.of(false), // 左側(HEAD)は編集不可
                    EditorState.readOnly.of(true)
                ]
            },
            b: {
                doc: fileData.content || "",
                extensions: [
                    ...extensions,
                    // 右側(Local)が変更されたら保存用データを更新
                    EditorView.updateListener.of(update => {
                        if (update.docChanged) {
                            fileData.content = update.state.doc.toString();
                        }
                    })
                ]
            },
            parent: editorEl,
            orientation: "a-b", // 左右分割
            gutter: true,
            highlightChanges: true
        });

        // タイトルバー更新
        if (fileTitleInput) fileTitleInput.value = fileData.fileName;
        document.title = fileData.fileName;

        return; // Diffモードの処理終了
    }

    // --- 通常モード (Text / Image) ---
    isDiffMode = false;

    if (fileType === 'text') {
        if (editorEl) editorEl.style.display = 'block';
        if (mediaViewEl) mediaViewEl.classList.add('hidden');

        if (toolbar) {
            if (appSettings.showToolbar) toolbar.classList.remove('hidden');
            else toolbar.classList.add('hidden');
        }

        if (fileTitleBarEl) {
            if (isVirtualReadme || !appSettings.showFileTitleBar) fileTitleBarEl.classList.add('hidden');
            else fileTitleBarEl.classList.remove('hidden');
        }

        // エディタの状態復元
        if (globalEditorView) {
            if (fileData && fileData.editorState) {
                globalEditorView.setState(fileData.editorState);
            } else {
                const fileContent = fileData ? fileData.content : '';
                const newState = createEditorState(fileContent, filePath);
                globalEditorView.setState(newState);
            }
        }
    } else {
        // メディアモード
        if (editorEl) editorEl.style.display = 'none';
        if (mediaViewEl) mediaViewEl.classList.remove('hidden');
        if (toolbar) toolbar.classList.add('hidden');
        if (searchWidget) searchWidget.classList.add('hidden');
        if (fileTitleBarEl) fileTitleBarEl.classList.add('hidden');

        renderMediaContent(filePath, fileType);
    }

    // UI更新処理
    if (fileType === 'text' && !isVirtualReadme && fileTitleInput) {
        const fileName = fileData ? fileData.fileName : filePath.split(/[\/\\]/).pop();
        const extIndex = fileName.lastIndexOf('.');
        const fileNameWithoutExt = extIndex > 0 ? fileName.substring(0, extIndex) : fileName;
        fileTitleInput.value = fileNameWithoutExt;
    }

    updateOutline();

    if (isPdfPreviewVisible && fileType === 'text' && !isVirtualReadme) {
        generatePdfPreview();
    }

    if (fileData) {
        document.title = `${fileData.fileName} - Markdown IDE`;
        document.body.dataset.activeFileDir = path.dirname(filePath);
    }

    updateFileStats();
    onEditorInput(false);
}

function closeTab(element, isSettings = false) {
    if (element) element.remove();

    if (isSettings) {
        switchToLastFileOrReadme();
    } else {
        const filePath = element.dataset.filepath;

        if (filePath) {

            // 自動保存がONかつ未保存の場合の処理を追加
            const isDirty = fileModificationState.get(filePath);
            const fileData = openedFiles.get(filePath);

            if (isDirty && appSettings.autoSave && appSettings.autoSaveOnClose && !(fileData && fileData.isVirtual)) {
                // 未保存かつ自動保存(大元)と閉じる時保存がON、かつ新規ファイル(仮想ファイル)ではない場合
                saveCurrentFile(false, filePath); // ファイルパスを渡して、このファイルを保存
            }

            // 閉じたタブの情報を履歴に保存
            if (fileData) {
                closedTabsHistory.push({
                    path: filePath,
                    fileName: fileData.fileName,
                    content: fileData.content || (globalEditorView && currentFilePath === filePath ? globalEditorView.state.doc.toString() : ''),
                    isVirtual: fileData.isVirtual || false
                });
                // 履歴が増えすぎないように制限（例: 最大20件）
                if (closedTabsHistory.length > 20) closedTabsHistory.shift();
            }

            openedFiles.delete(filePath);
            fileModificationState.delete(filePath);

            if (currentFilePath === filePath) {
                currentFilePath = null;
                if (globalEditorView) {
                    globalEditorView.dispatch({
                        changes: { from: 0, to: globalEditorView.state.doc.length, insert: "" },
                        annotations: ExternalChange.of(true)
                    });
                }
                switchToLastFileOrReadme();
            }
        }
    }
}

function reopenLastClosedTab() {
    if (closedTabsHistory.length === 0) return;
    const lastTab = closedTabsHistory.pop();

    if (lastTab.isVirtual) {
        // --- 仮想ファイル(Untitled)の復元 ---
        let targetPath = lastTab.path;
        let targetName = lastTab.fileName;

        // もし同名のUntitledが既に開かれている場合は、新しい番号を採番して衝突を防ぐ
        if (openedFiles.has(targetPath)) {
            const nextNum = getAvailableUntitledNumber();
            targetName = `Untitled-${nextNum}`;
            targetPath = targetName;
        }

        // データを復元
        openedFiles.set(targetPath, {
            content: lastTab.content,
            fileName: targetName,
            isVirtual: true
        });

        // タブを作成
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.dataset.filepath = targetPath;
        // 未保存マーク付きで復元
        tab.innerHTML = `${targetName} ● <span class="close-tab" data-filepath="${targetPath}">×</span>`;
        if (editorTabsContainer) editorTabsContainer.appendChild(tab);

        // 状態を復元
        fileModificationState.set(targetPath, true);
        switchToFile(targetPath);

    } else {
        // --- 通常ファイルの復元 ---
        // ファイルが存在するか確認してから開く（openFile内でチェックされるが念のため）
        // 履歴にあるパスを使ってファイルを開き直す
        openFile(lastTab.path, lastTab.fileName);
    }
}

function switchToLastFileOrReadme() {
    const remainingTabs = document.querySelectorAll('.editor-tabs .tab');
    if (remainingTabs.length > 0) {
        const lastTab = remainingTabs[remainingTabs.length - 1];
        if (lastTab.id === 'tab-settings') {
            openSettingsTab();
        } else if (lastTab.dataset.filepath) {
            switchToFile(lastTab.dataset.filepath);
        }
    } else {
        showWelcomeReadme();
    }
}

/**
 * タブを切り替える関数 (循環対応)
 * @param {number} direction - 1: 次のタブ, -1: 前のタブ
 */
function switchTab(direction) {
    const tabs = Array.from(document.querySelectorAll('.editor-tabs .tab'));
    if (tabs.length <= 1) return;

    const activeTab = document.querySelector('.editor-tabs .tab.active');
    // アクティブなタブがない場合は先頭を選択
    if (!activeTab) {
        const target = tabs[0];
        if (target.id === 'tab-settings') openSettingsTab();
        else if (target.dataset.filepath) switchToFile(target.dataset.filepath);
        return;
    }

    const currentIndex = tabs.indexOf(activeTab);
    // 循環するようにインデックスを計算 (末尾→先頭、先頭→末尾)
    let nextIndex = (currentIndex + direction) % tabs.length;
    if (nextIndex < 0) nextIndex = tabs.length - 1;

    const targetTab = tabs[nextIndex];

    // タブの種類に応じて切り替え
    if (targetTab.id === 'tab-settings') {
        openSettingsTab();
    } else if (targetTab.dataset.filepath) {
        switchToFile(targetTab.dataset.filepath);
    }
}

async function saveCurrentFile(isSaveAs = false, targetPath = null) {
    const filePath = targetPath || currentFilePath;

    if (!filePath) {
        console.warn('ファイルが選択されていません');
        return;
    }

    let content;
    const fileData = openedFiles.get(currentFilePath);

    // コンテンツ取得ロジック
    if (fileData && fileData.type === 'diff') {
        // Diffモードの場合: MergeViewの右側(b)のエディタから内容を取得
        if (globalDiffView) {
            content = globalDiffView.b.state.doc.toString();
        } else {
            content = fileData.content;
        }
        // 保存先は仮想パス(DIFF://...)ではなく、実ファイルパスを使う
        if (!targetPath) targetPath = fileData.originalPath;

    } else if (targetPath && targetPath !== currentFilePath) {
        const targetFileData = openedFiles.get(targetPath);
        content = targetFileData ? targetFileData.content : null;
        if (!content) return;
    } else {
        // 通常モード
        if (!globalEditorView) return;
        content = globalEditorView.state.doc.toString();
    }

    if (currentFilePath === 'README.md') return;

    try {
        // ▼ 仮想ファイル（新規作成）または「名前を付けて保存」の場合
        if ((fileData && fileData.isVirtual && fileData.type !== 'diff') || isSaveAs) { // DiffはVirtualだが上書き保存扱いにするため除外

            let defaultSavePath = fileData ? fileData.fileName : 'Untitled.md';
            if (currentDirectoryPath && currentDirectoryPath !== '.') {
                try {
                    defaultSavePath = path.join(currentDirectoryPath, defaultSavePath);
                } catch (e) { }
            }

            const result = await window.electronAPI.showSaveDialog({
                defaultPath: defaultSavePath
            });

            if (result.canceled || !result.filePath) return;

            const newPath = result.filePath;
            const newName = path.basename(newPath);

            await window.electronAPI.saveFile(newPath, content);
            updateTabsAfterRename(currentFilePath, newPath, newName);

            const newFileData = openedFiles.get(newPath);
            if (newFileData) {
                newFileData.isVirtual = false;
                newFileData.content = content;
            }
            addToRecentFiles(newPath);
            showNotification(`ファイルを保存しました: ${newName}`, 'success');

        } else {
            // ▼ 既存ファイルの上書き保存 (Diff含む)
            // Diffモードの場合、targetPath (実パス) を使用する
            const savePath = (fileData && fileData.type === 'diff') ? targetPath : currentFilePath;

            if (typeof window.electronAPI?.saveFile === 'function') {
                await window.electronAPI.saveFile(savePath, content);

                if (fileData) {
                    fileData.content = content;
                }
                // Diffモードでない場合のみダーティフラグを消す（Diffの場合は比較しないと不明なため）
                if (fileData.type !== 'diff') {
                    fileModificationState.delete(currentFilePath);
                    const tab = document.querySelector(`[data-filepath="${CSS.escape(currentFilePath)}"]`);
                    if (tab) {
                        const fileName = path.basename(currentFilePath);
                        tab.innerHTML = `<span class="tab-filename">${fileName}</span> <span class="close-tab" data-filepath="${currentFilePath}}">×</span>`;
                    }
                }

                // showNotification('保存しました', 'success');
            }
        }
    } catch (error) {
        console.error('Failed to save file:', error);
        showNotification(`保存エラー: ${error.message}`, 'error');
    }
}

if (editorTabsContainer) {
    editorTabsContainer.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('.close-tab');
        const tabElement = e.target.closest('.tab');

        if (closeBtn && tabElement) {
            e.stopPropagation();
            if (tabElement.id === 'tab-settings') {
                closeTab(tabElement, true);
            } else if (tabElement.dataset.filepath) {
                closeTab(tabElement, false);
            }
        } else if (tabElement && !e.target.classList.contains('close-tab')) {
            if (tabElement.id === 'tab-settings') {
                openSettingsTab();
            } else if (tabElement.dataset.filepath) {
                switchToFile(tabElement.dataset.filepath);
            }
        }
    });
}

// ========== ファイルツリー操作 ==========

async function initializeFileTreeWithState() {
    const fileTreeContainer = document.getElementById('file-tree-container');
    if (!fileTreeContainer) return;

    const expandedPaths = new Set();
    const items = fileTreeContainer.querySelectorAll('.tree-item');
    items.forEach(item => {
        const toggle = item.querySelector('.tree-toggle');
        if (toggle && toggle.textContent === '▼' && item.nextElementSibling && item.nextElementSibling.style.display !== 'none') {
            expandedPaths.add(item.dataset.path);
        }
    });
    if (currentDirectoryPath) expandedPaths.add(currentDirectoryPath);

    await initializeFileTree();

    const sortedPaths = Array.from(expandedPaths).sort((a, b) => a.length - b.length);

    const newContainer = document.getElementById('file-tree-container');
    if (!newContainer) return;

    for (const path of sortedPaths) {
        const item = newContainer.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`);
        if (item) {
            const toggle = item.querySelector('.tree-toggle');
            if (toggle && toggle.textContent === '▶') {
                await toggleFolder(item);
            }
        }
    }

    // ツリー更新時にGitステータスも更新
    const gitContent = document.getElementById('content-git');
    if (gitContent && !gitContent.classList.contains('content-hidden')) {
        refreshGitStatus();
    }

    // --- ステータスバーのブランチ表示を更新 ---
    updateStatusBarGitInfo();

}

async function initializeFileTree() {
    try {
        if (typeof window.electronAPI?.getCurrentDirectory === 'function') {
            currentDirectoryPath = await window.electronAPI.getCurrentDirectory();
            // ディレクトリ取得時にデータ属性を更新
            updateCurrentDirData();
        } else {
            currentDirectoryPath = '.';
        }

        const fileTreeContainer = document.getElementById('file-tree-container');
        if (!fileTreeContainer) return;

        const newFileTreeContainer = fileTreeContainer.cloneNode(true);
        fileTreeContainer.parentNode.replaceChild(newFileTreeContainer, fileTreeContainer);

        const rootItem = newFileTreeContainer.querySelector('.tree-item.expanded');

        if (rootItem) {
            rootItem.dataset.path = currentDirectoryPath;
            const rootLabel = rootItem.querySelector('.tree-label');
            if (rootLabel) {
                const folderName = currentDirectoryPath.split(/[/\\]/).pop() || currentDirectoryPath;
                rootLabel.textContent = folderName;
            }
            const rootChildren = rootItem.nextElementSibling;
            if (rootChildren) rootChildren.innerHTML = '';
            await loadDirectoryTreeContents(rootItem, currentDirectoryPath);

            rootItem.addEventListener('dragover', handleDragOver);
            rootItem.addEventListener('dragleave', handleDragLeave);
            rootItem.addEventListener('drop', handleDrop);
        }

        newFileTreeContainer.addEventListener('dragover', handleDragOver);
        newFileTreeContainer.addEventListener('drop', handleDrop);

        newFileTreeContainer.addEventListener('click', (e) => {
            const item = e.target.closest('.tree-item');

            if (!item) {
                return;
            }

            if (item.classList.contains('creation-mode')) return;
            if (e.target.tagName.toLowerCase() === 'input') return;

            e.stopPropagation();

            newFileTreeContainer.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');

            if (item.classList.contains('file')) {
                openFile(item.dataset.path, item.dataset.name);
            } else {
                toggleFolder(item);
            }
        });

        newFileTreeContainer.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.tree-item');
            if (!item) return;
            if (item.classList.contains('creation-mode')) return;
            if (item.querySelector('input')) return;

            e.preventDefault();
            e.stopPropagation();

            newFileTreeContainer.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');

            showContextMenu(e.pageX, e.pageY, item.dataset.path, item.dataset.name);
        });

    } catch (error) {
        console.error('Failed to initialize file tree:', error);
    }
}

async function loadDirectoryTreeContents(folderElement, dirPath) {
    let childrenContainer = folderElement.nextElementSibling;
    if (!childrenContainer || !childrenContainer.classList.contains('tree-children')) {
        childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        folderElement.parentNode.insertBefore(childrenContainer, folderElement.nextSibling);
    }

    childrenContainer.innerHTML = '';

    const items = await getSortedDirectoryContents(dirPath);
    if (items && items.length > 0) {
        items.forEach(item => {
            const element = createTreeElement(item, dirPath);
            childrenContainer.appendChild(element);
        });
    }
}

async function toggleFolder(folderElement) {
    const toggle = folderElement.querySelector('.tree-toggle');
    if (!toggle) return;

    const folderPath = folderElement.dataset.path;
    const isExpanded = toggle.textContent === '▼';

    if (isExpanded) {
        toggle.textContent = '▶';
        const childrenContainer = folderElement.nextElementSibling;
        if (childrenContainer && childrenContainer.classList.contains('tree-children')) {
            childrenContainer.style.display = 'none';
        }
    } else {
        toggle.textContent = '▼';
        let childrenContainer = folderElement.nextElementSibling;
        if (!childrenContainer || !childrenContainer.classList.contains('tree-children')) {
            childrenContainer = document.createElement('div');
            childrenContainer.className = 'tree-children';
            folderElement.parentNode.insertBefore(childrenContainer, folderElement.nextSibling);
        }

        childrenContainer.style.display = 'block';

        await loadDirectoryTreeContents(folderElement, folderPath);
    }
}

async function reloadContainer(container, path) {
    container.innerHTML = '';
    const items = await getSortedDirectoryContents(path);
    items.forEach(item => {
        const element = createTreeElement(item, path);
        container.appendChild(element);
    });
}

async function getSortedDirectoryContents(dirPath) {
    let items = await readDirectory(dirPath);
    return items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
            return b.isDirectory ? 1 : -1;
        }
        const comparison = a.name.localeCompare(b.name);
        return currentSortOrder === 'asc' ? comparison : -comparison;
    });
}

async function readDirectory(dirPath) {
    try {
        if (typeof window.electronAPI?.readDirectory === 'function') {
            return await window.electronAPI.readDirectory(dirPath);
        } else {
            return [];
        }
    } catch (error) {
        console.error('Failed to read directory:', error);
        return [];
    }
}

function getFileIconData(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const iconMap = {
        'md': { text: 'M↓', color: '#519aba' },
        'markdown': { text: 'M↓', color: '#519aba' },
        'js': { text: 'JS', color: '#f1e05a' },
        'ts': { text: 'TS', color: '#2b7489' },
        'html': { text: '<>', color: '#e34c26' },
        'css': { text: '#', color: '#563d7c' },
        'json': { text: '{}', color: '#cbcb41' },
        'py': { text: 'Py', color: '#3572a5' },
        'java': { text: 'J', color: '#b07219' },
        'c': { text: 'C', color: '#555555' },
        'cpp': { text: '++', color: '#f34b7d' },
        'txt': { text: '≡', color: '#d4d4d4' },
        'gitignore': { text: 'git', color: '#f44d27' },
        'png': { text: 'img', color: '#b07219' },
        'jpg': { text: 'img', color: '#b07219' },
        'svg': { text: 'SVG', color: '#ff9900' }
    };
    return iconMap[ext] || { text: '📄', color: '#90a4ae' };
}

// ========== ドラッグ&ドロップ処理 ==========

function handleDragStart(e) {
    const item = e.target.closest('.tree-item');

    if (!item || !item.dataset.path || item.dataset.path === currentDirectoryPath) {
        e.preventDefault();
        return;
    }

    e.dataTransfer.setData('text/plain', item.dataset.path);
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
}

function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();

    const targetItem = e.target.closest('.tree-item');
    if (targetItem) {
        if (!targetItem.classList.contains('file')) {
            targetItem.classList.add('drag-over');
            e.dataTransfer.dropEffect = 'move';
        } else {
            e.dataTransfer.dropEffect = 'none';
        }
    } else {
        e.dataTransfer.dropEffect = 'move';
    }
}

function handleDragLeave(e) {
    const targetItem = e.target.closest('.tree-item');
    if (targetItem) {
        targetItem.classList.remove('drag-over');
    }
}

async function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();

    const targetItem = e.target.closest('.tree-item');
    if (targetItem) targetItem.classList.remove('drag-over');

    const srcPath = e.dataTransfer.getData('text/plain');
    if (!srcPath) return;

    let destFolderPath;

    if (targetItem) {
        if (targetItem.classList.contains('file')) return;
        destFolderPath = targetItem.dataset.path;
    } else {
        destFolderPath = currentDirectoryPath;
    }

    if (!destFolderPath) return;

    if (srcPath === destFolderPath) return;

    const fileName = srcPath.split(/[/\\]/).pop();

    const destSep = destFolderPath.includes('\\') ? '\\' : '/';

    let destPath = destFolderPath;
    if (!destPath.endsWith(destSep)) {
        destPath += destSep;
    }
    destPath += fileName;

    if (srcPath !== destPath) {
        try {
            if (typeof window.electronAPI?.moveFile === 'function') {
                const result = await window.electronAPI.moveFile(srcPath, destPath);
                if (result.success) {
                    showNotification(`移動しました: ${fileName}`, 'success');
                } else {
                    showNotification(`移動に失敗しました: ${result.error}`, 'error');
                }
            }
        } catch (error) {
            console.error('Move failed:', error);
            showNotification(`エラーが発生しました: ${error.message}`, 'error');
        }
    }
}

function createTreeElement(item, parentPath) {
    const itemPath = item.path || `${parentPath}/${item.name}`;

    const container = document.createElement('div');
    container.className = 'tree-item' + (item.isDirectory ? '' : ' file');
    container.dataset.path = itemPath;
    container.dataset.name = item.name;

    container.draggable = true;
    container.addEventListener('dragstart', handleDragStart);
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('dragleave', handleDragLeave);
    container.addEventListener('drop', handleDrop);

    if (item.isDirectory) {
        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle';
        toggle.textContent = '▶';
        container.appendChild(toggle);
    }

    const icon = document.createElement('span');
    icon.className = 'tree-icon';

    if (item.isDirectory) {
        icon.textContent = '📁';
        icon.style.color = '#dcb67a';
    } else {
        const iconData = getFileIconData(item.name);
        icon.textContent = iconData.text;
        icon.style.color = iconData.color;
        icon.classList.add('file-icon-styled');
    }

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = item.name;

    container.appendChild(icon);
    container.appendChild(label);

    return container;
}

// ========== 新規作成機能 ==========
async function showCreationInput(isFolder) {
    const fileTree = document.getElementById('file-tree-container');
    let targetContainer = null;
    let targetPath = currentDirectoryPath;

    const selectedItem = fileTree.querySelector('.tree-item.selected');

    if (selectedItem) {
        const path = selectedItem.dataset.path;
        const isDir = !selectedItem.classList.contains('file');

        if (isDir) {
            targetPath = path;
            const toggle = selectedItem.querySelector('.tree-toggle');
            if (toggle.textContent === '▶') {
                await toggleFolder(selectedItem);
            }
            targetContainer = selectedItem.nextElementSibling;
        } else {
            targetContainer = selectedItem.parentNode;
            const parentFolderItem = targetContainer.previousElementSibling;
            if (parentFolderItem && parentFolderItem.classList.contains('tree-item')) {
                targetPath = parentFolderItem.dataset.path;
            }
        }
    } else {
        const rootItem = fileTree.querySelector('.tree-item.expanded');
        if (rootItem) {
            targetPath = rootItem.dataset.path;
            targetContainer = rootItem.nextElementSibling;
        }
    }

    if (!targetContainer) return;

    const inputDiv = document.createElement('div');
    inputDiv.className = 'tree-item creation-mode';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'tree-icon';
    iconSpan.textContent = isFolder ? '📁' : '📄';

    const inputField = document.createElement('input');
    inputField.type = 'text';
    inputField.className = 'creation-input';
    inputField.placeholder = isFolder ? 'フォルダ名' : 'ファイル名.md';

    inputDiv.appendChild(iconSpan);
    inputDiv.appendChild(inputField);

    if (targetContainer.firstChild) {
        targetContainer.insertBefore(inputDiv, targetContainer.firstChild);
    } else {
        targetContainer.appendChild(inputDiv);
    }

    inputField.focus();

    let isCreating = false;

    const safeRemove = () => {
        if (inputDiv && inputDiv.parentNode) {
            inputDiv.remove();
        }
        if (globalEditorView) globalEditorView.focus();
    };

    const finishCreation = async () => {
        if (isCreating) return;
        isCreating = true;

        const name = inputField.value.trim();
        if (!name) {
            safeRemove();
            isCreating = false;
            return;
        }

        // path.joinを使用してパスを正しく結合
        const newPath = path.join(targetPath, name);

        try {
            if (isFolder) {
                if (typeof window.electronAPI?.createDirectory === 'function') {
                    await window.electronAPI.createDirectory(newPath);
                }
            } else {
                if (typeof window.electronAPI?.saveFile === 'function') {
                    await window.electronAPI.saveFile(newPath, '');
                }
            }

            safeRemove();
            await reloadContainer(targetContainer, targetPath);

            if (!isFolder) {
                // 新規作成したファイルを開く（正規化されたパスが渡される）
                openFile(newPath, name);
            }

        } catch (e) {
            console.error(e);
            safeRemove();
        } finally {
            isCreating = false;
        }
    };

    // ファイル名バリデーション
    const validateFileName = () => {
        const name = inputField.value.trim();

        if (!name) return null;

        // 不正な文字/形式チェック
        // .で終わる、.のみ、..のみなどは禁止
        if (name === '.' || name === '..' || name.endsWith('.')) {
            return "ファイル名は不正です（末尾にドットは使用できません）";
        }

        // 禁止文字チェック (Windows/Linux/Mac共通の一般的な禁止文字)
        if (/[\\/:*?"<>|]/.test(name)) {
            return "次の文字は使用できません: \\ / : * ? \" < > |";
        }

        // 同名ファイルチェック
        // targetContainerは現在表示中のフォルダの中身なので、DOMから既存の名前を探す
        // 直下の子要素のみ対象とする
        if (targetContainer) {
            const siblings = Array.from(targetContainer.querySelectorAll(':scope > .tree-item:not(.creation-mode)'));
            const exists = siblings.some(item => item.dataset.name === name);
            if (exists) {
                return `「${name}」は既に存在します。別の名前を指定してください。`;
            }
        }

        return null;
    };

    // リアルタイムバリデーション
    inputField.addEventListener('input', () => {
        const error = validateFileName();
        if (error) {
            inputField.style.borderColor = '#e81123'; // エラー色(赤)
            inputField.title = error; // ツールチップで理由表示
        } else {
            inputField.style.borderColor = ''; // デフォルトに戻す
            inputField.title = '';
        }
    });

    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();

            const error = validateFileName();
            if (error) {
                // エラーがある場合はトースト通知を出して中断
                showNotification(error, 'error');
                // 入力欄にフォーカスを戻す（念のため）
                inputField.focus();
                return;
            }

            finishCreation();
        } else if (e.key === 'Escape') {
            if (!isCreating) safeRemove();
        }
    });

    inputField.addEventListener('blur', () => {
        if (!isCreating) {
            // バリデーションチェックしてから実行
            const name = inputField.value.trim();
            if (name && !validateFileName()) {
                finishCreation();
            } else {
                setTimeout(safeRemove, 100);
            }
        }
    });
}

const btnOpenFolder = document.getElementById('btn-open-folder');
if (btnOpenFolder) {
    btnOpenFolder.addEventListener('click', async () => {
        try {
            if (typeof window.electronAPI?.selectFolder !== 'function') return;
            const result = await window.electronAPI.selectFolder();
            if (result.success && result.path) {
                await initializeFileTree();

                // フォルダ切替時にステータスバーのGit情報を更新
                updateStatusBarGitInfo();

                // Gitパネルが表示されている場合はGitステータスも更新
                const gitContent = document.getElementById('content-git');
                if (gitContent && !gitContent.classList.contains('content-hidden')) {
                    if (typeof refreshGitStatus === 'function') {
                        refreshGitStatus();
                    }
                }

            }
        } catch (error) {
            console.error('Failed to open folder:', error);
        }
    });
}

if (document.getElementById('btn-new-file')) {
    document.getElementById('btn-new-file').addEventListener('click', () => showCreationInput(false));
}

if (document.getElementById('btn-new-folder')) {
    document.getElementById('btn-new-folder').addEventListener('click', () => showCreationInput(true));
}

// ========== ウィンドウズーム調整用ヘルパー ==========
function adjustWindowZoom(delta) {
    const currentZoom = webFrame.getZoomLevel();
    webFrame.setZoomLevel(currentZoom + delta);
}

// ========== フォントサイズ調整用ヘルパー ==========
function adjustFontSize(delta) {

    // deltaが0の場合はリセット処理
    if (delta === 0) {
        appSettings.fontSize = '16px';
        saveSettings();
        applySettingsToUI();
        updateEditorSettings();
        return;
    }

    const currentSize = parseInt(appSettings.fontSize);
    if (isNaN(currentSize)) return;

    let newSize = currentSize + delta;
    if (newSize < 8) newSize = 8; // Min size
    if (newSize > 64) newSize = 64; // Max size

    appSettings.fontSize = `${newSize}px`;

    // UI反映
    saveSettings();
    applySettingsToUI();
    updateEditorSettings();

}

// ========== ショートカットキーと削除機能 ==========
document.addEventListener('keydown', (e) => {
    // 入力フォームや記録モード中は無視
    if (isRecordingKey) return;
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    // テキスト入力中は、修飾キーなしのショートカットを無視（文字入力と競合するため）
    if ((activeTag === 'input' || activeTag === 'textarea') && !e.ctrlKey && !e.metaKey && !e.altKey) return;

    // 現在のキーイベントを正規化 (Mod-s 等)
    const parts = [];
    if (e.metaKey || e.ctrlKey) parts.push('Mod');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    let keyChar = e.key;

    // 特殊キーの名称統一 (CodeMirrorの形式に合わせる)
    if (keyChar === ' ') keyChar = 'Space';
    else if (keyChar === 'ArrowUp') keyChar = 'ArrowUp';
    else if (keyChar === 'ArrowDown') keyChar = 'ArrowDown';
    else if (keyChar === 'ArrowLeft') keyChar = 'ArrowLeft';
    else if (keyChar === 'ArrowRight') keyChar = 'ArrowRight';
    else if (keyChar === 'Escape') keyChar = 'Escape';
    else if (keyChar === 'Tab') keyChar = 'tab'; // Tabキーを小文字の 'tab' に統一
    else if (keyChar.length === 1) keyChar = keyChar.toLowerCase(); // アルファベットは小文字に

    // 修飾キー単体の場合は無視
    if (['control', 'shift', 'alt', 'meta'].includes(keyChar.toLowerCase())) return;

    parts.push(keyChar);
    const currentKeyStr = parts.join('-');

    // グローバルコマンドのマッチングと実行
    const matchedCommand = COMMANDS_REGISTRY.find(cmd => {
        // グローバルコンテキストのコマンドのみ対象
        if (cmd.context !== 'global') return false;

        // 配列対応版のヘルパー関数を使って設定を取得
        const keys = getKeybindingsForCommand(cmd.id);

        // 入力されたキーが、設定されたキー配列の中に含まれているかチェック
        return keys.includes(currentKeyStr);
    });

    if (matchedCommand) {
        e.preventDefault();
        console.log('Execute Global Command:', matchedCommand.id);
        matchedCommand.run();
    }
});

async function confirmAndDelete(path) {
    try {
        if (typeof window.electronAPI?.deleteFile === 'function') {
            const success = await window.electronAPI.deleteFile(path);

            if (success) {
                const tabsToClose = [];

                for (const [filePath, _] of openedFiles) {
                    if (filePath === path ||
                        filePath.startsWith(path + '\\') ||
                        filePath.startsWith(path + '/')) {
                        tabsToClose.push(filePath);
                    }
                }

                tabsToClose.forEach(filePath => {
                    const tab = document.querySelector(`[data-filepath="${CSS.escape(filePath)}"]`);
                    if (tab) {
                        closeTab(tab, false);
                    }
                });

                // Recent Filesリストからも削除して保存・再描画
                recentFiles = recentFiles.filter(item => item.path !== path);
                saveRecentFiles();
                if (document.getElementById('content-recent') && !document.getElementById('content-recent').classList.contains('content-hidden')) {
                    renderRecentFiles();
                }

                showNotification('ゴミ箱に移動しました', 'success');
            } else {
                showNotification('ファイルの削除に失敗しました（ファイルが見つからない可能性があります）', 'error');
            }
        }
    } catch (error) {
        console.error('Delete failed:', error);
        showNotification(`削除エラー: ${error.message}`, 'error');
    }
}

// ========== CSS Snippets Logic ==========
/**
 * 有効化されているCSSスニペットの内容をDOMから取得して結合する
 */
function getActiveCssContent() {
    if (!appSettings || !appSettings.enabledSnippets) return '';

    let cssContent = '';
    appSettings.enabledSnippets.forEach(filename => {
        const styleId = `snippet-style-${filename}`;
        const styleTag = document.getElementById(styleId);
        if (styleTag) {
            cssContent += styleTag.textContent + '\n';
        }
    });
    return cssContent;
}
/**
 * スニペットリストを描画し、現在の設定に基づいてトグル状態を反映する
 */
async function renderCssSnippetsList() {
    const listContainer = document.getElementById('css-snippets-list');
    if (!listContainer) return;

    listContainer.innerHTML = ''; // クリア

    try {
        const files = await window.electronAPI.getCssSnippets();

        if (files.length === 0) {
            listContainer.innerHTML = '<div style="font-size:12px; color:#888; text-align:center; padding:10px;">スニペットがありません。<br>フォルダを開いて.cssファイルを追加してください。</div>';
            return;
        }

        files.forEach(filename => {
            const isEnabled = appSettings.enabledSnippets && appSettings.enabledSnippets.includes(filename);

            const item = document.createElement('div');
            item.className = 'snippet-item';

            item.innerHTML = `
                <div class="snippet-info">
                    <span class="snippet-name">${filename}</span>
                </div>
                <label class="snippet-toggle">
                    <input type="checkbox" ${isEnabled ? 'checked' : ''}>
                    <span class="snippet-slider"></span>
                </label>
            `;

            const checkbox = item.querySelector('input');
            checkbox.addEventListener('change', async (e) => {
                await toggleSnippet(filename, e.target.checked);
            });

            listContainer.appendChild(item);

            // 起動時やリロード時に、有効なものはCSSを適用する
            if (isEnabled) {
                applyCssSnippet(filename);
            }
        });

    } catch (e) {
        console.error('Error rendering snippets:', e);
    }
}

/**
 * スニペットの有効/無効を切り替えて設定を保存する
 */
async function toggleSnippet(filename, enabled) {
    if (!appSettings.enabledSnippets) appSettings.enabledSnippets = [];

    if (enabled) {
        if (!appSettings.enabledSnippets.includes(filename)) {
            appSettings.enabledSnippets.push(filename);
        }
        await applyCssSnippet(filename);
    } else {
        appSettings.enabledSnippets = appSettings.enabledSnippets.filter(f => f !== filename);
        removeCssSnippet(filename);
    }

    saveSettings();
}

/**
 * CSSファイルの内容を読み込んで <style> タグとして注入する
 */
async function applyCssSnippet(filename) {
    const styleId = `snippet-style-${filename}`;

    // 既に適用済みなら中身を更新する（再読み込み対応）
    let styleTag = document.getElementById(styleId);

    try {
        const cssContent = await window.electronAPI.readCssSnippet(filename);

        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = styleId;
            document.head.appendChild(styleTag);
        }

        styleTag.textContent = cssContent;
        console.log(`Applied snippet: ${filename}`);

    } catch (e) {
        console.error(`Failed to apply snippet ${filename}:`, e);
    }
}

/**
 * 注入された <style> タグを削除する
 */
function removeCssSnippet(filename) {
    const styleId = `snippet-style-${filename}`;
    const styleTag = document.getElementById(styleId);
    if (styleTag) {
        styleTag.remove();
        console.log(`Removed snippet: ${filename}`);
    }
}

/**
 * 全スニペットの再読み込み（リロードボタン用）
 */
async function reloadAllSnippets() {
    // 一旦全ての適用済みスタイルを削除（または更新）してもよいが、
    // ここではリストを再描画し、有効なものを再注入する
    await renderCssSnippetsList();
    showNotification('スニペットリストを更新しました', 'success');
}

/**
 * スニペット機能のイベントリスナー設定
 */
function setupSnippetEvents() {
    const btnReload = document.getElementById('btn-reload-snippets');
    const btnOpenFolder = document.getElementById('btn-open-snippets-folder');

    if (btnReload) {
        btnReload.addEventListener('click', reloadAllSnippets);
    }

    if (btnOpenFolder) {
        btnOpenFolder.addEventListener('click', () => {
            window.electronAPI.openSnippetsFolder();
        });
    }

    // 設定画面のナビゲーションで「外観」が選ばれたときにリストを更新するようにする
    const appearanceNav = document.querySelector('.settings-nav-item[data-section="appearance"]');
    if (appearanceNav) {
        appearanceNav.addEventListener('click', () => {
            renderCssSnippetsList();
        });
    }
}

// ドロップダウンメニューの位置調整関数
function setupToolbarDropdownPositioning() {
    const containers = document.querySelectorAll('.toolbar-dropdown-container');

    containers.forEach(container => {
        const menu = container.querySelector('.toolbar-icon-menu');
        if (!menu) return;

        // マウスが入った時：強制的に最前面(fixed)に配置し直す
        container.addEventListener('mouseenter', () => {
            const rect = container.getBoundingClientRect();
            const windowWidth = window.innerWidth;

            // 親要素の overflow: hidden を突破するために fixed に設定
            menu.style.position = 'fixed';
            menu.style.top = `${rect.bottom + 2}px`; // ボタンの少し下
            menu.style.zIndex = '9999'; // 最前面に表示
            menu.style.marginTop = '0'; // 既存の余白をリセット

            // 画面の右半分にある場合は「右揃え」にする
            if (rect.left > windowWidth / 2) {
                menu.style.left = 'auto';
                menu.style.right = `${windowWidth - rect.right}px`;
            } else {
                menu.style.left = `${rect.left}px`;
                menu.style.right = 'auto';
            }
        });

        // マウスが出た時：スタイルをリセットして元の状態に戻す
        container.addEventListener('mouseleave', () => {
            menu.style.position = '';
            menu.style.top = '';
            menu.style.left = '';
            menu.style.right = '';
            menu.style.zIndex = '';
            menu.style.marginTop = '';
        });
    });
}

// ========== 共通コンテキストメニュー・ヘルパー ==========
const ContextMenu = {
    // メニューを表示する汎用関数
    show(x, y, items) {
        // 既存のメニューがあれば閉じる（activeContextMenuはグローバル変数として想定）
        if (activeContextMenu) activeContextMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'context-menu'; // styles.css のスタイルを適用
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        items.forEach(item => {
            // セパレータの場合
            if (item.type === 'separator') {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                menu.appendChild(sep);
                return;
            }

            // 通常の項目の場合
            const div = document.createElement('div');
            div.className = 'context-menu-item';

            // ラベル
            const labelSpan = document.createElement('span');
            labelSpan.textContent = item.label;
            div.appendChild(labelSpan);

            // ショートカットキー（あれば）
            if (item.shortcut) {
                const scSpan = document.createElement('span');
                scSpan.className = 'context-menu-shortcut';
                scSpan.textContent = item.shortcut;
                div.appendChild(scSpan);
            }

            // クリックイベント
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                this.close(); // 実行後に閉じる
                if (item.click) item.click();
            });

            menu.appendChild(div);
        });

        document.body.appendChild(menu);
        activeContextMenu = menu; // グローバル変数にセット
    },

    // メニューを閉じる関数
    close() {
        if (activeContextMenu) {
            activeContextMenu.remove();
            activeContextMenu = null;
        }
    }
};

// ---------------------------------------------------------
// 各機能ごとのメニュー定義（ContextMenu.show を呼び出すだけにする）
// ---------------------------------------------------------

// 1. ファイルツリーの項目メニュー
function showContextMenu(x, y, itemPath, name) {
    ContextMenu.show(x, y, [
        {
            label: '名前の変更', click: () => {
                const treeItem = document.querySelector(`.tree-item[data-path="${CSS.escape(itemPath)}"]`);
                if (treeItem) startRenaming(treeItem);
            }
        },
        { label: '削除', click: () => confirmAndDelete(itemPath) },
        { type: 'separator' },
        {
            label: '相対パスをコピー', click: () => {
                const relPath = path.relative(currentDirectoryPath, itemPath);
                navigator.clipboard.writeText(relPath);
                showNotification('相対パスをコピーしました', 'success');
            }
        },
        {
            label: '絶対パスをコピー', click: () => {
                navigator.clipboard.writeText(itemPath);
                showNotification('絶対パスをコピーしました', 'success');
            }
        },
        { label: 'エクスプローラーで表示', click: () => window.electronAPI.showItemInFolder(itemPath) }
    ]);
}

// 2. ファイルツリーの空白部分メニュー
function showEmptySpaceContextMenu(x, y) {
    ContextMenu.show(x, y, [
        { label: '新規ファイル', click: () => showCreationInput(false) },
        { label: '新規フォルダ', click: () => showCreationInput(true) },
        { type: 'separator' },
        {
            label: '相対パスをコピー', click: () => {
                navigator.clipboard.writeText('.');
                showNotification('相対パス(.)をコピーしました', 'success');
            }
        },
        {
            label: '絶対パスをコピー', click: () => {
                navigator.clipboard.writeText(currentDirectoryPath);
                showNotification('絶対パスをコピーしました', 'success');
            }
        },
        { label: 'エクスプローラーで開く', click: () => window.electronAPI.openPath(currentDirectoryPath) }
    ]);
}

// 3. エディタ用カスタムコンテキストメニュー
function showEditorContextMenu(x, y) {
    if (activeContextMenu) activeContextMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    // 通常アイテム作成ヘルパー
    const createItem = (label, onClick, shortcut = "") => {
        const item = document.createElement('div');
        item.className = 'context-menu-item';

        const labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        item.appendChild(labelSpan);

        if (shortcut) {
            const scSpan = document.createElement('span');
            scSpan.className = 'context-menu-shortcut';
            scSpan.textContent = shortcut;
            item.appendChild(scSpan);
        }

        item.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            activeContextMenu = null;
            onClick();
            globalEditorView.focus();
        });
        return item;
    };

    // サブメニュー作成ヘルパー
    const createSubmenu = (label, subItems) => {
        const item = document.createElement('div');
        item.className = 'context-menu-item';
        item.innerHTML = `<span>${label}</span><span class="submenu-arrow">▶</span>`;

        const submenu = document.createElement('div');
        submenu.className = 'context-submenu';

        subItems.forEach(sub => {
            const subItem = document.createElement('div');
            subItem.className = 'context-menu-item';

            // 色プレビューがあれば表示
            let contentHtml = '';
            if (sub.color) {
                contentHtml += `<span class="color-preview-dot" style="background-color: ${sub.color};"></span>`;
            }
            contentHtml += `<span>${sub.label}</span>`;

            subItem.innerHTML = contentHtml;
            subItem.style.display = 'flex';
            subItem.style.alignItems = 'center';

            subItem.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.remove();
                activeContextMenu = null;
                sub.click();
                globalEditorView.focus();
            });
            submenu.appendChild(subItem);
        });

        item.appendChild(submenu);
        return item;
    };

    const createSeparator = () => {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        return sep;
    };

    // --- メニュー構成 ---

    // 編集操作
    menu.appendChild(createItem('カット', async () => {
        const sel = globalEditorView.state.selection.main;
        if (!sel.empty) {
            const text = globalEditorView.state.sliceDoc(sel.from, sel.to);
            await navigator.clipboard.writeText(text);
            globalEditorView.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" } });
        }
    }, 'Ctrl+X'));

    menu.appendChild(createItem('コピー', async () => {
        const sel = globalEditorView.state.selection.main;
        if (!sel.empty) {
            const text = globalEditorView.state.sliceDoc(sel.from, sel.to);
            await navigator.clipboard.writeText(text);
        }
    }, 'Ctrl+C'));

    menu.appendChild(createItem('ペースト', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) globalEditorView.dispatch(globalEditorView.state.replaceSelection(text));
        } catch (e) { }
    }, 'Ctrl+V'));

    menu.appendChild(createSeparator());

    menu.appendChild(createItem('すべてを選択', () => {
        const { selectAll } = require("@codemirror/commands");
        selectAll(globalEditorView);
    }, 'Ctrl+A'));

    menu.appendChild(createSeparator());

    // 挿入・装飾
    menu.appendChild(createItem('太字', () => toggleMark(globalEditorView, '**'), 'Ctrl+B'));
    menu.appendChild(createItem('表の挿入', () => insertTable(globalEditorView)));
    menu.appendChild(createItem('コードブロック', () => insertCodeBlock(globalEditorView)));

    menu.appendChild(createSeparator());

    // ハイライト（サブメニュー化）
    menu.appendChild(createSubmenu('ハイライト', [
        { label: '黄色', color: '#fff700', click: () => toggleHighlightColor(globalEditorView, '#fff700') },
        { label: '赤色', color: '#ffcccc', click: () => toggleHighlightColor(globalEditorView, '#ffcccc') },
        { label: '青色', color: '#ccf0ff', click: () => toggleHighlightColor(globalEditorView, '#ccf0ff') },
        { label: '緑色', color: '#ccffcc', click: () => toggleHighlightColor(globalEditorView, '#ccffcc') }
    ]));

    document.body.appendChild(menu);
    activeContextMenu = menu;
}

// 4. Git履歴のメニュー
function showCommitContextMenu(x, y, commit) {
    ContextMenu.show(x, y, [
        {
            label: 'このコミットをチェックアウト', click: async () => {
                showNotification(`コミット ${commit.oid.substring(0, 7)} をチェックアウト中...`, 'info');
                try {
                    const result = await window.electronAPI.gitCheckout(currentDirectoryPath, commit.oid);
                    if (result.success) {
                        showNotification('チェックアウト完了', 'success');
                        refreshGitStatus();
                        initializeFileTreeWithState();
                    } else {
                        showNotification(`エラー: ${result.error}`, 'error');
                    }
                } catch (e) { showNotification(`エラー: ${e.message}`, 'error'); }
            }
        },
        { type: 'separator' },
        {
            label: '現在のブランチをここにリセット (Hard)', click: () => {
                const message = `コミット ${commit.oid.substring(0, 7)} へ強制的にリセットしますか？ (変更は破棄されます)`;
                showCompactConfirmModal(message, async () => {
                    try {
                        const result = await window.electronAPI.gitResetHead(currentDirectoryPath, commit.oid);
                        if (result.success) {
                            showNotification('リセット完了', 'success');
                            refreshGitStatus();
                            initializeFileTreeWithState();
                        } else { showNotification(`エラー: ${result.error}`, 'error'); }
                    } catch (e) { showNotification(`エラー: ${e.message}`, 'error'); }
                });
            }
        },
        {
            label: 'このコミットを打ち消し (Revert)', click: () => {
                const message = `コミット ${commit.oid.substring(0, 7)} を打ち消すコミットを作成しますか？`;
                showCompactConfirmModal(message, async () => {
                    try {
                        const result = await window.electronAPI.gitRevertCommit(currentDirectoryPath, commit.oid);
                        if (result.success) {
                            showNotification('打ち消しコミットを作成しました', 'success');
                            refreshGitStatus();
                        } else { showNotification(`エラー: ${result.error}`, 'error'); }
                    } catch (e) { showNotification(`エラー: ${e.message}`, 'error'); }
                });
            }
        },
        { type: 'separator' },
        {
            label: 'コミットハッシュをコピー', click: () => {
                navigator.clipboard.writeText(commit.oid);
                showNotification('ハッシュをコピーしました', 'success');
            }
        }
    ]);
}

// [renderer.js] 末尾に追加

/**
 * 外部変更を検知した際の分岐処理
 */
async function checkExternalFileChange(filePath) {
    // 既に別のファイルに切り替わっていたら無視
    if (currentFilePath !== filePath) return;

    // ファイルが存在するか確認 (削除された場合は何もしないか、別途閉じる処理が必要だが今回は無視)
    // ※ Electronのfsモジュール経由で確認したいが、ここでは簡易的に読み込み試行で代用

    const isDirty = fileModificationState.get(filePath);

    if (!isDirty) {
        // パターンA: 未編集 (Clean) -> 自動リロード
        console.log('Auto-reloading external changes...');
        await reloadFileFromDisk(filePath);
    } else {
        // パターンB: 編集済み (Dirty) -> 警告ダイアログ
        // モーダルが既に表示されていないかチェック
        if (!document.querySelector('.external-change-modal')) {
            showExternalChangeModal(filePath);
        }
    }
}

/**
 * ディスクからファイルを再読み込みし、カーソル位置を維持する (修正版)
 */
async function reloadFileFromDisk(filePath) {
    if (!globalEditorView) return;

    try {
        // 1. ディスクから最新の内容を読み込む
        const newContent = await window.electronAPI.loadFile(filePath);

        // 現在のエディタの内容と比較し、同じなら何もしない (自分の保存による検知を無視)
        const currentContent = globalEditorView.state.doc.toString();
        if (newContent === currentContent) {
            console.log('Content match, skipping reload.');
            return;
        }

        // 2. 現在のカーソル位置を保存
        const currentSelection = globalEditorView.state.selection;

        // 3. エディタの内容を更新
        const transaction = {
            changes: { from: 0, to: globalEditorView.state.doc.length, insert: newContent },
            selection: currentSelection, // カーソル位置の復元
            scrollIntoView: true,
            annotations: ExternalChange.of(true) // 外部変更としてマーク
        };

        globalEditorView.dispatch(transaction);

        // 内部データの更新
        const fileData = openedFiles.get(filePath);
        if (fileData) {
            fileData.content = newContent;
        }

        updateFileStats();

        // 本当に外部からの変更があった場合のみ通知
        showNotification('ファイルを再読み込みしました', 'info');

    } catch (e) {
        console.error('Auto-reload failed:', e);
    }
}

/**
 * 外部変更競合時の警告モーダル
 */
function showExternalChangeModal(filePath) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay external-change-modal'; // 重複防止用クラス

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '500px';
    content.style.borderLeft = '5px solid #e81123'; // 警告色

    const title = document.createElement('h3');
    title.textContent = '外部での変更を検知';
    title.style.marginTop = '0';
    title.style.color = '#e81123';

    const message = document.createElement('div');
    message.className = 'modal-message';
    message.innerHTML = `
        ファイル <strong>${path.basename(filePath)}</strong> が外部で変更されましたが、<br>
        このエディタ内に<strong>未保存の変更</strong>があります。<br><br>
        どうしますか？
    `;

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';
    buttons.style.justifyContent = 'flex-end';
    buttons.style.gap = '10px';

    // ボタン1: ディスクの内容を読み込む (破棄)
    const btnReload = document.createElement('button');
    btnReload.className = 'modal-btn';
    btnReload.textContent = 'ディスクの内容を読み込む (変更を破棄)';
    btnReload.style.backgroundColor = '#d9534f';
    btnReload.style.color = 'white';
    btnReload.style.border = 'none';

    btnReload.onclick = async () => {
        overlay.remove();
        // ダーティフラグを消してからリロード
        fileModificationState.delete(filePath);
        // タブの●マークを消す
        const tab = document.querySelector(`[data-filepath="${CSS.escape(filePath)}"]`);
        if (tab) {
            const fileName = path.basename(filePath);
            tab.innerHTML = `<span class="tab-filename">${fileName}</span> <span class="close-tab" data-filepath="${filePath}">×</span>`;
        }
        await reloadFileFromDisk(filePath);
    };

    // ボタン2: 自分の変更を維持
    const btnKeep = document.createElement('button');
    btnKeep.className = 'modal-btn primary';
    btnKeep.textContent = '自分の変更を維持';

    btnKeep.onclick = () => {
        overlay.remove();
        // 何もしない（後でユーザーがCtrl+Sを押せば上書き保存される）
        showNotification('変更を維持しました。上書き保存可能です。', 'info');
    };

    buttons.appendChild(btnReload);
    buttons.appendChild(btnKeep);

    content.appendChild(title);
    content.appendChild(message);
    content.appendChild(buttons);
    overlay.appendChild(content);
    document.body.appendChild(overlay);
}

document.addEventListener('click', () => {
    ContextMenu.close();
});