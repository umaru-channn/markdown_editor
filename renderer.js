/**
 * Markdown Editor - Main Renderer Process
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
const { EditorState, Prec, Compartment, Annotation, RangeSetBuilder, StateField, StateEffect } = require("@codemirror/state");
const { EditorView, keymap, highlightActiveLine, lineNumbers, drawSelection, dropCursor, MatchDecorator, ViewPlugin, Decoration, WidgetType } = require("@codemirror/view");
const { defaultKeymap, history, historyKeymap, undo, redo, indentMore, indentLess } = require("@codemirror/commands");
const { syntaxHighlighting, defaultHighlightStyle, indentUnit, syntaxTree, bracketMatching } = require("@codemirror/language");
const { oneDark } = require("@codemirror/theme-one-dark");
const { closeBrackets, autocompletion } = require("@codemirror/autocomplete");
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

// --- タブ可視化用のカスタムプラグイン ---
const tabMatcher = new MatchDecorator({
    regexp: /\t/g, // タブ文字にマッチ
    decoration: (match) => Decoration.mark({
        class: "cm-highlightTab"
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

// --- タブ可視化用のViewPlugin ---
const customHighlightTab = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = tabMatcher.createDeco(view);
    }
    update(update) {
        this.decorations = tabMatcher.updateDeco(update, this.decorations);
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
const resizerEditorSplit = document.getElementById('resizer-editor-split');

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
const fileTitleInputSplit = document.getElementById('file-title-input-split');

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
let isBacklinksVisible = false; // バックリンクパネルの表示状態
let isResizingEditorSplit = false;
let activeEditorView = null;
let activeCustomLinkId = null; // 現在表示中のカスタムリンクID
let isPreviewMode = false; // プレビューモードの状態
let splitLayoutRatio = 0.5; // エディタとプレビューの分割比率 (初期値50%)
let commandPalette;

// 言語状態を管理するフィールド
const currentLanguageField = StateField.define({
    create() { return 'markdown'; },
    update(value, tr) { return value; }
});

// ファイルパスからPrism言語IDを取得するヘルパー
function getPrismLanguageFromPath(filePath) {
    if (!filePath) return 'markdown';
    if (filePath === 'StartPage') return 'markdown';
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
        'scala': 'scala', 'bf': 'brainfuck', 'ws': 'whitespace',
        'txt': 'markdown'
    };

    return langMap[ext] || 'text';
}

// スニペットの初期値を定数として定義
const DEFAULT_SNIPPETS = [
    { trigger: ";date", replacement: "{{date}}", label: "今日の日付 (YYYY-MM-DD)" },
    { trigger: ";time", replacement: "{{time}}", label: "現在の時刻 (HH:mm)" },
    { trigger: ";datetime", replacement: "{{date}} {{time}}", label: "日時" },
    { trigger: ";todo", replacement: "- [ ] ", label: "TODOボックス" },
    { trigger: ";note", replacement: "> 📝 **Note:** ", label: "ノート修飾" }
];

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
    textSnippets: [...DEFAULT_SNIPPETS],
    enabledSnippets: [],
    customLinks: [], // { id, name, url, icon }
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

// スニペットの動的置換処理
function getDynamicReplacement(text) {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const yyyy = now.getFullYear();
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const HH = pad(now.getHours());
    const MM = pad(now.getMinutes());

    return text
        .replace(/{{date}}/g, `${yyyy}-${mm}-${dd}`)
        .replace(/{{time}}/g, `${HH}:${MM}`);
}

// スニペット補完プロバイダ
function textSnippetCompletion(context) {
    // 入力中の単語を取得 (セミコロン等も含む)
    let word = context.matchBefore(/\S+/);
    if (!word) return null;
    if (word.from == word.to && !context.explicit) return null;

    const snippets = appSettings.textSnippets || [];

    // トリガーが一致する（または前方一致する）ものを候補にする
    const options = snippets
        .filter(s => s.trigger.startsWith(word.text))
        .map(s => ({
            label: s.trigger,
            displayLabel: s.trigger, // リスト表示名
            detail: s.label,         // 説明文
            type: "text",
            apply: (view, completion, from, to) => {
                // 選択されたら置換を実行
                const insertText = getDynamicReplacement(s.replacement);
                view.dispatch({
                    changes: { from: from, to: to, insert: insertText },
                    selection: { anchor: from + insertText.length } // カーソルを末尾へ
                });
            }
        }));

    if (options.length === 0) return null;

    return {
        from: word.from,
        options: options
    };
}

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
let currentPdfBlobUrl = null;

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
// 各ファイルの最終保存時刻を記録するマップ (誤検知防止用)
const lastSaveTimeMap = new Map();

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
 * 設定画面のDOM要素を取得するヘルパー
 */
function getSettingsElement() {
    return document.getElementById('content-settings');
}

/**
 * 設定画面DOMを一時退避場所（非表示）に戻すヘルパー
 */
function detachSettingsView() {
    const settingsEl = getSettingsElement();
    if (settingsEl && settingsEl.parentElement) {
        settingsEl.classList.add('content-hidden');
        // 元の場所（center-pane直下など、邪魔にならない場所）に戻しておく
        // ここでは center-pane の最後尾に追加しておく（非表示なので影響なし）
        document.getElementById('center-pane').appendChild(settingsEl);
    }
}

/**
 * メインビュー切り替えロジック
 * 修正: ツールバーの表示制御を setActiveEditor に委譲し、ここではコンテナの表示のみ行う
 */
function switchMainView(targetId) {
    // 常にエディタエリアを表示（設定画面もこの中に埋め込むため）
    const readmeContent = document.getElementById('content-readme');
    if (readmeContent) {
        readmeContent.classList.remove('content-hidden');
    }

    // 古い設定画面コンテナ(もし退避場所にあれば)を隠す
    const settingsEl = document.getElementById('content-settings');
    if (settingsEl && settingsEl.parentElement === document.getElementById('center-pane')) {
        settingsEl.classList.add('content-hidden');
    }

    // 左側のファイルタイトルバーの表示制御
    // 右側のタイトルバー制御は switchToFile や openInSplitView で行う
    const fileTitleBar = document.getElementById('file-title-bar');
    if (fileTitleBar) {
        // 分割表示中は、アクティブなファイルに関わらず左側のバーを表示し続ける
        if (isSplitLayoutVisible) {
            fileTitleBar.classList.remove('hidden');
        }
        // 全画面表示のときは、READMEや設定画面なら隠す（既存ロジック）
        else if (currentFilePath === 'StartPage' || currentFilePath === 'settings://view') {
            fileTitleBar.classList.add('hidden');
        } else {
            // 通常ファイルの場合
            if (appSettings.showFileTitleBar) {
                fileTitleBar.classList.remove('hidden');
            } else {
                fileTitleBar.classList.add('hidden');
            }
        }
    }

    // タブのアクティブ状態更新
    updateTabVisuals();
}

// ========== 設定関連の関数 ==========

// 透明度を適用する関数
function applyWindowOpacity(transparency) {
    if (window.electronAPI && window.electronAPI.setWindowOpacity) {
        const actualTransparency = transparency * 0.6;
        const opacity = 1.0 - (actualTransparency / 100);
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
        if (val === 1) val = "1.0";
        if (val === 2) val = "2.0";
        lineHeightInput.value = val;
    }
    document.documentElement.style.setProperty('--line-height', (appSettings.lineHeight || 1.4) + 'em');

    // ツールバーの表示制御
    const toolbar = document.querySelector('.toolbar');

    if (toolbar) {
        // Markdown判定用ヘルパー
        const isMarkdown = (filePath) => {
            if (!filePath) return false;
            if (filePath === 'StartPage') return true;
            if (filePath === 'settings://view') return false;
            const ext = path.extname(filePath).toLowerCase();
            // 許可する拡張子リスト: .md, .markdown, .txt
            return ['.md', '.markdown', '.txt'].includes(ext);
        };

        // 現在のビューの状態から判定
        const leftIsMd = globalEditorView && isMarkdown(globalEditorView.filePath);
        const rightIsMd = isSplitLayoutVisible && splitEditorView && isMarkdown(splitEditorView.filePath);

        // 設定ON かつ (どちらかが対象ファイル) なら表示
        const shouldShow = appSettings.showToolbar && (leftIsMd || rightIsMd);

        // 設定ON かつ (どちらかがMarkdown) なら表示
        if (shouldShow) {
            toolbar.classList.remove('hidden');

            // アクティブなファイルがMarkdownでなければ無効化
            if (!isMarkdown(currentFilePath)) {
                toolbar.classList.add('disabled');
            } else {
                toolbar.classList.remove('disabled');
            }
        } else {
            toolbar.classList.add('hidden');
            toolbar.classList.remove('disabled');
        }
    }

    // ファイルタイトルバーの制御
    const fileTitleBarEl = document.getElementById('file-title-bar');
    const readmeContent = document.getElementById('content-readme');
    const mediaViewEl = document.getElementById('media-view'); // 追加: メディアビュー要素を取得

    if (fileTitleBarEl && readmeContent) {
        const isEditorViewActive = !readmeContent.classList.contains('content-hidden');
        // メディアビューが表示されているかチェック
        const isMediaViewActive = mediaViewEl && !mediaViewEl.classList.contains('hidden');

        // メディアビューが表示されている場合はタイトルバーを隠す条件を追加 (!isMediaViewActive)
        if (appSettings.showFileTitleBar && isEditorViewActive && !isMediaViewActive && currentFilePath !== 'StartPage' && currentFilePath !== 'settings://view') {
            fileTitleBarEl.classList.remove('hidden');
        } else {
            fileTitleBarEl.classList.add('hidden');
        }
    }

    // 透明度スライダーへの反映
    const opacityInput = document.getElementById('window-opacity');
    const opacityValue = document.getElementById('window-opacity-value');
    if (opacityInput && opacityValue) {
        const val = appSettings.windowTransparency !== undefined ? appSettings.windowTransparency : 0;
        opacityInput.value = val;
        opacityValue.textContent = `${val}%`;
    }

    // ステータスバーの表示制御
    if (statusBar) {
        statusBar.classList.toggle('hidden', !appSettings.showStatusBar);
        const bottomOffset = appSettings.showStatusBar ? '24px' : '0px';
        document.documentElement.style.setProperty('--status-bar-height', bottomOffset);

        if (bottomPane) {
            bottomPane.style.bottom = bottomOffset;
            if (bottomPane.classList.contains('hidden') || !isTerminalVisible) {
                centerPane.style.marginBottom = '0px';
            }
        }

        const resizerBottom = document.getElementById('resizer-bottom');
        if (resizerBottom) {
            resizerBottom.style.bottom = `calc(${parseInt(bottomPane?.style.height || '200px')}px + ${bottomOffset})`;
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

    // CSS変数の更新
    document.documentElement.style.setProperty('--editor-font-size', appSettings.fontSize);
    document.documentElement.style.setProperty('--editor-font-family', appSettings.fontFamily);
    renderRightSidebarIcons();
}

function updateEditorSettings() {
    // 適用するエフェクトを作成
    const effects = [
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
    ];

    // 左側のエディタに適用
    if (globalEditorView) {
        globalEditorView.dispatch({ effects: effects });
    }

    // 右側のエディタ（存在する場合）にも適用
    if (splitEditorView) {
        splitEditorView.dispatch({ effects: effects });
    }
}

// インデント設定をエディタに適用する関数
function updateIndentSettings() {
    const size = parseInt(appSettings.tabSize, 10);
    const useSpaces = appSettings.insertSpaces;
    const indentString = useSpaces ? " ".repeat(size) : "\t";

    const effects = [
        indentUnitCompartment.reconfigure(indentUnit.of(indentString)),
        tabSizeCompartment.reconfigure(EditorState.tabSize.of(size))
    ];

    if (globalEditorView) {
        globalEditorView.dispatch({ effects: effects });
    }

    if (splitEditorView) {
        splitEditorView.dispatch({ effects: effects });
    }
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
                    appSettings.showWhitespace ? [customHighlightWhitespace, customHighlightTab] : []
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

// 設定タブを開く処理（：ファイルとして扱う・分割対応）
function openSettingsTab() {

    // READMEが開いている場合は閉じる
    if (openedFiles.has('StartPage')) {
        closeWelcomeReadme();
    }

    const settingsPath = 'settings://view';

    // 既にデータとして登録されているかチェック
    // ビューの判定ロジックは switchToFile に任せるため、ここでは単純な登録チェックのみ行う
    if (!openedFiles.has(settingsPath)) {
        // 開いていない場合は新規登録
        openedFiles.set(settingsPath, {
            fileName: '設定',
            type: 'settings',
            isVirtual: true,
            content: '' // 設定画面はDOMなのでコンテンツ文字列は不要
        });

        // タブ作成
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.dataset.filepath = settingsPath;
        tab.id = 'tab-settings'; // 識別用ID
        tab.innerHTML = '設定 <span class="close-tab" data-filepath="settings://view">×</span>';

        enableTabDragging(tab); // ドラッグ可能にする

        if (editorTabsContainer) {
            editorTabsContainer.appendChild(tab);
        }
    }

    // 常に switchToFile を呼び出すことで、分割レイアウトの復元(showSplitLayout)や
    // 適切なペインのアクティブ化を実行させる
    switchToFile(settingsPath, activePane);
}

// ========== スニペット設定UIロジック ==========

function renderSnippetsSettingsList() {
    const tbody = document.getElementById('snippets-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    const snippets = appSettings.textSnippets || [];

    snippets.forEach((snippet, index) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--sidebar-border)';

        tr.innerHTML = `
            <td style="padding: 8px; font-family: monospace;">${escapeHtml(snippet.trigger)}</td>
            <td style="padding: 8px; white-space: pre-wrap; word-break: break-all;">${escapeHtml(snippet.replacement)}</td>
            <td style="padding: 8px; color: #888;">${escapeHtml(snippet.label || '')}</td>
            <td style="padding: 8px; text-align: center;">
                <button class="btn-delete-snippet" data-index="${index}" style="background: none; border: none; cursor: pointer; color: #d9534f;">×</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // 削除ボタンのイベント
    document.querySelectorAll('.btn-delete-snippet').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.index);
            appSettings.textSnippets.splice(index, 1);
            saveSettings();
            renderSnippetsSettingsList();
        });
    });
}

function setupSnippetSettingsEvents() {
    const btnAdd = document.getElementById('btn-add-snippet');
    const inputTrigger = document.getElementById('snippet-trigger-input');
    const inputReplace = document.getElementById('snippet-replace-input');
    const inputLabel = document.getElementById('snippet-label-input');

    if (btnAdd) {
        btnAdd.addEventListener('click', () => {
            const trigger = inputTrigger.value.trim();
            const replacement = inputReplace.value;
            const label = inputLabel.value.trim();

            if (!trigger || !replacement) {
                showNotification('トリガーと置換テキストを入力してください', 'error');
                return;
            }

            // 重複チェック
            if (!appSettings.textSnippets) appSettings.textSnippets = [];
            const exists = appSettings.textSnippets.some(s => s.trigger === trigger);
            if (exists) {
                showNotification('このトリガーは既に存在します', 'error');
                return;
            }

            appSettings.textSnippets.push({ trigger, replacement, label });
            saveSettings();

            // 入力欄クリア
            inputTrigger.value = '';
            inputReplace.value = '';
            inputLabel.value = '';

            renderSnippetsSettingsList();
            showNotification('スニペットを追加しました', 'success');
        });
    }

    // 設定画面のタブ切り替えでスニペットリストを更新するためのリスナー
    const navItem = document.querySelector('.settings-nav-item[data-section="snippets"]');
    if (navItem) {
        navItem.addEventListener('click', () => {
            renderSnippetsSettingsList();
        });
    }

    // デフォルトに戻すボタンの処理
    const btnReset = document.getElementById('btn-reset-snippets');
    if (btnReset) {
        btnReset.addEventListener('click', () => {
            appSettings.textSnippets = JSON.parse(JSON.stringify(DEFAULT_SNIPPETS));
            saveSettings();
            renderSnippetsSettingsList();
            showNotification('スニペットを初期化しました', 'success');
        });
    }
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
        const targetName = `Untitled-${nextNumber}.md`;

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

    // READMEが開いている場合は閉じる
    if (openedFiles.has('StartPage')) {
        closeWelcomeReadme();
    }

    // 空き番号を取得
    const nextNumber = getAvailableUntitledNumber();

    const fileName = `Untitled-${nextNumber}.md`;
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
    tab.innerHTML = `<span class="tab-filename">${fileName}</span> ● <span class="close-tab" data-filepath="${virtualPath}">×</span>`;

    enableTabDragging(tab);

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

    // --- チェックボックス（タスクリスト）のカスタムレンダリング ---
    renderer.checkbox = function (checked) {
        return '<input type="checkbox" ' + (checked ? 'checked="" ' : '') + 'disabled="" class="task-list-item-checkbox"> ';
    };

    // --- リストアイテムのカスタムレンダリング（タスクリスト用クラス付与） ---
    renderer.listitem = function (text, task) {
        if (task) {
            return '<li class="task-list-item">' + text + '</li>\n';
        }
        return '<li>' + text + '</li>\n';
    };

    // --- Mermaidコードブロックの対応 ---
    renderer.code = (code, language) => {
        // 言語が mermaid の場合は専用のdivタグを返す
        if (language === 'mermaid') {
            return `<div class="mermaid">${code}</div>`;
        }
        // 通常のコードブロック（HTMLエスケープ処理）
        // markedのデフォルト挙動に近い処理を再現
        const escapedCode = (code || '').replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

        return `<pre><code class="language-${language || ''}">${escapedCode}</code></pre>`;
    };

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

const startDoc = `# Welcome to Markdown Editor

Markdown編集環境へようこそ。
このドキュメント自体がエディタの機能デモになっています。自由に編集して試してみてください。

## すぐに試せる機能

### 1. Notionライクな高機能テーブル
下の表はGUIで編集可能です。列の境界線をドラッグして幅を変えたり、**右クリック**から行・列を追加できます。

| 機能名 | 説明 | 状態 |
| :--- | :--- | :--- |
| **Live Preview** | マークダウン記法を即座に装飾 | Active |
| **Table Editor** | ドラッグ&ドロップで列移動が可能 | Active |
| **Git Client** | コミット、プッシュ、履歴表示 | Integrated |

### 2. ダイアグラム (Mermaid)
コードブロックを書くだけで、フローチャートやシーケンス図をリアルタイムに描画します。

\`\`\`mermaid
graph TD;
    A[Start] --> B{編集開始};
    B -->|Yes| C[プレビュー確認];
    B -->|No| D[設定変更];
    C --> E[Git Commit];
    D --> B;
\`\`\`

### 3. 数式 (KaTeX)
美しい数式レンダリングをサポートしています。

$$
f(x) = \\int_{-\\infty}^\\infty \\hat f(\\xi)\\,e^{2\\pi i \\xi x} \\,d\\xi
$$

### 4. コード実行
JS, Python, Bashなどのコードブロックには「▶ Run」ボタンが表示され、エディタ内で実行結果を確認できます。

\`\`\`javascript
// 右上の「▶ Run」ボタンを押してみてください
const greeting = "Hello, Markdown Editor!";
console.log(greeting);
console.log("現在時刻: " + new Date().toLocaleString());
\`\`\`

---

## 効率的なワークフロー

* **サイドバー**: \`Ctrl+Shift+B\` でファイルツリー、Git、アウトライン、検索を切り替え。
* **統合ターミナル**: \`Ctrl+@\` でターミナルを表示し、npmコマンドなどを実行できます。
* **コマンドパレット**: \`Ctrl+Shift+P\` で「PDFエクスポート」や「テーマ変更」など全ての機能にアクセスできます。

---
> **Tip:** このファイルは \`StartPage\` という仮想ファイルです。まずは新しいファイルを作成するか、フォルダを開いて作業を開始しましょう！


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

                if (!currentFilePath) {
                    showNotification('画像を保存するには、まずファイルを保存してください。', 'error');
                    return true;
                }

                const reader = new FileReader();
                reader.onload = async (e) => {
                    const arrayBuffer = e.target.result;
                    try {
                        const targetDir = path.dirname(currentFilePath);
                        const result = await window.electronAPI.saveClipboardImage(new Uint8Array(arrayBuffer), targetDir);

                        if (result.success) {
                            // 修正: Wikiリンク形式で挿入
                            const insertText = `[[${result.relativePath}]]\n`;
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

        // ファイルパス貼り付け処理
        if (event.clipboardData.files.length > 0) {
            const files = Array.from(event.clipboardData.files);
            const paths = files.map(f => f.path).filter(p => p);
            if (paths.length > 0) {
                event.preventDefault();
                view.dispatch(view.state.replaceSelection(paths.join('\n')));
                return true;
            }
        }

        return false;
    }
});

const dropHandler = EditorView.domEventHandlers({
    dragenter(event, view) {
        if (event.dataTransfer.types.includes('application/x-markdown-tab')) {
            event.preventDefault();
            if (!isSplitView) {
                view.dom.classList.add('editor-drag-preview-split');
            } else {
                view.dom.classList.add('editor-drag-over');
            }
        }
    },
    dragover(event, view) {
        if (event.dataTransfer.types.includes('application/x-markdown-tab')) {
            event.preventDefault();
            if (!isSplitView) {
                if (!view.dom.classList.contains('editor-drag-preview-split')) {
                    view.dom.classList.add('editor-drag-preview-split');
                }
            } else {
                if (!view.dom.classList.contains('editor-drag-over')) {
                    view.dom.classList.add('editor-drag-over');
                }
            }
            return true;
        }
        event.preventDefault();
        return false;
    },
    dragleave(event, view) {
        if (event.relatedTarget && view.dom.contains(event.relatedTarget)) return;
        view.dom.classList.remove('editor-drag-over');
        view.dom.classList.remove('editor-drag-preview-split');
    },
    drop(event, view) {
        view.dom.classList.remove('editor-drag-over');
        view.dom.classList.remove('editor-drag-preview-split');
        const { dataTransfer } = event;

        // ケース1: タブ移動
        const tabPath = dataTransfer.getData('application/x-markdown-tab');
        if (tabPath) {
            event.preventDefault();
            if (!isSplitView) {
                const isLeftHalf = event.clientX < window.innerWidth / 2;
                openInSplitView(tabPath, isLeftHalf ? 'left' : 'right');
            } else {
                // (既存のタブ移動ロジックはそのまま)
                if (tabPath === 'settings://view') {
                    // ...省略（既存コードと同じ）...
                }
                if (view === globalEditorView) {
                    splitGroup.leftPath = tabPath;
                    setActiveEditor(globalEditorView);
                    switchToFile(tabPath, 'left');
                } else {
                    if (splitEditorView) {
                        splitGroup.rightPath = tabPath;
                        setActiveEditor(splitEditorView);
                        switchToFile(tabPath, 'right');
                    }
                }
            }
            return true;
        }

        // ケース2: 内部ツリーからのドラッグ (text/plain)
        const textData = dataTransfer.getData('text/plain');
        if (textData) {
            // 画像またはPDFの拡張子チェック
            const isMedia = /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico|pdf)$/i.test(textData);
            const isPath = textData.includes('/') || textData.includes('\\');

            if (isMedia && isPath) {
                event.preventDefault();
                let insertPath = textData;
                if (currentFilePath && typeof path !== 'undefined') {
                    try {
                        const currentDir = path.dirname(currentFilePath);
                        insertPath = path.relative(currentDir, textData).split(path.sep).join('/');
                    } catch (e) {
                        console.warn('Relative path calculation failed', e);
                    }
                } else {
                    insertPath = insertPath.replace(/\\/g, '/');
                }

                // 修正: Wikiリンク形式
                const insertText = `[[${insertPath}]]`;

                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                const insertPos = pos !== null ? pos : view.state.selection.main.head;

                view.dispatch({
                    changes: { from: insertPos, insert: insertText },
                    selection: { anchor: insertPos + insertText.length }
                });
                view.focus();
                return true;
            }
        }

        // ケース3: 外部ファイル (Files)
        if (dataTransfer.files && dataTransfer.files.length > 0) {
            event.preventDefault();
            const imageFiles = [];
            const otherFiles = [];

            for (let i = 0; i < dataTransfer.files.length; i++) {
                const file = dataTransfer.files[i];
                if (file.type.startsWith('image/')) {
                    imageFiles.push(file);
                } else {
                    otherFiles.push(file);
                }
            }

            // 画像処理
            if (imageFiles.length > 0) {
                const targetPath = view.filePath || currentFilePath;
                if (!targetPath || targetPath === 'StartPage') {
                    showNotification('画像を保存するには、まずファイルを保存してください。', 'error');
                    return true;
                }

                imageFiles.forEach(file => {
                    const reader = new FileReader();
                    reader.onload = async (e) => {
                        const arrayBuffer = e.target.result;
                        try {
                            const targetDir = path.dirname(targetPath);
                            const result = await window.electronAPI.saveClipboardImage(new Uint8Array(arrayBuffer), targetDir);
                            if (result.success) {
                                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                                const insertPos = pos !== null ? pos : view.state.selection.main.head;
                                // 修正: Wikiリンク形式
                                const insertText = `[[${result.relativePath}]]\n`;
                                view.dispatch({
                                    changes: { from: insertPos, insert: insertText },
                                    selection: { anchor: insertPos + insertText.length }
                                });
                                view.focus();
                                showNotification('画像を保存しました', 'success');
                            } else {
                                showNotification(`保存失敗: ${result.error}`, 'error');
                            }
                        } catch (err) { console.error(err); }
                    };
                    reader.readAsArrayBuffer(file);
                });
            }

            // その他ファイル処理
            if (otherFiles.length > 0) {
                const file = otherFiles[0];
                if (file.path) {
                    (async () => {
                        try {
                            const isDir = await window.electronAPI.isDirectory(file.path);
                            if (isDir) {
                                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                                const insertPos = pos !== null ? pos : view.state.selection.main.head;
                                view.dispatch({
                                    changes: { from: insertPos, insert: file.path },
                                    selection: { anchor: insertPos + file.path.length }
                                });
                                view.focus();
                            } else {
                                setActiveEditor(view);
                                openFile(file.path, file.name);
                            }
                        } catch (err) { console.error(err); }
                    })();
                }
            }
            return true;
        }

        return false;
    }
});

// ========== アクティブな画面（左右）の判定処理 ==========
let activePane = 'left'; // 初期値

document.addEventListener('DOMContentLoaded', () => {
    // 左側のコンテナ類
    const leftContainer = document.getElementById('editor');
    const mainTitleBar = document.getElementById('file-title-bar');

    // 右側のコンテナ類
    const rightContainer = document.getElementById('editor-split');
    const splitTitleBar = document.getElementById('file-title-bar-split');

    // 左側をアクティブにする処理
    const activateLeft = () => {
        activePane = 'left';
        if (globalEditorView) setActiveEditor(globalEditorView);
    };

    // 右側をアクティブにする処理
    const activateRight = () => {
        activePane = 'right';
        if (splitEditorView) setActiveEditor(splitEditorView);
    };

    // 左側のクリック判定 (エディタ + タイトルバー)
    if (leftContainer) leftContainer.addEventListener('mousedown', activateLeft);
    if (mainTitleBar) mainTitleBar.addEventListener('mousedown', activateLeft);

    // 右側のクリック判定 (エディタ + タイトルバー)
    if (rightContainer) rightContainer.addEventListener('mousedown', activateRight);
    if (splitTitleBar) splitTitleBar.addEventListener('mousedown', activateRight);
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

// 検索ウィジェットのセットアップ関数 (修正版: 通常検索のみ)
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

    let debounceTimer = null;

    const performSearch = () => {
        const queryStr = searchInput.value;

        if (!queryStr) {
            view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "", replace: "" })) });
            searchCount.textContent = "No results";
            return;
        }

        try {
            const query = new SearchQuery({
                search: queryStr,
                caseSensitive: searchState.caseSensitive,
                regexp: searchState.regexp,
                wholeWord: searchState.wholeWord,
                replace: replaceInput.value
            });

            // CodeMirrorに検索クエリをセット
            view.dispatch({ effects: setSearchQuery.of(query) });

            // 件数カウント (負荷対策: 上限1000件)
            let count = 0;
            const cursor = query.getCursor(view.state);
            const MAX_SEARCH_COUNT = 1000;

            let item = cursor.next();
            while (!item.done) {
                count++;
                if (count >= MAX_SEARCH_COUNT) break;
                item = cursor.next();
            }

            if (count > 0) {
                searchCount.textContent = count >= MAX_SEARCH_COUNT ? "1000+" : `${count} results`;
            } else {
                searchCount.textContent = "No results";
            }
        } catch (e) {
            console.warn("Search Error:", e);
            searchCount.textContent = "Invalid Regex";
        }
    };

    const updateSearch = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(performSearch, 300);
    };

    // Event Listeners
    searchInput.addEventListener('input', updateSearch);
    replaceInput.addEventListener('input', updateSearch);

    const toggleOption = (btn, key) => {
        searchState[key] = !searchState[key];
        btn.classList.toggle('active', searchState[key]);
        performSearch();
    };

    btnCase.addEventListener('click', () => toggleOption(btnCase, 'caseSensitive'));
    btnWord.addEventListener('click', () => toggleOption(btnWord, 'wholeWord'));
    btnRegex.addEventListener('click', () => toggleOption(btnRegex, 'regexp'));

    // Navigation
    btnNext.addEventListener('click', () => {
        findNext(view);
        view.focus();
    });

    btnPrev.addEventListener('click', () => {
        findPrevious(view);
        view.focus();
    });

    const executeReplace = (all = false) => {
        performSearch();
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

    const handleKeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) findPrevious(view);
            else if (e.ctrlKey && e.altKey) replaceAll(view);
            else findNext(view);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeWidget();
        }
    };
    searchInput.addEventListener('keydown', handleKeydown);
    replaceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            replaceNext(view);
        } else {
            handleKeydown(e);
        }
    });

    return {
        open: () => {
            widget.classList.remove('hidden');
            searchInput.select();
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

// Wikiリンクのオートコンプリート機能
async function wikiLinkCompletion(context) {
    // "[[" の入力を検知
    let word = context.matchBefore(/\[\[[\w\s\-]*/);
    if (!word) return null;

    if (word.from == word.to && !context.explicit) return null;

    // 非同期で候補リストを作成
    let candidates = [];

    if (currentDirectoryPath) {
        try {
            // 現在のディレクトリ内のファイルを取得
            const files = await window.electronAPI.readDirectory(currentDirectoryPath);
            candidates = files
                .filter(f => !f.isDirectory) // ディレクトリのみ除外（すべてのファイルを表示）
                .map(f => {
                    let labelName = f.name;
                    // Markdownファイルの場合は拡張子を省略して表示（従来の挙動）
                    // それ以外のファイル（png, js等）は拡張子付きで表示する
                    if (f.name.endsWith('.md') || f.name.endsWith('.markdown')) {
                        labelName = f.name.replace(/\.(md|markdown)$/, '');
                    }

                    return { label: labelName, type: "text", detail: "File" };
                });
        } catch (e) {
            console.error("WikiLink completion error:", e);
        }
    }

    // 準備ができたらオブジェクトを返す
    return {
        from: word.from + 2, // "[[" の後ろから補完開始
        options: candidates  // ここには必ず配列(Array)を渡す必要がある
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
                        const result = cmd.run(view);
                        // falseが返ってきたら、次のハンドラ(コード実行)へパスする
                        return result !== false;
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

    // --- Backspaceでインデントを一括削除せず、スペース1個分ずつ削除する設定 ---
    dynamicKeymap.push({
        key: "Backspace",
        run: (view) => {
            const { state, dispatch } = view;
            const selection = state.selection.main;

            // 範囲選択されている場合はデフォルトの挙動（選択範囲削除）に任せる
            if (!selection.empty) return false;

            const pos = selection.head;
            // 文頭なら何もしない（デフォルト動作で行結合などさせる）
            if (pos === 0) return false;

            // 直前の文字を確認
            const prevChar = state.doc.sliceString(pos - 1, pos);

            // スペースの場合、強制的に1文字削除を行う
            if (prevChar === " ") {
                dispatch({
                    changes: { from: pos - 1, to: pos, insert: "" },
                    scrollIntoView: true,
                    userEvent: "delete.backward"
                });
                return true; // デフォルトの動作（Hungry Backspace）をキャンセル
            }

            // スペース以外ならデフォルト動作
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

            // ファイル全体ではなく、可視範囲(visibleRanges)のみをハイライト処理する
            // これにより、ファイルサイズが大きくても入力時のパフォーマンスが低下しない
            for (const { from, to } of view.visibleRanges) {
                // 範囲内のテキストのみ取得
                const text = doc.sliceString(from, to);
                const tokens = Prism.tokenize(text, grammar);

                let pos = from; // トークンの位置を可視範囲の開始位置でオフセット

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

                        // ここが修正ポイント:
                        // ブロック全体ではなく、「現在見えている範囲(from, to) と ブロック(bodyStart, bodyEnd) の交差部分」だけを取得する
                        const clipStart = Math.max(bodyStart, from);
                        const clipEnd = Math.min(bodyEnd, to);

                        // 交差部分がなければ（＝画面外なら）処理しない
                        if (clipStart >= clipEnd) return;

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

/* --- WikiImageWidget (画像表示用) --- */
class WikiImageWidget extends WidgetType {
    constructor(fileName, width) {
        super();
        this.fileName = fileName;
        this.width = width;
    }

    eq(other) {
        return this.fileName === other.fileName && this.width === other.width;
    }

    toDOM(view) {
        const wrapper = document.createElement("div");
        wrapper.className = "cm-image-wrapper";
        wrapper.style.display = "inline-block"; // インラインブロックとして配置
        wrapper.style.verticalAlign = "middle";

        if (this.width) {
            wrapper.style.width = this.width + "px";
        }

        const img = document.createElement("img");
        img.className = "cm-live-widget-image";

        // レイアウト再計算
        img.onload = () => { if (view) view.requestMeasure(); };

        // パス解決
        let src = this.fileName;
        if (currentDirectoryPath && !/^https?:\/\//i.test(src) && !/^data:/i.test(src)) {
            try {
                const absPath = path.join(currentDirectoryPath, src);
                src = 'file://' + absPath.replace(/\\/g, '/');
            } catch (e) {
                console.warn('Path resolution failed:', e);
            }
        }
        img.src = src;
        img.alt = this.fileName;

        img.onerror = () => {
            img.style.display = "none"; // エラー時は非表示（または代替アイコン）
        };

        wrapper.appendChild(img);
        return wrapper;
    }

    ignoreEvent() { return true; }
}

/* --- WikiPdfWidget (PDF表示用・レイアウト修正版) --- */
class WikiPdfWidget extends WidgetType {
    constructor(fileName, height) {
        super();
        this.fileName = fileName;
        this.height = height || "500px";
    }

    eq(other) {
        return this.fileName === other.fileName && this.height === other.height;
    }

    toDOM(view) {
        const wrapper = document.createElement("div");
        wrapper.className = "cm-pdf-wrapper";

        // display: block の代わりに inline-block + width: 100% を使用し、
        // marginを0、vertical-alignをtopにすることで、CodeMirrorの行計算とのズレを防ぎます。
        wrapper.style.display = "inline-block";
        wrapper.style.width = "100%";
        wrapper.style.height = this.height;
        wrapper.style.backgroundColor = "#525659";
        wrapper.style.border = "1px solid #ccc";
        wrapper.style.margin = "0";          // 余白を削除 (これがズレの主原因)
        wrapper.style.padding = "0";
        wrapper.style.verticalAlign = "top"; // 行の上辺に合わせる
        wrapper.style.boxSizing = "border-box";
        wrapper.style.resize = "vertical";   // 縦方向のリサイズ許可
        wrapper.style.overflow = "hidden";

        // パス解決
        let src = this.fileName;
        if (currentDirectoryPath && !/^https?:\/\//i.test(src) && !/^data:/i.test(src)) {
            try {
                const absPath = path.join(currentDirectoryPath, src);
                src = 'file://' + absPath.replace(/\\/g, '/');
            } catch (e) {
                console.warn('Path resolution failed:', e);
            }
        }

        const iframe = document.createElement("iframe");
        iframe.src = src;
        iframe.style.width = "100%";
        iframe.style.height = "100%";
        iframe.style.border = "none";
        iframe.style.display = "block"; // iframe下部の隙間対策

        wrapper.appendChild(iframe);

        // レイアウト同期: サイズ変更やロード完了時にCodeMirrorに再計測を依頼する
        if (view) {
            iframe.onload = () => view.requestMeasure();

            // ユーザーがマウスでリサイズした場合の検知
            if (window.ResizeObserver) {
                const observer = new ResizeObserver(() => {
                    view.requestMeasure();
                });
                observer.observe(wrapper);
            }
        }

        return wrapper;
    }

    ignoreEvent() { return true; }
}

// Wikiリンクのレンダリング（画像・PDF表示対応修正版）
const wikiLinkPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = this.buildDecorations(view);
    }
    update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
            this.decorations = this.buildDecorations(update.view);
        }
    }
    buildDecorations(view) {
        const builder = new RangeSetBuilder();
        const text = view.state.doc.toString();
        const selection = view.state.selection.main;

        // Regex: [[ (filename) (| option)? ]]
        const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

        // 拡張子定義
        const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);
        const pdfExtensions = new Set(['pdf']);

        let match;
        while ((match = regex.exec(text))) {
            const start = match.index;
            const end = start + match[0].length;
            const fileName = match[1];
            const option = match[2];

            const ext = path.extname(fileName).toLowerCase().replace('.', '');

            // カーソルがリンク内にあるかチェック
            const isCursorInside = selection.from <= end && selection.to >= start;

            if (imageExtensions.has(ext) && !isCursorInside) {
                // 画像ウィジェット (inline)
                builder.add(start, end, Decoration.replace({
                    widget: new WikiImageWidget(fileName, option)
                }));
            } else if (pdfExtensions.has(ext) && !isCursorInside) {
                // PDFウィジェット (inline replace)
                // ※ widget側で style="display: block" を指定しているため見た目はブロックになります
                builder.add(start, end, Decoration.replace({
                    widget: new WikiPdfWidget(fileName, option)
                }));
            } else {
                // テキストリンクとして表示
                const contentStart = start + 2;
                const contentEnd = end - 2;

                builder.add(start, contentStart, Decoration.mark({ class: "cm-wiki-link-bracket" }));
                builder.add(contentStart, contentEnd, Decoration.mark({
                    tagName: "span",
                    class: "cm-wiki-link-text",
                    attributes: {
                        "data-filename": fileName,
                        "title": "Ctrl + Click で開く"
                    }
                }));
                builder.add(contentEnd, end, Decoration.mark({ class: "cm-wiki-link-bracket" }));
            }
        }
        return builder.finish();
    }
}, {
    decorations: v => v.decorations,
    eventHandlers: {
        click: (e, view) => {
            const target = e.target;
            if (target.classList.contains("cm-wiki-link-text") || target.closest(".cm-wiki-link-text")) {
                const el = target.classList.contains("cm-wiki-link-text") ? target : target.closest(".cm-wiki-link-text");
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault(); e.stopPropagation();
                    const fileName = el.dataset.filename;
                    if (fileName) handleWikiLinkClick(fileName);
                }
            }
        }
    }
});

// Wikiリンククリック時の処理
async function handleWikiLinkClick(linkText) {
    if (!currentDirectoryPath) return;

    let targetFileName = linkText;
    if (!path.extname(linkText)) {
        targetFileName = `${linkText}.md`;
    }

    let fullPath = path.join(currentDirectoryPath, targetFileName);

    // openFile関数を呼び出して開く
    openFile(fullPath, targetFileName);
}

// getCombinedKeymapにfilePathを渡すためのエディタ状態作成関数
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
            whitespaceCompartment.of(appSettings.showWhitespace ? [customHighlightWhitespace, customHighlightTab] : []),

            conflictField,
            wikiLinkPlugin,
            autocompletion({ override: [wikiLinkCompletion, textSnippetCompletion] }),

            EditorView.updateListener.of(update => {
                if (update.docChanged) {
                    // プログラムによる変更かどうかをチェック
                    const isExternal = update.transactions.some(tr => tr.annotation(ExternalChange));

                    // 外部変更でなければ、入力イベントとして処理（保存フラグなど）
                    onEditorInput(!isExternal);

                    // ユーザー操作による変更なら、同期処理とリスト修正を実行
                    if (!isExternal) {
                        // 1. リスト番号の自動修正
                        handleListRenumbering(update.view, update.changes);

                        // 2. 同一ファイルを開いている別のビューへ同期
                        if (isSplitView) {
                            const currentView = update.view;
                            const otherView = (currentView === globalEditorView) ? splitEditorView : globalEditorView;

                            // もう片方のビューが存在し、かつ同じファイルを開いている場合
                            if (otherView && otherView.filePath === currentView.filePath) {
                                otherView.dispatch({
                                    changes: update.changes,
                                    annotations: ExternalChange.of(true) // ループ防止用アノテーション
                                });
                            }
                        }
                    }
                }
                // カーソル移動（選択範囲変更）時にアウトラインを同期
                if (update.selectionSet) {
                    syncOutlineWithCursor();
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

// 設定画面へのドラッグ＆ドロップ対応
function setupSettingsDropHandler() {
    const settingsEl = document.getElementById('content-settings');
    if (!settingsEl) return;

    settingsEl.addEventListener('dragover', (e) => {
        // タブがドラッグされている場合のみ反応
        if (e.dataTransfer.types.includes('application/x-markdown-tab')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            // 視覚的フィードバック（青い枠線を表示）
            settingsEl.style.boxShadow = 'inset 0 0 0 2px #007acc';
        }
    });

    settingsEl.addEventListener('dragleave', () => {
        settingsEl.style.boxShadow = '';
    });

    settingsEl.addEventListener('drop', (e) => {
        settingsEl.style.boxShadow = '';
        const tabPath = e.dataTransfer.getData('application/x-markdown-tab');
        if (tabPath) {
            e.preventDefault();
            e.stopPropagation();

            // 分割表示中かどうかで処理を分岐
            if (typeof isSplitLayoutVisible !== 'undefined' && isSplitLayoutVisible) {
                // --- A. 分割表示中 ---
                // 設定画面が表示されている側（左or右）を特定し、そのペインを上書きする

                let targetSide = 'left'; // デフォルト(左)

                if (splitGroup.rightPath === 'settings://view') {
                    targetSide = 'right';
                }

                // パス情報を直接更新 (Swap防止のためopenInSplitViewは使わない)
                if (targetSide === 'left') {
                    splitGroup.leftPath = tabPath;
                } else {
                    splitGroup.rightPath = tabPath;
                }

                // 上書き表示
                switchToFile(tabPath, targetSide);

            } else {
                // --- B. 全画面表示中 ---
                // 右側に分割して開く (設定画面を残したままファイルを表示)
                // これにより「設定画面のタブ分割」が可能になります
                openInSplitView(tabPath, 'right');
            }
        }
    });
}

function initEditor() {
    if (globalEditorView) return;

    // 初期状態（README相当）でステートを作成
    const state = createEditorState(startDoc, 'StartPage');

    globalEditorView = new EditorView({
        state: state,
        parent: editorContainer,
    });

    // パス情報をViewに紐付ける
    globalEditorView.filePath = 'StartPage';

    // フォーカス時にアクティブに設定
    globalEditorView.contentDOM.addEventListener('focus', () => setActiveEditor(globalEditorView));
    globalEditorView.contentDOM.addEventListener('click', () => setActiveEditor(globalEditorView));

    // 最初は左側をアクティブに
    setActiveEditor(globalEditorView);

    // カスタム検索ウィジェットのセットアップ
    searchWidgetControl = setupSearchWidget(globalEditorView);

    // 設定画面へのドラッグ＆ドロップを有効化
    setupSettingsDropHandler();

    // プレビューボタンのイベントリスナー
    const btnTogglePreview = document.getElementById('btn-toggle-preview');
    if (btnTogglePreview) {
        btnTogglePreview.addEventListener('click', togglePreviewMode);
    }

    // 分割解除ボタンのイベント
    const btnCloseSplit = document.getElementById('btn-close-split');
    if (btnCloseSplit) {
        btnCloseSplit.addEventListener('click', () => {
            closeSplitView();
        });
    }
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

    // コードブロック内判定
    const tree = syntaxTree(state);
    let node = tree.resolveInner(from, 1);
    while (node) {
        // カーソルがコードブロック(FencedCode)内にある場合
        if (node.name === "FencedCode" || node.name === "CodeBlock") {
            return false; // 何もしない（イベントを他のハンドラ=実行機能へ流す）
        }
        node = node.parent;
    }

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

// ========== ツールバー ボタン イベントリスナー ==========

// 保存はアクティブなファイルを対象にするよう saveCurrentFile 内で処理されます
document.getElementById('btn-save')?.addEventListener('click', () => saveCurrentFile(false));

// Undo / Redo
document.getElementById('toolbar-undo')?.addEventListener('click', () => {
    const view = getActiveView();
    if (view) { undo(view); view.focus(); }
});
document.getElementById('toolbar-redo')?.addEventListener('click', () => {
    const view = getActiveView();
    if (view) { redo(view); view.focus(); }
});

// 見出し
document.getElementById('btn-h2')?.addEventListener('click', () => toggleLinePrefix(getActiveView(), "##"));
document.getElementById('btn-h3')?.addEventListener('click', () => toggleLinePrefix(getActiveView(), "###"));

document.querySelectorAll('.dropdown-item[data-action^="h"]').forEach(item => {
    item.addEventListener('click', (e) => {
        const level = parseInt(e.target.dataset.action.replace('h', ''));
        const hashes = "#".repeat(level);
        toggleLinePrefix(getActiveView(), hashes);
    });
});

// 装飾
document.getElementById('bold-btn')?.addEventListener('click', () => toggleMark(getActiveView(), "**"));
document.getElementById('italic-btn')?.addEventListener('click', () => toggleMark(getActiveView(), "*"));
document.getElementById('strike-btn')?.addEventListener('click', () => toggleMark(getActiveView(), "~~"));
document.getElementById('highlight-btn')?.addEventListener('click', () => toggleMark(getActiveView(), "=="));

// 挿入
document.getElementById('link-btn')?.addEventListener('click', () => insertLink(getActiveView()));
document.getElementById('image-btn')?.addEventListener('click', () => insertImage(getActiveView()));

// ローカル画像挿入ボタン
document.getElementById('local-image-btn')?.addEventListener('click', async () => {
    const view = getActiveView();
    if (!view) return;

    try {
        const result = await window.electronAPI.selectFile();
        if (result.success && result.path) {
            const absolutePath = result.path;
            let insertPath = absolutePath;

            if (currentDirectoryPath) {
                try {
                    const relativePath = path.relative(currentDirectoryPath, absolutePath);
                    insertPath = relativePath.replace(/\\/g, '/');
                } catch (e) {
                    console.warn('Relative path calculation failed:', e);
                }
            }

            // 修正: Wikiリンク形式で挿入
            let insertText = `[[${insertPath}]]\n`;

            const { state, dispatch } = view;
            const { from, to } = state.selection.main;

            dispatch({
                changes: { from: from, to: to, insert: insertText },
                selection: { anchor: from + insertText.length }
            });
            view.focus();
        }
    } catch (e) {
        console.error('Local image insertion failed:', e);
        showNotification(`エラー: ${e.message}`, 'error');
    }
});

document.getElementById('btn-table')?.addEventListener('click', () => insertTable(getActiveView()));
document.getElementById('code-btn')?.addEventListener('click', () => insertCodeBlock(getActiveView()));
document.getElementById('inline-code-btn')?.addEventListener('click', () => toggleMark(getActiveView(), "`"));
document.getElementById('quote-btn')?.addEventListener('click', () => toggleLinePrefix(getActiveView(), ">"));
document.getElementById('hr-btn')?.addEventListener('click', () => insertHorizontalRule(getActiveView()));
document.getElementById('btn-page-break')?.addEventListener('click', () => insertPageBreak(getActiveView()));

// リスト
if (btnBulletList) btnBulletList.addEventListener('click', () => toggleList(getActiveView(), 'ul'));
if (btnNumberList) btnNumberList.addEventListener('click', () => toggleList(getActiveView(), 'ol'));
if (btnCheckList) btnCheckList.addEventListener('click', () => toggleList(getActiveView(), 'task'));

// 配置
document.getElementById('btn-align-left')?.addEventListener('click', () => setTextAlignment(getActiveView(), 'left'));
document.getElementById('btn-align-center')?.addEventListener('click', () => setTextAlignment(getActiveView(), 'center'));
document.getElementById('btn-align-right')?.addEventListener('click', () => setTextAlignment(getActiveView(), 'right'));

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
        const options = {
            ...(appSettings.pdfOptions || {}),
            // デフォルト値の補完（既存の設定があればそれを優先）
            pageSize: appSettings.pdfOptions?.pageSize || 'A4',
            marginsType: appSettings.pdfOptions?.marginsType !== undefined ? parseInt(appSettings.pdfOptions.marginsType) : 0,
            printBackground: appSettings.pdfOptions?.printBackground !== undefined ? appSettings.pdfOptions.printBackground : true,
            displayHeaderFooter: appSettings.pdfOptions?.displayHeaderFooter || false,
            landscape: appSettings.pdfOptions?.landscape || false,
            enableToc: appSettings.pdfOptions?.enableToc || false,
            includeTitle: appSettings.pdfOptions?.includeTitle || false,
            // 【重要】現在のテーマを渡してCSS変数を正しく解決させる
            theme: appSettings.theme
        };

        // カスタムCSSを取得してオプションに追加（スニペット用）
        if (typeof getActiveCssContent === 'function') {
            options.customCss = getActiveCssContent();
        }

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
    // グローバルではなくアクティブなビューを取得
    const view = getActiveView();

    // エディタがまだ準備できていない場合は何もしない
    if (!view) return;

    const state = view.state;
    if (!state) return;

    const { from, to } = state.selection.main;

    // 選択範囲がない（カーソルのみ）場合は何もしない
    if (from === to) return;

    // 選択されているテキストを取得
    let text = state.sliceDoc(from, to);

    // 既に色がついている場合（<span>で囲まれている場合）は、中身を取り出してネストを防ぐ
    const spanMatch = text.match(/^<span style="color: [^"]+">([\s\S]*?)<\/span>$/);
    if (spanMatch) {
        text = spanMatch[1];
    }

    // HTMLタグ形式で色を指定
    const coloredText = `<span style="color: ${color}">${text}</span>`;

    // エディタの内容を書き換える
    view.dispatch({
        changes: { from, to, insert: coloredText },
        selection: { anchor: from, head: from + coloredText.length }
    });

    // エディタにフォーカスを戻す
    view.focus();
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
    if (markAsDirty && currentFilePath && currentFilePath !== 'StartPage') {
        fileModificationState.set(currentFilePath, true);
        // 自動保存が OFF の場合のみ、視覚的なマーク(●)を表示する
        // 自動保存 ON の場合は、見た目上は何も変化させない（Obsidianライクな挙動）
        if (!appSettings.autoSave) {
            const tab = document.querySelector(`[data-filepath="${CSS.escape(currentFilePath)}"]`);
            if (tab && !tab.innerHTML.includes('●')) {
                tab.innerHTML = tab.innerHTML.replace('<span class="close-tab"', ' ● <span class="close-tab"');
            }
        }
    }

    // プレビューモードなら内容を更新
    if (isPreviewMode) {
        // 負荷軽減のため少し遅延させる
        if (window.previewUpdateTimeout) clearTimeout(window.previewUpdateTimeout);
        window.previewUpdateTimeout = setTimeout(() => {
            updatePreviewContent();
        }, 300);
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

    if (appSettings.autoSave && currentFilePath && currentFilePath !== 'StartPage' && !isVirtual) { // 仮想ファイルでない場合のみ実行
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
    const pdfPreviewContainer = document.getElementById('pdf-preview-container');

    // バックリンク用の要素取得
    const backlinksHeader = document.getElementById('backlinks-header');
    const backlinksContainer = document.getElementById('backlinks-container');

    const customWebHeader = document.getElementById('custom-webview-header');
    const customWebContainer = document.getElementById('custom-webview-container');

    if (rightActivityBar) {
        rightActivityBar.classList.toggle('hidden', !isRightActivityBarVisible);
    }

    const showPdf = isPdfPreviewVisible;
    const showTerminalRight = isTerminalVisible && isPositionRight;
    const showBacklinks = isBacklinksVisible;

    const showCustomWeb = !!activeCustomLinkId; // IDがあれば表示

    const needRightPane = (showPdf || showTerminalRight || showBacklinks || showCustomWeb) && isRightActivityBarVisible;

    const barWidth = isRightActivityBarVisible ? rightActivityBarWidth : 0;
    document.documentElement.style.setProperty('--right-activity-offset,', barWidth + 'px');

    document.body.classList.add('is-layout-changing');

    if (needRightPane) {
        rightPane.classList.remove('hidden');
        if (resizerRight) resizerRight.classList.remove('hidden');

        // まず全てのヘッダーとコンテンツを非表示にする（リセット）
        if (terminalHeader) terminalHeader.classList.add('hidden');
        if (terminalContainer) terminalContainer.classList.add('hidden');
        if (pdfPreviewContainer) pdfPreviewContainer.classList.add('hidden');
        if (backlinksHeader) backlinksHeader.classList.add('hidden');
        if (backlinksContainer) backlinksContainer.classList.add('hidden');
        if (customWebHeader) customWebHeader.classList.add('hidden');
        if (customWebContainer) customWebContainer.classList.add('hidden');

        // 必要なものだけ表示
        if (showPdf) {
            // PDFヘッダー表示コードを削除し、コンテナのみ表示
            if (pdfPreviewContainer) pdfPreviewContainer.classList.remove('hidden');
        } else if (showTerminalRight) {
            if (terminalHeader) terminalHeader.classList.remove('hidden');
            if (terminalContainer) terminalContainer.classList.remove('hidden');
        } else if (showBacklinks) {
            if (backlinksHeader) backlinksHeader.classList.remove('hidden');
            if (backlinksContainer) backlinksContainer.classList.remove('hidden');
        } else if (showCustomWeb) {
            if (customWebHeader) customWebHeader.classList.remove('hidden');
            if (customWebContainer) customWebContainer.classList.remove('hidden');
        }

        const rightPaneWidth = rightPane.style.width || '350px';
        document.documentElement.style.setProperty('--right-pane-width', rightPaneWidth);

        mainContent.style.marginRight = (parseFloat(rightPaneWidth) + barWidth) + 'px';

    } else {
        // 右ペイン全体を隠す
        rightPane.classList.add('hidden');
        if (resizerRight) resizerRight.classList.add('hidden');

        document.documentElement.style.setProperty('--right-pane-width', '0px');

        mainContent.style.marginRight = barWidth + 'px';
    }

    // 下部ターミナルの制御
    if (isTerminalVisible && !isPositionRight) {
        bottomPane.classList.remove('hidden');
        if (resizerBottom) resizerBottom.classList.remove('hidden');

        const statusBarHeight = appSettings.showStatusBar ? 24 : 0;

        if (!bottomPane.style.height || bottomPane.style.height === '0px') {
            bottomPane.style.height = '200px';
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

    // ターミナルのDOM移動処理
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

    // アイコンのアクティブ状態更新
    if (btnTerminalRight) btnTerminalRight.classList.toggle('active', isTerminalVisible);
    if (btnPdfPreview) btnPdfPreview.classList.toggle('active', isPdfPreviewVisible);
    if (btnBacklinks) btnBacklinks.classList.toggle('active', showBacklinks);

    document.querySelectorAll('.custom-link-icon').forEach(icon => {
        icon.classList.toggle('active', icon.dataset.id === activeCustomLinkId);
    });

    document.body.classList.remove('is-layout-changing');

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

// カスタムリンク設定のイベントリスナー
function setupCustomLinkSettingsEvents() {
    const btnAdd = document.getElementById('btn-add-link');
    const inputUrl = document.getElementById('link-url-input');
    const inputName = document.getElementById('link-name-input');
    const inputIcon = document.getElementById('link-icon-select');

    // 外部ブラウザで開くボタンのイベント（右ペインヘッダー）
    const btnOpenExternal = document.getElementById('btn-open-external');
    if (btnOpenExternal) {
        btnOpenExternal.addEventListener('click', () => {
            const iframe = document.getElementById('custom-webview-frame');
            if (iframe && iframe.src) {
                window.electronAPI.openExternal(iframe.src);
            }
        });
    }

    // 設定画面のタブ切り替えイベント
    const navItem = document.querySelector('.settings-nav-item[data-section="links"]');
    if (navItem) {
        navItem.addEventListener('click', renderCustomLinksSettingsList);
    }

    if (btnAdd) {
        btnAdd.addEventListener('click', () => {
            const url = inputUrl.value.trim();
            const name = inputName.value.trim() || 'Link';
            const icon = inputIcon.value;

            if (!url) {
                showNotification('URLを入力してください', 'error');
                return;
            }

            if (!appSettings.customLinks) appSettings.customLinks = [];

            // ID生成
            const id = 'link-' + Date.now();
            appSettings.customLinks.push({ id, name, url, icon });

            saveSettings();

            // UI更新
            inputUrl.value = '';
            inputName.value = '';
            renderCustomLinksSettingsList();
            renderRightSidebarIcons(); // サイドバー即時更新

            showNotification('リンクを追加しました', 'success');
        });
    }
}

// 設定画面のリスト描画
function renderCustomLinksSettingsList() {
    const tbody = document.getElementById('custom-links-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    const links = appSettings.customLinks || [];

    links.forEach((link, index) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--sidebar-border)';

        const iconSvg = CUSTOM_LINK_ICONS[link.icon] || CUSTOM_LINK_ICONS['globe'];

        tr.innerHTML = `
            <td style="padding: 8px; text-align: center;">
                <div style="width:20px; height:20px; margin:0 auto;">${iconSvg}</div>
            </td>
            <td style="padding: 8px;">${escapeHtml(link.name)}</td>
            <td style="padding: 8px; color: #888; font-size: 11px; word-break: break-all;">${escapeHtml(link.url)}</td>
            <td style="padding: 8px; text-align: center;">
                <button class="btn-delete-link" data-index="${index}" style="background: none; border: none; cursor: pointer; color: #d9534f;">×</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // 削除ボタンイベント
    document.querySelectorAll('.btn-delete-link').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.index);
            const deletedId = appSettings.customLinks[index].id;

            appSettings.customLinks.splice(index, 1);
            saveSettings();

            // もし削除したリンクが開かれていたら閉じる
            if (activeCustomLinkId === deletedId) {
                toggleCustomLinkView(deletedId); // 閉じる処理が走る
            }

            renderCustomLinksSettingsList();
            renderRightSidebarIcons();
        });
    });
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
            isBacklinksVisible = false;
            activeCustomLinkId = null;
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

if (btnPdfPreview) { // togglePdfPreview関数を直接呼んでいる既存コードを置き換え
    btnPdfPreview.addEventListener('click', () => {
        if (isPdfPreviewVisible) {
            isPdfPreviewVisible = false;
        } else {
            // 排他制御: PDFプレビューを開くときは他を閉じる
            isPdfPreviewVisible = true;
            isTerminalVisible = false;
            isBacklinksVisible = false;
            activeCustomLinkId = null;
            generatePdfPreview(); // PDF生成
        }
        updateTerminalVisibility();
    });
}

async function generatePdfPreview() {
    try {
        if (!globalEditorView) return;
        const markdownContent = globalEditorView.state.doc.toString();

        // コンテンツが空ならクリア
        if (!markdownContent.trim()) {
            const container = document.getElementById('pdf-preview-container');
            if (container) container.innerHTML = '';
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
        }

        // タイトルの取得
        const currentTitle = document.getElementById('file-title-input')?.value || 'Untitled';

        // 共通関数でHTML生成
        const htmlContent = await convertMarkdownToHtml(markdownContent, options, currentTitle);

        if (typeof window.electronAPI?.generatePdf === 'function') {
            await renderHtmlToPdf(htmlContent, options);
        } else {
            console.warn('PDF generation API not available');
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

    // Wikiリンク [[Link]] -> <a href="...">Link</a> への変換
    // PDF化の際はジャンプできないため、単なる装飾にするか、アンカーリンクにするなどの対応が必要です。
    // ここでは簡易的に太字+色付けの装飾に変換します。
    processed = processed.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, fileName, label) => {
        const text = label || fileName;
        return `<strong style="color: #007acc;">${text}</strong>`;
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
        // メインプロセスでPDF生成 (Base64文字列が返る)
        const pdfData = await window.electronAPI.generatePdf(htmlContent, options);
        if (pdfData) {
            await displayPdfFromBlob(pdfData);
        }
    } catch (error) {
        console.error('Error rendering HTML to PDF:', error);
    }
}

async function displayPdfFromBlob(pdfDataBase64) {
    try {
        // Base64をBlobに変換
        const byteCharacters = atob(pdfDataBase64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'application/pdf' });

        // 新しいBlob URLを生成
        const newBlobUrl = URL.createObjectURL(blob);

        const container = document.getElementById('pdf-preview-container');
        const rightPane = document.getElementById('right-pane');

        if (!container || !rightPane) return;

        // 1. 親要素(右ペイン)のスタイル補正
        if (window.getComputedStyle(rightPane).display !== 'flex') {
            rightPane.style.display = 'flex';
            rightPane.style.flexDirection = 'column';
            rightPane.style.height = '100%';
            rightPane.style.overflow = 'hidden';
        }

        // 2. コンテナのスタイル設定 (重ね合わせの基準点とする)
        container.classList.remove('hidden');
        Object.assign(container.style, {
            display: 'block',
            flex: '1 1 auto',
            width: '100%',
            height: '100%',
            minHeight: '0',
            overflow: 'hidden',     // 余計なスクロールバーを出さない
            padding: '0',
            margin: '0',
            backgroundColor: '#525659', // PDFビューアの背景色に合わせてフラッシュを目立たなくする
            position: 'relative'        // 子要素(iframe)をabsoluteにするために必須
        });

        // 3. 既存のiframeを取得（あとで削除するため）
        // 連続更新された場合に備え、古いiframeすべてを対象にする
        const oldIframes = Array.from(container.querySelectorAll('iframe'));

        // 4. 新しいiframeを作成（透明な状態で配置）
        const newIframe = document.createElement('iframe');
        Object.assign(newIframe.style, {
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
            position: 'absolute', // コンテナ内で重ね合わせる
            top: '0',
            left: '0',
            opacity: '0',         // 最初は隠しておく
            transition: 'opacity 0.2s ease-out', // ふんわり表示させるアニメーション
            zIndex: '10'          // 新しいものを手前に
        });

        // iframeをDOMに追加してからURLをセット
        container.appendChild(newIframe);
        newIframe.src = `${newBlobUrl}#navpanes=0`;

        // 5. ロード完了後の処理
        const onIframeReady = () => {
            // ChromeのPDFビューアはonload直後はまだ描画されていない場合があるため、
            // わずかに遅らせてから表示することで「描画中のチラつき」を隠蔽する
            setTimeout(() => {
                newIframe.style.opacity = '1';

                // フェードイン完了（0.2秒）を待ってから古い要素を削除
                setTimeout(() => {
                    oldIframes.forEach(frame => frame.remove());

                    // 古いBlob URLを解放（メモリリーク防止）
                    if (currentPdfBlobUrl && currentPdfBlobUrl !== newBlobUrl) {
                        URL.revokeObjectURL(currentPdfBlobUrl);
                    }
                    // 現在のURLを更新
                    currentPdfBlobUrl = newBlobUrl;
                }, 250); // transition時間(200ms) + マージン
            }, 150); // PDF描画待ちウェイト (短すぎるとグレー画面が見える)
        };

        newIframe.onload = onIframeReady;

        // フォールバック: 万が一onloadが来ない場合の強制表示 (3秒後)
        setTimeout(() => {
            if (newIframe.style.opacity === '0') {
                newIframe.style.opacity = '1';
                oldIframes.forEach(frame => frame.remove());
            }
        }, 3000);

    } catch (error) {
        console.error('Error displaying PDF:', error);
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
    if (!filePath || filePath === 'StartPage') return;

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
 * Gitファイルリストを描画するヘルパー関数（ちらつき防止・Diff更新版）
 * 修正: 初期化ボタンなどが残らないようにクリーンアップ処理を追加
 */
function renderGitList(container, files, type) {
    if (!files) files = [];

    // 0. 【修正点】ファイルリスト以外の要素（初期化ボタンやエラーメッセージ等）があれば削除
    // これを行わないと、Git管理下になってもInitボタンが残り続けます
    Array.from(container.children).forEach(child => {
        // git-file-itemクラスを持たない、またはpathデータがない要素は削除
        if (!child.classList.contains('git-file-item') || !child.dataset.path) {
            child.remove();
        }
    });

    // 1. 現在表示されている要素をマップ化（再利用のため）
    const existingItems = new Map();
    Array.from(container.children).forEach(child => {
        if (child.dataset.path) {
            existingItems.set(child.dataset.path, child);
        }
    });

    // 今回の更新で処理したパスを記録するセット
    const processedPaths = new Set();

    files.forEach(file => {
        processedPaths.add(file.filepath);

        let item = existingItems.get(file.filepath);
        let needsRender = false;

        // 新規作成か、既存の再利用か判定
        if (!item) {
            item = document.createElement('div');
            item.className = 'git-file-item';
            item.dataset.path = file.filepath;
            needsRender = true; // 新規なので中身の描画が必要
        } else {
            // ステータスが変わった場合のみ再描画する
            if (item.dataset.status !== file.status) {
                needsRender = true;
            }
        }

        // 要素をコンテナに追加（既存の場合は移動、新規の場合は追加）
        container.appendChild(item);

        // 内容の更新が必要な場合のみ HTML を書き換える
        if (needsRender) {
            item.dataset.status = file.status;

            // --- ステータス表示の決定 ---
            let statusChar = 'M';
            let statusClass = 'modified';
            if (file.status === 'new' || file.status === 'added' || file.status === '??') {
                statusChar = 'A';
                statusClass = 'added';
            } else if (file.status === 'deleted') {
                statusChar = 'D';
                statusClass = 'deleted';
            } else if (file.status === 'modified') {
                statusChar = 'M';
                statusClass = 'modified';
            } else if (file.status === 'renamed') {
                statusChar = 'R';
                statusClass = 'renamed';
            }

            // パス表示の整形
            const fileName = file.filepath.split(/[/\\]/).pop();
            const dirName = file.filepath.substring(0, file.filepath.length - fileName.length);
            const displayPath = dirName === '' ? '' : dirName;

            // --- ボタンのHTML生成 ---
            let actionButtonsHtml = '';
            if (type === 'unstaged') {
                // 変更の破棄ボタン
                actionButtonsHtml += `<button class="git-action-btn-small btn-discard" title="変更を破棄" style="margin-right: 4px; color: #d9534f;">↺</button>`;
                // ステージングボタン
                actionButtonsHtml += `<button class="git-action-btn-small btn-stage" title="ステージする">+</button>`;
            } else {
                // アンステージングボタン
                actionButtonsHtml += `<button class="git-action-btn-small btn-unstage" title="ステージを取り消す">−</button>`;
            }

            item.innerHTML = `
                <div class="git-file-left">
                    <span class="git-file-name">${fileName} <span class="git-file-dir">${displayPath}</span></span>
                </div>
                <div class="git-file-right">
                    <span class="git-status-badge ${statusClass}">${statusChar}</span>
                    <div class="git-actions">
                        ${actionButtonsHtml}
                    </div>
                </div>
            `;

            // --- イベントハンドラの設定 ---

            // アイテムクリック
            item.onclick = (e) => {
                if (e.target.closest('.git-action-btn-small')) return;

                if (type === 'unstaged' && file.status !== 'deleted') {
                    openDiffView(file.filepath);
                } else {
                    if (file.status !== 'deleted') {
                        openFile(path.join(currentDirectoryPath, file.filepath), fileName);
                    }
                }
            };

            // 1. 変更の破棄ボタン
            const btnDiscard = item.querySelector('.btn-discard');
            if (btnDiscard) {
                btnDiscard.onclick = async (e) => {
                    e.stopPropagation();
                    // showConfirmDialogが存在するか確認して使い分ける
                    const message = `${fileName} の変更を破棄してもよろしいですか？\nこの操作は取り消せません。`;
                    const doDiscard = (typeof showConfirmDialog === 'function')
                        ? await showConfirmDialog(message)
                        : confirm(message);

                    if (!doDiscard) return;

                    try {
                        const result = await window.electronAPI.gitDiscard(currentDirectoryPath, file.filepath, file.status);
                        if (result.success) {
                            showNotification('変更を破棄しました', 'success');
                            refreshGitStatus();
                            initializeFileTreeWithState();
                            // エディタが開いていればリロード
                            if (currentFilePath && !openedFiles.get(currentFilePath)?.isVirtual) {
                                reloadFileFromDisk(currentFilePath);
                            }
                        } else {
                            showNotification(`破棄エラー: ${result.error}`, 'error');
                        }
                    } catch (err) {
                        console.error(err);
                        showNotification(`エラー: ${err.message}`, 'error');
                    }
                };
            }

            // 2. ステージングボタン
            const btnStage = item.querySelector('.btn-stage');
            if (btnStage) {
                btnStage.onclick = async (e) => {
                    e.stopPropagation();
                    try {
                        if (file.status === 'deleted') {
                            await window.electronAPI.gitRemove(currentDirectoryPath, file.filepath);
                        } else {
                            await window.electronAPI.gitAdd(currentDirectoryPath, file.filepath);
                        }
                        refreshGitStatus();
                    } catch (err) {
                        showNotification(`エラー: ${err.message}`, 'error');
                    }
                };
            }

            // 3. アンステージングボタン
            const btnUnstage = item.querySelector('.btn-unstage');
            if (btnUnstage) {
                btnUnstage.onclick = async (e) => {
                    e.stopPropagation();
                    try {
                        await window.electronAPI.gitReset(currentDirectoryPath, file.filepath);
                        refreshGitStatus();
                    } catch (err) {
                        showNotification(`エラー: ${err.message}`, 'error');
                    }
                };
            }
        }
    });

    // 4. 今回のリストに含まれなくなった古いファイル要素を削除
    existingItems.forEach((node, path) => {
        if (!processedPaths.has(path)) {
            node.remove();
        }
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
 * コミットグラフとリストの描画 (アコーディオン機能・クリック詳細表示を追加)
 */
function renderGitGraph(commits, currentBranch) {
    gitHistoryList.innerHTML = '';
    if (commits.length === 0) {
        gitHistoryList.innerHTML = '<div class="git-empty-msg">No commits yet</div>';
        return;
    }

    commits.forEach((commit, index) => {
        // 行全体を包むラッパー (詳細表示用のアコーディオンコンテナ)
        const rowWrapper = document.createElement('div');
        rowWrapper.className = 'git-history-row-wrapper';

        // コミット行本体
        const row = document.createElement('div');
        row.className = 'git-history-row';
        row.dataset.oid = commit.oid;

        // --- タイムライン ---
        const timeline = document.createElement('div');
        timeline.className = 'git-timeline';
        const line = document.createElement('div');
        line.className = 'git-timeline-line';
        if (index === commits.length - 1) line.classList.add('last');
        const dot = document.createElement('div');
        dot.className = 'git-timeline-dot';
        timeline.appendChild(line);
        timeline.appendChild(dot);

        // --- コンテンツ ---
        const content = document.createElement('div');
        content.className = 'git-history-content';

        // ヘッダー (メッセージとRefバッジ)
        const header = document.createElement('div');
        header.className = 'git-history-header';

        // Refs (ブランチバッジ等)
        if (commit.refs && commit.refs.length > 0) {
            const refsContainer = document.createElement('span');
            refsContainer.className = 'git-refs';
            commit.refs.forEach(ref => {
                const badge = document.createElement('span');
                badge.className = 'git-ref-badge';
                if (ref.name.startsWith('origin/') || ref.name.startsWith('remotes/')) {
                    badge.classList.add('remote');
                    badge.textContent = `☁ ${ref.name.replace('remotes/', '')}`;
                } else {
                    badge.textContent = ref.name;
                    if (ref.name === currentBranch) badge.classList.add('current-branch');
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

        // メタ情報 (Author & Date)
        const meta = document.createElement('div');
        meta.className = 'git-history-meta';
        const authorName = commit.author.name;
        const date = new Date(commit.author.timestamp * 1000);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        meta.textContent = `${authorName}, ${dateStr}`;

        content.appendChild(header);
        content.appendChild(meta);

        row.appendChild(timeline);
        row.appendChild(content);

        // --- イベントリスナー設定 ---

        // 1. 既存のツールチップ (hover)
        row.addEventListener('mouseenter', (e) => {
            if (typeof showCommitTooltip === 'function') showCommitTooltip(e, commit);
        });
        row.addEventListener('mouseleave', () => {
            if (typeof hideCommitTooltip === 'function') hideCommitTooltip();
        });

        // 2. 右クリックメニュー
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (typeof hideCommitTooltip === 'function') hideCommitTooltip();
            if (typeof showCommitContextMenu === 'function') showCommitContextMenu(e.pageX, e.pageY, commit);
        });

        // 3. 【新規】クリックで詳細(ファイルリスト)を展開
        row.style.cursor = 'pointer';
        row.onclick = async (e) => {
            // バッジクリック等の場合は展開しない制御
            if (e.target.closest('.git-ref-badge')) return;

            // 既に詳細エリアがあるか確認
            const existingDetail = rowWrapper.querySelector('.git-history-detail');
            if (existingDetail) {
                // 表示/非表示切り替え
                const isHidden = existingDetail.style.display === 'none';
                existingDetail.style.display = isHidden ? 'block' : 'none';
                return;
            }

            // 詳細エリアを新規作成
            const detailDiv = document.createElement('div');
            detailDiv.className = 'git-history-detail';
            // スタイル調整: タイムラインの右側に寄せる
            detailDiv.style.paddingLeft = '34px';
            detailDiv.style.paddingBottom = '8px';
            detailDiv.style.fontSize = '12px';
            detailDiv.style.color = 'var(--text-color)';
            detailDiv.innerHTML = '<div style="color:#888;">Loading changes...</div>';
            rowWrapper.appendChild(detailDiv);

            try {
                // メインプロセスから変更ファイル詳細を取得
                const result = await window.electronAPI.gitGetCommitDetail(currentDirectoryPath, commit.oid);

                if (result.success && result.stats.files) {
                    detailDiv.innerHTML = ''; // Loading消去

                    if (result.stats.files.length === 0) {
                        detailDiv.innerHTML = '<div style="color:#888;">No files changed.</div>';
                    } else {
                        // ファイルリスト生成
                        const fileList = document.createElement('div');
                        fileList.className = 'git-commit-file-list';

                        result.stats.files.forEach(file => {
                            const fileItem = document.createElement('div');
                            fileItem.className = 'git-commit-file-item';
                            fileItem.style.cssText = 'display:flex; align-items:center; padding:2px 0; cursor:pointer; gap: 6px;';

                            // ステータスに応じた色とアイコン
                            let color = '#888';
                            let statusLetter = 'M';
                            if (file.status === 'A') { color = '#73c991'; statusLetter = 'A'; } // Added (Green)
                            if (file.status === 'D') { color = '#d9534f'; statusLetter = 'D'; } // Deleted (Red)
                            if (file.status === 'M') { color = '#e2c08d'; statusLetter = 'M'; } // Modified (Yellow)

                            fileItem.innerHTML = `
                                <span style="color:${color}; font-family:monospace; font-weight:bold; width:12px;">${statusLetter}</span>
                                <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${file.filepath}</span>
                            `;

                            // ホバーエフェクト
                            fileItem.onmouseover = () => fileItem.style.textDecoration = 'underline';
                            fileItem.onmouseout = () => fileItem.style.textDecoration = 'none';

                            // ファイルクリックでDiff表示
                            fileItem.onclick = (ev) => {
                                ev.stopPropagation();
                                openDiffView(file.filepath, commit.oid);
                            };

                            fileList.appendChild(fileItem);
                        });
                        detailDiv.appendChild(fileList);
                    }
                } else {
                    detailDiv.innerHTML = '<div style="color:#888;">No details available.</div>';
                }
            } catch (err) {
                console.error(err);
                detailDiv.innerHTML = '<div style="color:#d9534f;">Error loading details.</div>';
            }
        };

        rowWrapper.appendChild(row);
        gitHistoryList.appendChild(rowWrapper);
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

/**
 * カスタム確認ダイアログを表示する関数
 * @param {string} message 表示するメッセージ
 * @returns {Promise<boolean>} OKならtrue, キャンセルならfalse
 */
function showConfirmDialog(message) {
    return new Promise((resolve) => {
        // モーダルのHTMLを作成
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const content = document.createElement('div');
        content.className = 'modal-content';

        const msgP = document.createElement('p');
        msgP.className = 'modal-message';
        msgP.textContent = message;
        // 改行コードを反映させる場合
        msgP.style.whiteSpace = 'pre-wrap';

        const btnContainer = document.createElement('div');
        btnContainer.className = 'modal-buttons';

        const btnCancel = document.createElement('button');
        btnCancel.className = 'modal-btn';
        btnCancel.textContent = 'キャンセル';

        const btnOk = document.createElement('button');
        btnOk.className = 'modal-btn primary';
        btnOk.textContent = 'OK';

        // イベントハンドラ
        const close = (result) => {
            document.body.removeChild(overlay);
            resolve(result);
        };

        btnCancel.onclick = () => close(false);
        btnOk.onclick = () => close(true);

        // 組み立て
        btnContainer.appendChild(btnCancel);
        btnContainer.appendChild(btnOk);
        content.appendChild(msgP);
        content.appendChild(btnContainer);
        overlay.appendChild(content);

        document.body.appendChild(overlay);

        // キャンセルボタンにフォーカス
        btnCancel.focus();
    });
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

/**
 * 変更を保存するか確認する3択モーダルを表示する関数
 * @param {string} fileName - ファイル名
 * @param {Function} onSave - 「保存する」が選ばれた時のコールバック
 * @param {Function} onDontSave - 「保存しない」が選ばれた時のコールバック
 */
function showSaveConfirmModal(fileName, onSave, onDontSave) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.width = 'auto';
    content.style.minWidth = '350px';
    content.style.padding = '20px';
    content.style.textAlign = 'center';

    const msgDiv = document.createElement('div');
    msgDiv.className = 'modal-message';
    msgDiv.innerHTML = `<strong>${escapeHtml(fileName)}</strong> の変更を保存しますか？<br><span style="font-size:0.9em; opacity:0.8;">保存しない場合、変更は失われます。</span>`;
    msgDiv.style.marginBottom = '20px';

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';
    buttons.style.justifyContent = 'center';
    buttons.style.gap = '10px';

    // 保存するボタン
    const saveBtn = document.createElement('button');
    saveBtn.className = 'modal-btn primary';
    saveBtn.textContent = '保存する';
    saveBtn.onclick = () => {
        overlay.remove();
        onSave();
    };

    // 保存しないボタン
    const dontSaveBtn = document.createElement('button');
    dontSaveBtn.className = 'modal-btn';
    dontSaveBtn.textContent = '保存しない';
    dontSaveBtn.style.color = '#d9534f'; // 赤系
    dontSaveBtn.onclick = () => {
        overlay.remove();
        onDontSave();
    };

    // キャンセルボタン
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.onclick = () => overlay.remove();

    buttons.appendChild(saveBtn);
    buttons.appendChild(dontSaveBtn);
    buttons.appendChild(cancelBtn);

    content.appendChild(msgDiv);
    content.appendChild(buttons);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    saveBtn.focus(); // デフォルトで保存ボタンにフォーカス

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
 * Git操作用の拡張ボタン群の設定（「...」メニューの実装）
 */
function setupGitExtraButtons() {
    const btnMore = document.getElementById('btn-git-more');
    if (!btnMore) return;

    const newBtnMore = btnMore.cloneNode(true);
    btnMore.parentNode.replaceChild(newBtnMore, btnMore);

    newBtnMore.addEventListener('click', (e) => {
        e.stopPropagation();

        const rect = newBtnMore.getBoundingClientRect();

        ContextMenu.show(rect.left, rect.bottom + 5, [
            {
                label: 'Pull (--no-ff)',
                click: async () => {
                    if (!currentDirectoryPath) return;
                    try {
                        showNotification('Pull (--no-ff) を実行中...', 'info');
                        const result = await window.electronAPI.gitPullNoFF(currentDirectoryPath);

                        if (result.success) {
                            showNotification('Pull (--no-ff) 完了', 'success');
                        } else {
                            showNotification(`Pullエラー: ${result.error}`, 'error');
                        }

                        // ステータス更新とファイルの強制リロード
                        refreshGitStatus();
                        if (currentFilePath && !openedFiles.get(currentFilePath)?.isVirtual) {
                            await reloadFileFromDisk(currentFilePath);
                        }
                    } catch (e) {
                        showNotification(`エラー: ${e.message}`, 'error');
                    }
                }
            },
            { type: 'separator' },
            {
                label: '.gitignoreを再適用',
                click: async () => {
                    showCompactConfirmModal('.gitignoreを再適用しますか？\n(キャッシュを削除して再コミットします)', async () => {
                        await executeGitActionMenu(() => window.electronAPI.gitApplyGitignore(currentDirectoryPath), '.gitignoreを適用しました');
                    });
                }
            },
            {
                label: 'Amend (直前のコミットに上書き)',
                click: async () => {
                    try {
                        const status = await window.electronAPI.gitStatus(currentDirectoryPath);
                        if (!status.success || !status.staged || status.staged.length === 0) {
                            showNotification('上書きする変更（ステージ済みファイル）がありません', 'error');
                            return;
                        }
                    } catch (e) { console.error(e); return; }

                    showCompactConfirmModal('直前のコミットを上書きしますか？\n(現在のステージング内容が含まれます)', async () => {
                        await executeGitActionMenu(() => window.electronAPI.gitCommitAmend(currentDirectoryPath), 'コミットを上書きしました');
                    });
                }
            },
            { type: 'separator' },
            {
                label: '強制プッシュ (Force Push)',
                click: async () => {
                    try {
                        const remote = await window.electronAPI.gitGetRemoteUrl(currentDirectoryPath);
                        if (!remote.success || !remote.url) {
                            showNotification('リモートリポジトリ(origin)が設定されていません', 'error');
                            return;
                        }
                    } catch (e) { console.error(e); return; }

                    showCompactConfirmModal('強制プッシュしますか？\n(リモートの履歴が上書きされます)', async () => {
                        await executeGitActionMenu(() => window.electronAPI.gitPushForce(currentDirectoryPath), '強制プッシュ完了');
                    });
                }
            },
            {
                label: '履歴を全削除 (Reset History)',
                click: async () => {
                    showCompactConfirmModal('【危険】履歴を全削除しますか？\n現在のファイル状態を「最初のコミット」として履歴をリセットします。', async () => {
                        await executeGitActionMenu(() => window.electronAPI.gitDeleteHistory(currentDirectoryPath), '履歴をリセットしました');
                    });
                }
            }
        ]);
    });
}

// ヘルパー: メニュー用Gitアクション実行ラッパー (ボタン無効化処理なし版)
async function executeGitActionMenu(apiCall, successMsg) {
    if (!currentDirectoryPath) return;
    try {
        showNotification('処理中...', 'info');
        const result = await apiCall();

        if (result.success) {
            showNotification(successMsg, 'success');
            refreshGitStatus();
        } else {
            showNotification(`エラー: ${result.error}`, 'error');
        }
    } catch (e) {
        showNotification(`予期せぬエラー: ${e.message}`, 'error');
    }
}

// ========== バックリンクパネルの実装 ==========
const btnBacklinks = document.getElementById('btn-backlinks');
const backlinksList = document.getElementById('backlinks-list');

if (btnBacklinks) {
    btnBacklinks.addEventListener('click', () => {
        if (isBacklinksVisible) {
            // 既に表示中なら閉じる
            isBacklinksVisible = false;
        } else {
            // 表示する (他を閉じる)
            isBacklinksVisible = true;
            isTerminalVisible = false;
            isPdfPreviewVisible = false;
            activeCustomLinkId = null;

            // バックリンク更新
            updateBacklinks();
        }
        updateTerminalVisibility();
    });
}

async function updateBacklinks() {
    if (!currentFilePath || !currentDirectoryPath) return;
    if (!backlinksList) return;

    backlinksList.innerHTML = '<div style="color:#888; padding:10px;">検索中...</div>';

    const fileName = path.basename(currentFilePath);

    try {
        const links = await window.electronAPI.scanBacklinks(fileName, currentDirectoryPath);

        backlinksList.innerHTML = '';

        if (links.length === 0) {
            backlinksList.innerHTML = '<div style="color:#888; padding:10px;">バックリンクはありません</div>';
            return;
        }

        links.forEach(link => {
            const div = document.createElement('div');
            div.className = 'backlink-item';
            div.innerHTML = `
                <span class="backlink-path">${link.name}</span>
                <div class="backlink-preview">${escapeHtml(link.preview)}</div>
            `;
            div.addEventListener('click', () => {
                openFile(link.path, link.name);
            });
            backlinksList.appendChild(div);
        });

    } catch (e) {
        console.error(e);
        backlinksList.innerHTML = '<div style="color:red; padding:10px;">エラーが発生しました</div>';
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

    // 各見出しの範囲（終了行）を計算
    // 次の「同レベル以上の見出し」の直前までを範囲とする
    headers.forEach((h, i) => {
        let endLine = lines.length - 1;
        for (let j = i + 1; j < headers.length; j++) {
            if (headers[j].level <= h.level) {
                endLine = headers[j].lineNumber - 1;
                break;
            }
        }
        h.endLine = endLine;
    });

    outlineTree.innerHTML = '';
    if (headers.length === 0) {
        outlineTree.innerHTML = '<li style="color: #999; padding: 5px;">見出しがありません</li>';
        return;
    }

    // 既存のスタイルがあれば削除して、常に最新のスタイル定義を適用する
    // (これにより、開発中にコードを書き換えてもスタイルが正しく更新されます)
    const existingStyle = document.getElementById('outline-tree-styles');
    if (existingStyle) {
        existingStyle.remove();
    }

    // ドラッグ＆ドロップ用のスタイルを追加
    const style = document.createElement('style');
    style.id = 'outline-tree-styles';
    style.textContent = `
        .outline-children { list-style: none; padding-left: 16px; margin: 0; display: block; }
        .outline-item-row { display: flex; align-items: center; cursor: pointer; padding: 2px 0; border-radius: 3px; border-top: 2px solid transparent; border-bottom: 2px solid transparent; }
        .outline-item-row:hover { background-color: rgba(128, 128, 128, 0.1); }
        .outline-item-row.active { background-color: rgba(0, 122, 204, 0.2); color: var(--accent-color, #007acc); }
        
        /* ドラッグ中のドロップ位置表示用スタイル */
        .outline-item-row.outline-drag-over-top { border-top: 2px solid var(--accent-color, #007acc); }
        .outline-item-row.outline-drag-over-bottom { border-bottom: 2px solid var(--accent-color, #007acc); }

        .outline-toggle { 
            width: 20px; 
            height: 20px; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            border-radius: 3px; 
            color: #888;
            flex-shrink: 0;
            visibility: hidden;
        }
        
        .outline-toggle:hover { background-color: rgba(128, 128, 128, 0.2); color: #555; }
        .outline-toggle.visible { visibility: visible; }
        
        .outline-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `;
    document.head.appendChild(style);

    // SVGのサイズを14pxに拡大し視認性を向上
    const iconCollapsed = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
    const iconExpanded = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

    // 階層管理用スタック
    const stack = [{ level: 0, container: outlineTree }];

    headers.forEach(header => {
        while (stack.length > 1 && stack[stack.length - 1].level >= header.level) {
            stack.pop();
        }
        const parent = stack[stack.length - 1];

        const li = document.createElement('li');
        li.style.listStyle = 'none';
        li.style.margin = '0';
        li.style.padding = '0';

        const row = document.createElement('div');
        row.className = 'outline-item-row outline-item';
        row.dataset.line = header.lineNumber;

        const toggle = document.createElement('span');
        toggle.className = 'outline-toggle';
        toggle.innerHTML = iconExpanded;

        const text = document.createElement('span');
        text.className = 'outline-text';
        text.textContent = header.text;
        text.style.fontSize = `${Math.max(14 - (header.level - 1), 11)}px`;

        row.appendChild(toggle);
        row.appendChild(text);
        li.appendChild(row);

        row.draggable = true;

        row.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            e.dataTransfer.effectAllowed = 'move';
            // 移動元の開始行と終了行をデータとして保持
            e.dataTransfer.setData('application/x-outline-item', JSON.stringify({
                startLine: header.lineNumber,
                endLine: header.endLine
            }));
            row.classList.add('dragging');
        });

        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            const overs = outlineTree.querySelectorAll('.outline-drag-over-top, .outline-drag-over-bottom');
            overs.forEach(el => el.classList.remove('outline-drag-over-top', 'outline-drag-over-bottom'));
        });

        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!e.dataTransfer.types.includes('application/x-outline-item')) return;

            const rect = row.getBoundingClientRect();
            const relY = e.clientY - rect.top;

            row.classList.remove('outline-drag-over-top', 'outline-drag-over-bottom');

            // 上半分なら「前に挿入」、下半分なら「後ろに挿入」
            if (relY < rect.height / 2) {
                row.classList.add('outline-drag-over-top');
            } else {
                row.classList.add('outline-drag-over-bottom');
            }
            e.dataTransfer.dropEffect = 'move';
        });

        row.addEventListener('dragleave', () => {
            row.classList.remove('outline-drag-over-top', 'outline-drag-over-bottom');
        });

        row.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            row.classList.remove('outline-drag-over-top', 'outline-drag-over-bottom');

            const data = e.dataTransfer.getData('application/x-outline-item');
            if (!data) return;
            const source = JSON.parse(data);

            const srcStart = source.startLine;
            const srcEnd = source.endLine;

            const targetStart = header.lineNumber;
            const targetEnd = header.endLine;

            const rect = row.getBoundingClientRect();
            const relY = e.clientY - rect.top;
            const insertBefore = relY < rect.height / 2;

            let insertAtLine;

            if (insertBefore) {
                // ターゲットの前に挿入
                insertAtLine = targetStart;
            } else {
                // ターゲット（とその子要素）の後ろに挿入
                insertAtLine = targetEnd + 1;
            }

            // 無効な移動チェック（自分自身の中への移動など）
            if (insertAtLine > srcStart && insertAtLine <= srcEnd + 1) {
                return;
            }
            // 移動なし
            if (insertAtLine === srcStart || insertAtLine === srcEnd + 1) {
                return;
            }

            // 実際のテキスト移動処理を実行
            moveTextRange(srcStart, srcEnd, insertAtLine);
        });

        const childrenUl = document.createElement('ul');
        childrenUl.className = 'outline-children';
        li.appendChild(childrenUl);

        parent.container.appendChild(li);

        // 親要素に子供ができたとき、クラスを追加して表示させる
        if (parent.toggleBtn) {
            if (!parent.toggleBtn.classList.contains('visible')) {
                parent.toggleBtn.classList.add('visible');

                parent.toggleBtn.onclick = (e) => {
                    e.stopPropagation();
                    const isExpanded = parent.childContainer.style.display !== 'none';
                    if (isExpanded) {
                        parent.childContainer.style.display = 'none';
                        parent.toggleBtn.innerHTML = iconCollapsed;
                    } else {
                        parent.childContainer.style.display = 'block';
                        parent.toggleBtn.innerHTML = iconExpanded;
                    }
                };
            }
        }

        row.addEventListener('click', (e) => {
            if (e.target.closest('.outline-toggle')) return;
            scrollToLine(header.lineNumber);
            const allItems = outlineTree.querySelectorAll('.outline-item-row');
            allItems.forEach(i => i.classList.remove('active'));
            row.classList.add('active');
        });

        stack.push({
            level: header.level,
            container: childrenUl,
            toggleBtn: toggle,
            childContainer: childrenUl
        });
    });
}

/**
 * エディタ内の行範囲を移動する関数
 * @param {number} srcStartLine - 移動元の開始行(0-indexed)
 * @param {number} srcEndLine - 移動元の終了行(0-indexed)
 * @param {number} destLine - 挿入先の行番号(0-indexed)。この行の直前に挿入される
 */
function moveTextRange(srcStartLine, srcEndLine, destLine) {
    if (!globalEditorView) return;

    const state = globalEditorView.state;
    const doc = state.doc;

    // 削除範囲の計算
    let delFrom = doc.line(srcStartLine + 1).from;
    let delTo;

    if (srcEndLine < doc.lines - 1) {
        // 最終行でない場合、次の行の開始位置まで削除（末尾の改行を含む）
        delTo = doc.line(srcEndLine + 2).from;
    } else {
        // 最終行の場合、ドキュメント末尾まで削除
        delTo = doc.length;
        // 先頭行でなければ、直前の改行も削除する
        if (srcStartLine > 0) {
            delFrom = doc.line(srcStartLine + 1).from - 1;
        }
    }

    // 移動するテキストを取得
    const insertionContent = doc.sliceString(delFrom, delTo);

    // 挿入位置の計算
    let insFrom;
    let finalInsertString = insertionContent;

    if (destLine >= doc.lines) {
        // ドキュメント末尾に追加
        insFrom = doc.length;
        // 移動元が末尾だった（改行なし）場合、末尾に追加する際に改行が必要
        if (srcEndLine === doc.lines - 1) {
            finalInsertString = '\n' + finalInsertString;
        }
    } else {
        // 指定行の前に挿入
        insFrom = doc.line(destLine + 1).from;

        // 移動元が末尾だった（改行なし）場合、行の間に挿入するには改行が必要
        if (srcEndLine === doc.lines - 1) {
            finalInsertString += '\n';
        }
    }

    // 変更を適用 (削除と挿入を一括実行)
    globalEditorView.dispatch({
        changes: [
            { from: delFrom, to: delTo, insert: "" },
            { from: insFrom, insert: finalInsertString }
        ],
        userEvent: "move.outline"
    });

    // フォーカスを戻す
    globalEditorView.focus();
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
        effects: EditorView.scrollIntoView(line.from, { y: "start" })
    });
    globalEditorView.focus();
}

// アウトラインの展開・折りたたみボタンのイベントリスナー設定
if (btnOutlineCollapse) {
    btnOutlineCollapse.addEventListener('click', () => {
        if (!outlineTree) return;

        // 1. すべての子リストを非表示にする
        const allChildren = outlineTree.querySelectorAll('.outline-children');
        allChildren.forEach(ul => {
            ul.style.display = 'none';
        });

        // 2. すべてのトグルボタンを「閉じた状態（右矢印）」にする
        // (clickable クラスがついている＝子供がいる要素のみ対象)
        const allToggles = outlineTree.querySelectorAll('.outline-toggle.visible');

        // updateOutlineで定義したものと同じSVG (右向き矢印)
        const iconCollapsed = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;

        allToggles.forEach(toggle => {
            toggle.innerHTML = iconCollapsed;
        });
    });
}

if (btnOutlineExpand) {
    btnOutlineExpand.addEventListener('click', () => {
        if (!outlineTree) return;

        // 1. すべての子リストを表示する
        const allChildren = outlineTree.querySelectorAll('.outline-children');
        allChildren.forEach(ul => {
            ul.style.display = 'block';
        });

        // 2. すべてのトグルボタンを「開いた状態（下矢印）」にする
        const allToggles = outlineTree.querySelectorAll('.outline-toggle.visible');

        // updateOutlineで定義したものと同じSVG (下向き矢印)
        const iconExpanded = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

        allToggles.forEach(toggle => {
            toggle.innerHTML = iconExpanded;
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

if (fileTitleInput) {
    fileTitleInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            fileTitleInput.blur();
        }
    });

    fileTitleInput.addEventListener('blur', async () => {
        const newName = fileTitleInput.value.trim();
        // 現在のファイルパスがなければ中断
        if (!newName || !currentFilePath) return;

        // パス区切り文字の判定
        const separator = currentFilePath.includes('\\') ? '\\' : '/';
        const currentFileName = currentFilePath.split(separator).pop();
        const currentExt = currentFileName.includes('.') ? '.' + currentFileName.split('.').pop() : '';
        const currentNameWithoutExt = currentFileName.replace(currentExt, '');

        // 変更がなければ終了
        if (newName === currentNameWithoutExt) return;

        try {
            if (typeof window.electronAPI?.renameFile === 'function') {
                const oldPath = currentFilePath; // 現在のパスを保存
                const result = await window.electronAPI.renameFile(currentFilePath, newName);

                if (result.success) {
                    const newPath = result.path;
                    const newFileName = newPath.split(separator).pop();

                    // 共通のリネーム後処理を呼び出し (左右の同期もここで行われる)
                    updateTabsAfterRename(oldPath, newPath, newFileName);

                    // その他の更新処理
                    updateRecentFilesAfterRename(oldPath, newPath);
                    if (typeof initializeFileTreeWithState === 'function') {
                        initializeFileTreeWithState();
                    } else {
                        initializeFileTree();
                    }
                    console.log(`Renamed ${oldPath} to ${newPath}`);
                } else {
                    console.error('Rename failed:', result.error);
                    showNotification(`ファイル名の変更に失敗しました: ${result.error}`, 'error');
                    fileTitleInput.value = currentNameWithoutExt; // 失敗時は元に戻す
                }
            }
        } catch (e) {
            console.error('Error during rename:', e);
            fileTitleInput.value = currentNameWithoutExt;
        }
    });
}

if (fileTitleInputSplit) {
    // フォーカス時に右側をアクティブにする
    fileTitleInputSplit.addEventListener('focus', () => {
        if (typeof splitEditorView !== 'undefined' && splitEditorView) {
            activePane = 'right';
            setActiveEditor(splitEditorView);
        }
    });

    // Enterキーで確定 (Blurを発火させる)
    fileTitleInputSplit.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            fileTitleInputSplit.blur();
        }
    });

    // フォーカスアウト時にリネーム実行
    fileTitleInputSplit.addEventListener('blur', async () => {
        const newName = fileTitleInputSplit.value.trim();

        // アクティブなパスを使用 (focusイベントで右側=currentFilePathになっているはず)
        if (!newName || !currentFilePath) return;

        const separator = currentFilePath.includes('\\') ? '\\' : '/';
        const currentFileName = currentFilePath.split(separator).pop();
        const currentExt = currentFileName.includes('.') ? '.' + currentFileName.split('.').pop() : '';
        const currentNameWithoutExt = currentFileName.replace(currentExt, '');

        if (newName === currentNameWithoutExt) return;

        try {
            if (typeof window.electronAPI?.renameFile === 'function') {
                const oldPath = currentFilePath;
                const result = await window.electronAPI.renameFile(currentFilePath, newName);

                if (result.success) {
                    const newPath = result.path;
                    const newFileName = newPath.split(separator).pop();

                    // 共通のリネーム後処理を呼び出し
                    updateTabsAfterRename(oldPath, newPath, newFileName);

                    updateRecentFilesAfterRename(oldPath, newPath);
                    if (typeof initializeFileTreeWithState === 'function') {
                        initializeFileTreeWithState();
                    } else {
                        initializeFileTree();
                    }
                    console.log(`Renamed (Right Pane) ${oldPath} to ${newPath}`);
                } else {
                    console.error('Rename failed:', result.error);
                    showNotification(`ファイル名の変更に失敗しました: ${result.error}`, 'error');
                    fileTitleInputSplit.value = currentNameWithoutExt;
                }
            }
        } catch (e) {
            console.error('Error during rename:', e);
            fileTitleInputSplit.value = currentNameWithoutExt;
        }
    });
}

/**
 * タイトルバーの表示・非表示と幅を、現在のファイルと設定画面の状態に合わせて更新する関数
 * 設定画面やDiff、スタートページの場合はタイトルバーを非表示にし、
 * 片方が非表示の場合はもう片方を全幅(100%)に広げて表示します。
 */
function updateFileTitleBars() {
    const mainTitleBar = document.getElementById('file-title-bar');
    const splitTitleBar = document.getElementById('file-title-bar-split');
    const fileTitleInput = document.getElementById('file-title-input');
    const fileTitleInputSplit = document.getElementById('file-title-input-split');

    if (!mainTitleBar || !splitTitleBar) return;

    // ヘルパー: タイトルバーを隠すべきパスか判定
    const shouldHide = (p) => {
        if (!p) return true; // パスなしは隠す
        const fType = getFileType(p);
        if (fType === 'image' || fType === 'pdf') return true;
        // 設定画面、スタートページ、README(互換)、Diff画面の場合は隠す
        if (p === 'settings://view' || p === 'StartPage' || p === 'README.md' || p.startsWith('DIFF://')) {
            return true;
        }
        return false;
    };

    // ヘルパー: 入力欄の値を更新
    const updateInputValue = (input, p) => {
        if (!input || !p) return;
        if (shouldHide(p)) {
            // 隠す場合でも値はセットしておく（念のため）
            const name = openedFiles.get(p)?.fileName || 'Untitled';
            input.value = name;
            input.disabled = true;
        } else {
            const name = openedFiles.get(p)?.fileName || path.basename(p);
            // 拡張子を除去して表示
            const extIndex = name.lastIndexOf('.');
            const nameNoExt = extIndex > 0 ? name.substring(0, extIndex) : name;
            input.value = nameNoExt;
            input.disabled = false;
        }
    };

    if (typeof isSplitLayoutVisible !== 'undefined' && isSplitLayoutVisible) {
        // --- 分割表示中 ---
        const leftPath = splitGroup.leftPath || (globalEditorView ? globalEditorView.filePath : null);
        const rightPath = splitGroup.rightPath || (splitEditorView ? splitEditorView.filePath : null);

        const hideLeft = shouldHide(leftPath);
        const hideRight = shouldHide(rightPath);

        // クラス操作で表示/非表示切り替え
        mainTitleBar.classList.toggle('hidden', hideLeft);
        splitTitleBar.classList.toggle('hidden', hideRight);

        // 幅とボーダーの調整
        if (!hideLeft && !hideRight) {
            // 両方表示: 保存された比率を適用
            const leftPercent = splitLayoutRatio * 100;
            const rightPercent = 100 - leftPercent;

            mainTitleBar.style.width = `${leftPercent}%`;
            mainTitleBar.style.borderRight = '1px solid var(--sidebar-border)';
            splitTitleBar.style.width = `${rightPercent}%`;
        } else if (!hideLeft && hideRight) {
            // 左のみ表示: 左を100%に
            mainTitleBar.style.width = '100%';
            mainTitleBar.style.borderRight = 'none';
        } else if (hideLeft && !hideRight) {
            // 右のみ表示: 右を100%に
            splitTitleBar.style.width = '100%';
        } else {
            // 両方隠す（設定 vs 設定 など）
        }

        // 入力欄の値更新
        updateInputValue(fileTitleInput, leftPath);
        updateInputValue(fileTitleInputSplit, rightPath);

    } else {
        // --- 全画面表示中 ---
        const currentPath = currentFilePath;
        const hide = shouldHide(currentPath);

        mainTitleBar.classList.toggle('hidden', hide);
        splitTitleBar.classList.add('hidden'); // 右は常に隠す

        if (!hide) {
            mainTitleBar.style.width = '100%';
            mainTitleBar.style.borderRight = 'none';
            updateInputValue(fileTitleInput, currentPath);
        }
    }
}

/**
 * リネーム後にタブ、内部状態、タイトルバーを一括更新する関数
 */
function updateTabsAfterRename(oldPath, newPath, newFileName) {
    // 1. openedFiles (内部管理マップ) の更新
    if (openedFiles.has(oldPath)) {
        const data = openedFiles.get(oldPath);
        data.fileName = newFileName;
        // 新しいパスで登録し直し、古いパスを削除
        openedFiles.set(newPath, data);
        openedFiles.delete(oldPath);
    }

    // 2. エディタのファイルパスプロパティ更新 (左右両方をチェック)
    if (globalEditorView && globalEditorView.filePath === oldPath) {
        globalEditorView.filePath = newPath;
    }
    // splitEditorView が存在し、かつ同じファイルを開いていた場合も更新
    if (typeof splitEditorView !== 'undefined' && splitEditorView && splitEditorView.filePath === oldPath) {
        splitEditorView.filePath = newPath;
    }

    // 3. splitGroup (画面分割管理) のパス更新
    if (typeof splitGroup !== 'undefined') {
        if (splitGroup.leftPath === oldPath) splitGroup.leftPath = newPath;
        if (splitGroup.rightPath === oldPath) splitGroup.rightPath = newPath;
    }

    // 4. カレントパスの更新 (現在アクティブなファイルがリネームされた場合)
    if (currentFilePath === oldPath) {
        currentFilePath = newPath;
    }

    // 5. タブUIの更新 (すべての該当タブの属性と表示名を更新)
    const tabs = document.querySelectorAll(`.tab[data-filepath="${CSS.escape(oldPath)}"]`);
    tabs.forEach(tab => {
        tab.dataset.filepath = newPath;

        // タブ名の更新
        const nameSpan = tab.querySelector('.tab-filename');
        if (nameSpan) {
            nameSpan.textContent = newFileName;
        }

        // 閉じるボタンのパス更新
        const closeBtn = tab.querySelector('.close-tab');
        if (closeBtn) {
            closeBtn.dataset.filepath = newPath;
        }
    });

    // 6. タイトルバー入力欄の更新 (拡張子を除いた名前を表示)
    // 拡張子の取得ロジック (既存コードに合わせて簡易実装)
    const extIndex = newFileName.lastIndexOf('.');
    const nameWithoutExt = extIndex !== -1 ? newFileName.substring(0, extIndex) : newFileName;

    // 左側 (Main) のタイトルバー更新
    if (globalEditorView && globalEditorView.filePath === newPath) {
        if (fileTitleInput) {
            fileTitleInput.value = nameWithoutExt;
        }
    }

    // 右側 (Split) のタイトルバー更新 [ここが修正ポイント: 分割時も確実に更新]
    if (typeof splitEditorView !== 'undefined' && splitEditorView && splitEditorView.filePath === newPath) {
        if (fileTitleInputSplit) {
            fileTitleInputSplit.value = nameWithoutExt;
        }
    }

    // 7. シンタックスハイライト（言語モード）の再設定 (拡張子変更に対応)
    const updateLang = (view, path) => {
        if (!view) return;
        if (typeof getLanguageExtensions === 'function' && typeof languageCompartment !== 'undefined') {
            view.dispatch({
                effects: languageCompartment.reconfigure(getLanguageExtensions(path))
            });
        }
    };

    if (globalEditorView && globalEditorView.filePath === newPath) {
        updateLang(globalEditorView, newPath);
    }
    if (typeof splitEditorView !== 'undefined' && splitEditorView && splitEditorView.filePath === newPath) {
        updateLang(splitEditorView, newPath);
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

        // 1. ファイルツリーをフォーカス可能にする
        fileContentContainer.setAttribute('tabindex', '0');

        // 2. クリック時にフォーカスを当てる（これをしないとアクティブ判定ができません）
        fileContentContainer.addEventListener('click', (e) => {
            // すでにツリー内にフォーカスがある場合（子要素選択時など）は奪わない
            if (!fileContentContainer.contains(document.activeElement)) {
                fileContentContainer.focus();
            }
        });

        // 3. ペースト処理 (document全体で監視し、ツリー選択時のみ実行)
        document.addEventListener('paste', async (e) => {
            // A. ファイルツリーが表示されていない場合は無視
            if (fileContentContainer.classList.contains('content-hidden')) return;

            // B. フォーカスがファイルツリー内（コンテナまたはその子要素）にあるかチェック
            // これにより「ファイルツリー選択状態のみ」という条件を満たします
            const isTreeActive = fileContentContainer.contains(document.activeElement) ||
                document.activeElement === fileContentContainer;

            if (!isTreeActive) return;

            // C. クリップボードにファイルが含まれている場合のみ実行
            if (e.clipboardData.files.length > 0) {
                e.preventDefault();
                e.stopPropagation();

                let targetDir = currentDirectoryPath;

                // 選択中のアイテムがあれば、その場所を基準にする
                const selectedItem = fileContentContainer.querySelector('.tree-item.selected');
                if (selectedItem) {
                    const itemPath = selectedItem.dataset.path;
                    if (selectedItem.classList.contains('file')) {
                        // ファイルなら親フォルダへ
                        targetDir = path.dirname(itemPath);
                    } else {
                        // フォルダならその中へ
                        targetDir = itemPath;
                    }
                }

                if (!targetDir) return;

                let successCount = 0;
                for (const file of e.clipboardData.files) {
                    // Electronではローカルファイルのフルパスが取得可能
                    if (file.path) {
                        try {
                            const result = await window.electronAPI.copyFileSystemEntry(file.path, targetDir);
                            if (result.success) {
                                successCount++;
                            } else {
                                showNotification(`貼り付け失敗 (${file.name}): ${result.error}`, 'error');
                            }
                        } catch (err) {
                            console.error(err);
                            showNotification(`エラー: ${err.message}`, 'error');
                        }
                    }
                }

                if (successCount > 0) {
                    showNotification(`${successCount} 件の項目を貼り付けました`, 'success');
                    // ツリーを更新
                    if (typeof initializeFileTreeWithState === 'function') {
                        await initializeFileTreeWithState();
                    } else {
                        await initializeFileTree();
                    }
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

// window load イベントリスナー全文 (setupTabReordering呼び出しを追加)
window.addEventListener('load', async () => {
    console.log('Markdown Editor loaded');

    await loadSettings();
    await loadRecentFiles();
    setupSettingsListeners();
    setupSyncSettings();
    setupSettingsNavigation(); // 設定画面のナビゲーション初期化

    setupSnippetEvents();
    renderCssSnippetsList();

    setupCustomLinkSettingsEvents();

    setupHotkeySearch();

    setupSettingsActivationHandler();

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
            // 1. ファイルツリーの更新
            if (window.fileTreeUpdateTimeout) clearTimeout(window.fileTreeUpdateTimeout);
            window.fileTreeUpdateTimeout = setTimeout(() => {
                initializeFileTreeWithState();
                if (typeof refreshGitStatus === 'function') {
                    refreshGitStatus();
                }
            }, 500);

            // 2. 現在開いているファイルの自動再読み込み判定
            if (currentFilePath && payload.filename) {
                let changedFullPath = payload.filename;

                if (!path.isAbsolute(payload.filename) && currentDirectoryPath) {
                    changedFullPath = path.join(currentDirectoryPath, payload.filename);
                }

                const normalizedCurrent = currentFilePath.replace(/\\/g, '/');
                const normalizedChanged = changedFullPath.replace(/\\/g, '/');

                if (normalizedCurrent === normalizedChanged) {
                    // 直近（2秒以内）に自分が保存したファイルなら無視する
                    const lastSave = lastSaveTimeMap.get(normalizedCurrent);
                    if (lastSave && (Date.now() - lastSave) < 2000) {
                        console.log('Ignored self-change event for:', normalizedCurrent);
                        return;
                    }

                    if (window.activeFileReloadTimeout) clearTimeout(window.activeFileReloadTimeout);
                    window.activeFileReloadTimeout = setTimeout(() => {
                        checkExternalFileChange(currentFilePath);
                    }, 600);
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

    // タブ並べ替え機能のセットアップ
    setupTabReordering();

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

    if (typeof CommandPalette !== 'undefined') {
        commandPalette = new CommandPalette();
    }

    // スニペット設定イベントもここで呼ぶ
    setupSnippetSettingsEvents();

    // すべての初期化が終わったらローディング画面を消す
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        // テーマに合わせて背景色を調整（ちらつき防止）
        if (appSettings.theme === 'dark') {
            overlay.style.backgroundColor = '#1e1e1e';
            overlay.style.color = '#ccc';
        }

        // 少し待ってからフェードアウト（初期描画の安定待ち）
        setTimeout(() => {
            overlay.style.opacity = '0';
            setTimeout(() => {
                overlay.remove();
            }, 300); // transition: opacity 0.3s に合わせる
        }, 100);
    }
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
 * テキスト、画像、PDF以外は 'external' を返すように変更
 */
function getFileType(filePath) {
    if (!filePath) return 'text';

    const fileName = path.basename(filePath).toLowerCase();
    const ext = path.extname(filePath).toLowerCase();

    // 1. 画像ファイル
    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'].includes(ext)) {
        return 'image';
    }

    // 2. PDFファイル
    if (ext === '.pdf') {
        return 'pdf';
    }

    // 3. テキストエディタで開くべき拡張子リスト
    const textExtensions = [
        // ドキュメント・データ
        '.md', '.markdown', '.txt', '.text', '.log', '.csv', '.tsv',
        // Web / Script
        '.js', '.ts', '.jsx', '.tsx', '.json',
        '.html', '.htm', '.xml',
        '.css', '.scss', '.sass', '.less',
        // プログラミング言語
        '.py', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
        '.go', '.rs', '.kt', '.swift', '.dart', '.lua', '.pl', '.pm',
        '.sh', '.bash', '.zsh', '.bat', '.ps1', '.cmd',
        '.sql', '.r', '.scala', '.bf', '.ws',
        // 設定ファイル等
        '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.properties',
        '.gradle', '.vbs', '.asm', '.s', '.vue', '.svelte', '.astro',
        '.dockerfile'
    ];

    if (textExtensions.includes(ext)) {
        return 'text';
    }

    // 4. ファイル名で判定 (拡張子がない、またはドットファイル)
    // (path.extname('.gitignore') は空文字を返すため、ファイル名でチェック)
    const textFileNames = [
        'makefile', 'license', 'changelog', 'readme', 'notice',
        '.gitignore', '.gitattributes', '.editorconfig', '.env',
        '.bashrc', '.zshrc', '.profile', 'dockerfile'
    ];

    if (textFileNames.includes(fileName) || fileName.startsWith('.env')) {
        return 'text';
    }

    // 5. ドットで始まるファイル（拡張子なし）は設定ファイルとみなしてテキスト扱い（安全策）
    if (fileName.startsWith('.') && ext === '') {
        return 'text';
    }

    // 上記以外（Officeファイル、exe、zipなど）は外部アプリで開く
    return 'external';
}

// グローバル変数としてイベントハンドラを保持（重複登録防止のため）
let globalMediaKeyHandler = null;

/**
 * 画像やPDFを #media-view に描画する関数
 * 修正: タブ切替時のショートカット不具合修正、フォーカス強制、ズーム状態の維持
 */
async function renderMediaContent(filePath, type) {
    let container = document.getElementById('media-view');

    // 1. コンテナが存在しない場合は作成
    if (!container) {
        container = document.createElement('div');
        container.id = 'media-view';
        container.className = 'hidden';
        container.tabIndex = -1; // フォーカス可能にするために必要

        const editorEl = document.getElementById('editor');
        if (editorEl && editorEl.parentElement) {
            editorEl.parentElement.appendChild(container);
        } else {
            const centerPane = document.getElementById('center-pane');
            if (centerPane) centerPane.appendChild(container);
        }
    }

    // 2. 前回のキーハンドラを確実に削除 (重複防止)
    if (globalMediaKeyHandler) {
        window.removeEventListener('keydown', globalMediaKeyHandler, { capture: true });
        globalMediaKeyHandler = null;
    }

    // 3. エディタ類を非表示にする
    const editorEl = document.getElementById('editor');
    if (editorEl) editorEl.style.display = 'none';
    const splitEl = document.getElementById('editor-split');
    if (splitEl) splitEl.style.display = 'none';
    const diffEl = document.getElementById('diff-view-container');
    if (diffEl) diffEl.style.display = 'none';

    // 4. メディアビューを表示し、フォーカスを強制する (これが重要)
    container.classList.remove('hidden');
    container.style.display = 'flex';
    container.focus(); // エディタからフォーカスを奪う

    // 状態変数の準備 (既存の状態があれば引き継ぐ)
    let isNewFile = (container.dataset.currentFile !== filePath);
    container.dataset.currentFile = filePath;

    // 画像用ヘルパー関数 (リスナーで共有するためにここで定義)
    // 状態は container._mediaState オブジェクトで管理する
    if (!container._mediaState || isNewFile) {
        container._mediaState = { scale: 1, pannedX: 0, pannedY: 0 };
    }
    const state = container._mediaState;

    const getImg = () => container.querySelector('img');
    const updateTransform = () => {
        const img = getImg();
        if (img) {
            img.style.transform = `translate(${state.pannedX}px, ${state.pannedY}px) scale(${state.scale})`;
        }
    };
    const zoom = (delta) => {
        const newScale = Math.min(Math.max(0.1, state.scale + delta), 10);
        state.scale = newScale;
        updateTransform();
    };

    // --- コンテンツの描画 (新規ファイルの場合のみ) ---
    if (isNewFile) {
        container.innerHTML = '';

        // パスの正規化
        const normalizedPath = filePath.replace(/\\/g, '/');
        const fileUrl = normalizedPath.startsWith('/') ? `file://${normalizedPath}` : `file:///${normalizedPath}`;

        // スタイル設定
        Object.assign(container.style, {
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            height: '100%',
            width: '100%',
            flex: '1',
            overflow: 'hidden',
            backgroundColor: '#1e1e1e',
            position: 'relative',
            cursor: 'default',
            outline: 'none'
        });

        if (type === 'image') {
            const img = document.createElement('img');
            img.src = fileUrl;
            Object.assign(img.style, {
                maxWidth: '100%',
                maxHeight: '100%',
                cursor: 'grab',
                transition: 'transform 0.08s ease-out',
                transformOrigin: 'center center',
                userSelect: 'none',
                willChange: 'transform'
            });
            container.appendChild(img);

            // マウス操作系リスナーの設定
            let isDragging = false;
            let startX = 0;
            let startY = 0;

            container.onwheel = (e) => {
                // 拡大縮小
                if (e.ctrlKey) {
                    e.preventDefault();
                    zoom(e.deltaY > 0 ? -0.1 : 0.1);
                } else {
                    // スクロール等の微調整
                    e.preventDefault();
                    zoom(e.deltaY > 0 ? -0.05 : 0.05);
                }
            };

            img.onmousedown = (e) => {
                e.preventDefault();
                isDragging = true;
                startX = e.clientX - state.pannedX;
                startY = e.clientY - state.pannedY;
                img.style.cursor = 'grabbing';
                img.style.transition = 'none';
            };

            const onMouseMove = (e) => {
                if (!isDragging) return;
                e.preventDefault();
                state.pannedX = e.clientX - startX;
                state.pannedY = e.clientY - startY;
                updateTransform();
            };
            const onMouseUp = () => {
                if (isDragging) {
                    isDragging = false;
                    const el = getImg();
                    if (el) {
                        el.style.cursor = 'grab';
                        el.style.transition = 'transform 0.08s ease-out';
                    }
                }
            };
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);

            container.ondblclick = () => {
                state.scale = 1;
                state.pannedX = 0;
                state.pannedY = 0;
                const el = getImg();
                if (el) {
                    el.style.transition = 'transform 0.3s ease';
                    updateTransform();
                    setTimeout(() => { el.style.transition = 'transform 0.08s ease-out'; }, 300);
                }
            };

        } else if (type === 'pdf') {
            const iframe = document.createElement('iframe');
            iframe.src = fileUrl;
            Object.assign(iframe.style, {
                width: '100%',
                height: '100%',
                border: 'none',
                display: 'block',
                pointerEvents: 'auto' // クリックイベントを受け取る
            });
            container.appendChild(iframe);
        }
    } else {
        // 既存ファイルの場合、画像位置などを復元
        if (type === 'image') {
            updateTransform();
        }
    }

    // 5. ショートカットキーハンドラの登録 (毎回必ず実行)
    globalMediaKeyHandler = (e) => {
        // 表示中でなければ無視
        if (container.classList.contains('hidden') || container.style.display === 'none') return;

        // キーバインド判定用ヘルパー関数
        const matchesCommand = (commandId) => {
            const bindings = getKeybindingsForCommand(commandId); // ['Mod-;', 'Mod-='] などを取得
            const isMac = navigator.platform.toUpperCase().includes('MAC');

            return bindings.some(binding => {
                const parts = binding.split('-');
                let keyName = parts.pop();
                // 'Mod--' のように末尾がハイフンの場合、splitの結果末尾が空文字になるため補正する
                if (keyName === '') {
                    keyName = '-';
                    // もし配列にまだ空文字が残っていれば整理（必須ではないが安全のため）
                    if (parts.length > 0 && parts[parts.length - 1] === '') {
                        parts.pop();
                    }
                }

                keyName = keyName.toLowerCase();

                const reqShift = parts.includes('Shift');
                const reqAlt = parts.includes('Alt');
                const reqCtrl = parts.includes('Ctrl');
                const reqMeta = parts.includes('Meta');
                const reqMod = parts.includes('Mod');

                // Shift & Alt の判定
                if (e.shiftKey !== reqShift) return false;
                if (e.altKey !== reqAlt) return false;

                // Mod (Mac:Cmd, Win:Ctrl) の解決
                const effectiveCtrl = reqCtrl || (reqMod && !isMac);
                const effectiveMeta = reqMeta || (reqMod && isMac);

                // Ctrl & Meta の判定 (厳密にチェック)
                if (e.ctrlKey !== effectiveCtrl) return false;
                if (e.metaKey !== effectiveMeta) return false;

                // キーコードの判定
                return e.key.toLowerCase() === keyName;
            });
        };

        // 画像操作
        if (type === 'image') {
            if (matchesCommand('view:font-zoom-in')) {
                e.preventDefault(); e.stopPropagation();
                zoom(0.1);
                return;
            } else if (matchesCommand('view:font-zoom-out')) {
                e.preventDefault(); e.stopPropagation();
                zoom(-0.1);
                return;
            } else if (matchesCommand('view:font-zoom-reset')) {
                e.preventDefault(); e.stopPropagation();
                state.scale = 1; state.pannedX = 0; state.pannedY = 0;
                updateTransform();
                return;
            }
        }

        // PDF/画像共通: エディタ設定への干渉ブロック
        // (PDF表示中もズームショートカット等で裏のエディタ設定が変わらないようにする)
        if (matchesCommand('view:font-zoom-in') ||
            matchesCommand('view:font-zoom-out') ||
            matchesCommand('view:font-zoom-reset')) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    // 最優先でイベントを捕捉する (capture: true)
    window.addEventListener('keydown', globalMediaKeyHandler, { capture: true });

    // UI設定を再適用
    applySettingsToUI();
}

// ========== コンフリクト解消機能の実装 ==========

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
 * @param {string|null} commitOid - (オプション) 過去のコミットを指定。nullの場合はWorking Tree vs HEAD。
 */
async function openDiffView(filePath, commitOid = null) {
    if (!currentDirectoryPath) return;

    // Diffを開く際にREADMEが表示されていたら閉じる
    if (openedFiles.has('StartPage')) {
        closeWelcomeReadme();
    }

    // 1. Diff用の仮想パスとタブ名を作成
    // コミットIDがある場合はパスに含めて一意にする
    let diffPath, tabName;
    const fileName = path.basename(filePath);

    if (commitOid) {
        // 過去のコミット比較モード
        diffPath = `DIFF://${commitOid}/${filePath}`;
        tabName = `Diff: ${fileName} (${commitOid.substring(0, 7)})`;
    } else {
        // 通常のワーキングツリー比較モード
        diffPath = `DIFF://${filePath}`;
        tabName = `Diff: ${fileName}`;
    }

    try {
        let headContent = "";
        let rightContent = "";
        let isRightEditable = true; // デフォルトは編集可能

        if (commitOid) {
            // --- 過去のコミットモード (Read-only) ---
            // A (Left): 親コミット (~1)
            // git show commit~1:path
            const parentRes = await window.electronAPI.gitShow(currentDirectoryPath, `${commitOid}~1`, filePath);
            headContent = parentRes.success ? parentRes.content : "";

            // B (Right): 対象コミット
            // git show commit:path
            const targetRes = await window.electronAPI.gitShow(currentDirectoryPath, commitOid, filePath);
            rightContent = targetRes.success ? targetRes.content : "";

            isRightEditable = false; // 過去のログなので編集不可
        } else {
            // --- 既存の HEAD vs Local モード ---
            // A (Left): HEAD (Staged/Committed)
            const headResult = await window.electronAPI.gitShow(currentDirectoryPath, 'HEAD', filePath);
            headContent = headResult.success ? headResult.content : "";

            // B (Right): ワーキングツリーの内容
            // 現在エディタで開いているタブがあればその内容を、なければディスクから読み込む
            const existingTab = openedFiles.get(filePath); // filePathは相対パスだが、openedFilesのキーは絶対パスの場合があることに注意が必要（※）

            // ※ openedFilesのキーは通常絶対パスなので、相対パスではヒットしない可能性があります。
            // 念のため絶対パスでも検索します。
            const absPath = path.join(currentDirectoryPath, filePath);
            const existingTabData = openedFiles.get(absPath);

            if (existingTabData && existingTabData.content) {
                // 既に開いていて編集中の内容があればそれを使う（未保存の変更も反映するため）
                rightContent = existingTabData.content;
            } else {
                // 開いていない場合はディスクから最新を読み込む
                try {
                    rightContent = await window.electronAPI.loadFile(absPath);
                } catch (e) {
                    console.error('Failed to load local file for diff:', e);
                    rightContent = "Error loading file content.";
                }
            }
        }

        // 3. データを登録・更新
        openedFiles.set(diffPath, {
            type: 'diff',
            fileName: tabName,
            content: rightContent,      // Right (Editor/Modified)
            headContent: headContent,   // Left (Original/HEAD)
            originalPath: commitOid ? null : path.join(currentDirectoryPath, filePath), // 過去ログなら保存先なし
            isVirtual: true,
            readOnly: !isRightEditable, // フラグ: MergeView側で編集不可にするために使用
            commitOid: commitOid        // 追跡用
        });

        // 4. タブがない場合は作成
        let tab = editorTabsContainer.querySelector(`.tab[data-filepath="${CSS.escape(diffPath)}"]`);
        if (!tab) {
            tab = document.createElement('div');
            tab.className = 'tab';
            tab.dataset.filepath = diffPath;
            tab.innerHTML = `<span class="tab-filename">${tabName}</span> <span class="close-tab" data-filepath="${diffPath}">×</span>`;
            if (typeof enableTabDragging === 'function') enableTabDragging(tab);
            editorTabsContainer.appendChild(tab);
        }

        // 5. 表示内容の強制更新 (DOMに残った古いDiffをクリアして再描画させる)
        const diffContainer = document.getElementById('diff-view-container');
        if (diffContainer && diffContainer.dataset.filepath === diffPath) {
            diffContainer.innerHTML = '';
            diffContainer.dataset.filepath = '';
        }

        // 6. タブを開く (switchToFile -> MergeView生成)
        switchToFile(diffPath);

    } catch (e) {
        console.error('Failed to open diff view:', e);
        if (typeof showNotification === 'function') {
            showNotification(`Diff表示エラー: ${e.message}`, 'error');
        }
    }
}

/**
 * ファイルを開く関数
 * 'external' タイプの場合は外部アプリで起動する処理を追加
 */
async function openFile(filePath, fileName) {
    const normalizedPath = path.resolve(filePath);
    const fileType = getFileType(normalizedPath);

    // 外部アプリで開くファイルの場合
    if (fileType === 'external') {
        try {
            await window.electronAPI.openPath(normalizedPath);
            showNotification('外部アプリでファイルを開きました', 'success');
        } catch (e) {
            console.error(e);
            showNotification(`外部アプリでのオープンに失敗: ${e.message}`, 'error');
        }
        return;
    }

    addToRecentFiles(normalizedPath);

    try {
        if (openedFiles.has('StartPage')) {
            closeWelcomeReadme();
        }

        // 既に開いている場合のチェック
        const isLeftFile = globalEditorView && globalEditorView.filePath === normalizedPath;
        const isRightFile = isSplitView && splitEditorView && splitEditorView.filePath === normalizedPath;

        if (isLeftFile) {
            setActiveEditor(globalEditorView);
            activePane = 'left';
            return;
        }
        if (isRightFile) {
            setActiveEditor(splitEditorView);
            activePane = 'right';
            return;
        }

        let tab = document.querySelector(`[data-filepath="${CSS.escape(normalizedPath)}"]`);
        let fileContent = '';

        // テキストファイルなら一括で読み込む
        if (fileType === 'text') {
            try {
                fileContent = await window.electronAPI.loadFile(normalizedPath);
            } catch (error) {
                console.error('Failed to load file:', error);
                fileContent = `エラー: ${error.message}`;
            }
        } else {
            fileContent = null;
        }

        if (!tab) {
            tab = document.createElement('div');
            tab.className = 'tab';
            tab.dataset.filepath = normalizedPath;
            tab.innerHTML = `<span class="tab-filename">${fileName}</span> <span class="close-tab" data-filepath="${normalizedPath}">×</span>`;
            enableTabDragging(tab);
            editorTabsContainer.appendChild(tab);

            openedFiles.set(normalizedPath, {
                content: fileContent,
                fileName: fileName,
                type: fileType
            });
        }

        // 新しいファイルは常にメインペイン(左)で開く
        const targetPane = 'left';
        switchToFile(normalizedPath, targetPane);

    } catch (error) {
        console.error('Failed to open file:', error);
    }
}

function showWelcomeReadme() {
    const readmePath = 'StartPage';
    if (openedFiles.has(readmePath)) return;

    openedFiles.set(readmePath, {
        content: startDoc,
        fileName: 'スタートページ',
        isVirtual: true
    });

    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.filepath = readmePath;
    tab.innerHTML = `スタートページ`;

    if (editorTabsContainer) {
        editorTabsContainer.appendChild(tab);
    }

    switchToFile(readmePath);
}

function closeWelcomeReadme() {
    const readmePath = 'StartPage';
    const readmeTab = document.querySelector(`[data-filepath="${readmePath}"]`);

    if (readmeTab) {
        readmeTab.remove();
        openedFiles.delete(readmePath);
        fileModificationState.delete(readmePath);
    }
}

function switchToFile(filePath, targetPane = 'left') {

    const previouslyActivePath = currentFilePath;

    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }

    const fileData = openedFiles.get(filePath);
    if (!fileData && filePath !== 'StartPage') return;

    // 1. 直前のファイル状態保存
    if (previouslyActivePath && openedFiles.has(previouslyActivePath)) {
        const currentFileData = openedFiles.get(previouslyActivePath);
        if (currentFileData && currentFileData.type !== 'settings' && currentFileData.type !== 'diff' && (!currentFileData.type || currentFileData.type === 'text')) {
            let sourceView = null;
            if (globalEditorView && globalEditorView.filePath === previouslyActivePath) sourceView = globalEditorView;
            else if (splitEditorView && splitEditorView.filePath === previouslyActivePath) sourceView = splitEditorView;

            if (sourceView) {
                currentFileData.editorState = sourceView.state;
                currentFileData.content = sourceView.state.doc.toString();
            }
        }
    }

    // 2. レイアウト表示/非表示判定と切り替え
    const isSplitGroupMember = filePath === splitGroup.leftPath || filePath === splitGroup.rightPath;

    if (isSplitGroupMember) {
        showSplitLayout();

        const settingsEl = getSettingsElement();
        if (settingsEl) {
            const editorWrapper = document.getElementById('editor-wrapper');
            if (splitGroup.leftPath === 'settings://view') {
                settingsEl.classList.remove('content-hidden');
                settingsEl.style.cssText = 'flex:1; width:100%; height:100%;';
                const leftEditorDiv = document.getElementById('editor');
                if (leftEditorDiv) leftEditorDiv.style.display = 'none';
                if (settingsEl.parentElement !== editorWrapper || editorWrapper.firstElementChild !== settingsEl) {
                    editorWrapper.insertBefore(settingsEl, editorWrapper.firstChild);
                }
            } else if (splitGroup.rightPath === 'settings://view') {
                settingsEl.classList.remove('content-hidden');
                settingsEl.style.cssText = 'flex:1; width:100%; height:100%;';
                const rightEditorDiv = document.getElementById('editor-split');
                if (rightEditorDiv) rightEditorDiv.style.display = 'none';
                if (settingsEl.parentElement !== editorWrapper || editorWrapper.lastElementChild !== settingsEl) {
                    editorWrapper.appendChild(settingsEl);
                }
            }
        }

        if (splitGroup.leftPath && globalEditorView.filePath !== splitGroup.leftPath) {
            const leftData = openedFiles.get(splitGroup.leftPath);
            if (leftData && leftData.type !== 'settings') {
                const editorEl = document.getElementById('editor');
                if (editorEl) editorEl.style.display = 'block';
                if (leftData.editorState) {
                    globalEditorView.setState(leftData.editorState);
                } else {
                    globalEditorView.setState(createEditorState(leftData.content || '', splitGroup.leftPath));
                }
                globalEditorView.filePath = splitGroup.leftPath;
            }
        }
        if (splitGroup.rightPath && splitEditorView && splitEditorView.filePath !== splitGroup.rightPath) {
            const rightData = openedFiles.get(splitGroup.rightPath);
            if (rightData && rightData.type !== 'settings') {
                document.getElementById('editor-split').style.display = 'block';
                if (rightData.editorState) {
                    splitEditorView.setState(rightData.editorState);
                } else {
                    splitEditorView.setState(createEditorState(rightData.content || '', splitGroup.rightPath));
                }
                splitEditorView.filePath = splitGroup.rightPath;
            }
        }

        if (filePath === splitGroup.rightPath) targetPane = 'right';
        else targetPane = 'left';

    } else {
        hideSplitLayout();
        targetPane = 'left';
    }

    // 3. ターゲットビュー決定
    let targetView;
    let isMainPane = false;

    if (targetPane === 'right' && isSplitLayoutVisible && splitEditorView) {
        targetView = splitEditorView;
        isMainPane = false;
    } else {
        targetView = globalEditorView;
        isMainPane = true;
    }

    // 4. カレントパス更新
    currentFilePath = filePath;

    const fileType = fileData ? (fileData.type || 'text') : getFileType(filePath);
    const isSettings = (fileType === 'settings');
    const isDiff = (fileType === 'diff');

    switchMainView('content-readme');

    const editorWrapper = document.getElementById('editor-wrapper');
    const settingsEl = getSettingsElement();
    const leftEditorDiv = document.getElementById('editor');
    const rightEditorDiv = document.getElementById('editor-split');
    const mediaViewEl = document.getElementById('media-view');

    let diffContainer = document.getElementById('diff-view-container');
    if (!diffContainer) {
        diffContainer = document.createElement('div');
        diffContainer.id = 'diff-view-container';
        diffContainer.className = 'editor-container';
        diffContainer.style.cssText = 'display:none; width:100%; height:100%; overflow:hidden; flex-direction: column;';
        editorWrapper.appendChild(diffContainer);
    }

    if (!isSettings && settingsEl && settingsEl.parentElement === editorWrapper) {
        let shouldDetach = true;
        if (isSplitLayoutVisible) {
            if (targetPane === 'left' && splitGroup.rightPath === 'settings://view') shouldDetach = false;
            else if (targetPane === 'right' && splitGroup.leftPath === 'settings://view') shouldDetach = false;
        }
        if (shouldDetach) detachSettingsView();
    }

    if (isDiff) {
        // ========== Diffモード (Git比較表示) ==========
        if (leftEditorDiv) leftEditorDiv.style.display = 'none';
        if (rightEditorDiv) rightEditorDiv.style.display = 'none';
        if (mediaViewEl) mediaViewEl.classList.add('hidden');

        diffContainer.style.display = 'flex';

        // スクロール対策スタイル
        if (!document.getElementById('merge-view-styles')) {
            const style = document.createElement('style');
            style.id = 'merge-view-styles';
            style.textContent = `
                .cm-merge-view { height: 100%; flex: 1; overflow: hidden; }
                .cm-merge-view .cm-editor { height: 100%; }
                .cm-merge-view .cm-scroller { overflow: auto; }
            `;
            document.head.appendChild(style);
        }

        if (diffContainer.dataset.filepath !== filePath) {
            diffContainer.innerHTML = '';
            diffContainer.dataset.filepath = filePath;

            const docA = fileData.headContent || ''; // HEAD
            const docB = fileData.content || '';     // Local
            const actualPath = fileData.originalPath || filePath;

            const commonDiffExtensions = [
                EditorView.lineWrapping,
                highlightActiveLine(),
                drawSelection(),
                dropCursor(),
                bracketMatching(),
                appSettings.showLineNumbers ? lineNumbers() : [], // 行番号設定の反映
                appSettings.theme === 'dark' ? oneDark : [],      // ダークテーマ対応
                EditorView.theme({
                    "&": { height: "100%" },
                    ".cm-scroller": { overflow: "auto" }
                })
            ];

            globalDiffView = new MergeView({
                a: {
                    doc: docA,
                    extensions: [
                        EditorView.editable.of(false),
                        EditorState.readOnly.of(true),
                        ...commonDiffExtensions,
                        getLanguageExtensions(actualPath)
                    ]
                },
                b: {
                    doc: docB,
                    extensions: [
                        // fileData.readOnly フラグに基づいて編集可否を制御する
                        EditorView.editable.of(!fileData.readOnly),
                        fileData.readOnly ? EditorState.readOnly.of(true) : [],
                        ...commonDiffExtensions,
                        history(),
                        keymap.of([...defaultKeymap, ...historyKeymap]),
                        getLanguageExtensions(actualPath),
                        EditorView.updateListener.of(v => {
                            if (v.docChanged) {
                                // 1. ファイルのコンテンツ文字列を更新
                                fileData.content = v.state.doc.toString();
                                // 2. メインエディタの古い状態(editorState)を破棄
                                // これにより、通常画面に戻った時に新しいcontentから再描画される
                                fileData.editorState = null;
                                onEditorInput(true);
                            }
                        })
                    ]
                },
                parent: diffContainer,
                highlightChanges: true,
                sidebar: false,
                gutter: true
            });
        }

        // アクティブなエディタをDiffの右側(b)に設定
        // これにより、Diff画面でのCtrl+S保存などが正しく機能する
        if (globalDiffView) {
            targetView = globalDiffView.b;
            // DiffViewの右側にもパス情報を設定しておくと安全
            targetView.filePath = filePath;
        }

    } else if (isSettings) {
        if (diffContainer) diffContainer.style.display = 'none';

        if (settingsEl) {
            settingsEl.classList.remove('content-hidden');
            settingsEl.style.cssText = 'flex:1; width:100%; height:100%;';

            if (targetPane === 'left') {
                if (leftEditorDiv) leftEditorDiv.style.display = 'none';
                if (mediaViewEl) mediaViewEl.classList.add('hidden');
                editorWrapper.insertBefore(settingsEl, editorWrapper.firstChild);
                if (isSplitLayoutVisible && rightEditorDiv && splitGroup.rightPath !== 'settings://view') {
                    rightEditorDiv.style.display = 'block';
                }
            } else {
                if (rightEditorDiv) rightEditorDiv.style.display = 'none';
                editorWrapper.appendChild(settingsEl);
                if (leftEditorDiv && splitGroup.leftPath !== 'settings://view') {
                    leftEditorDiv.style.display = 'block';
                }
            }
            if (targetView) targetView.filePath = filePath;
        }

    } else if (!isSplitGroupMember) {
        if (diffContainer) diffContainer.style.display = 'none';

        if (targetPane === 'left') {
            if (leftEditorDiv) leftEditorDiv.style.display = 'block';
        }

        if (fileType === 'text') {
            if (targetView) {
                if (fileData && fileData.editorState) {
                    targetView.setState(fileData.editorState);
                } else {
                    const fileContent = fileData ? fileData.content : '';
                    targetView.setState(createEditorState(fileContent, filePath));
                }
                targetView.filePath = filePath;
            }
            if (isMainPane && mediaViewEl) mediaViewEl.classList.add('hidden');
        } else {
            if (isMainPane) {
                renderMediaContent(filePath, fileType);
                if (leftEditorDiv) leftEditorDiv.style.display = 'none';
                if (mediaViewEl) mediaViewEl.classList.remove('hidden');
            }
            if (targetView) targetView.filePath = filePath;
        }
    } else {
        if (diffContainer) diffContainer.style.display = 'none';
    }

    // --- タイトルバーの更新ロジックを共通関数に置き換え ---
    updateFileTitleBars();

    if (fileData) {
        document.title = `${fileData.fileName} - Markdown Editor`;
    }

    updateOutline();
    updateFileStats();
    setActiveEditor(targetView);
    onEditorInput(false);

    if (isBacklinksVisible) updateBacklinks();

    const btnPreview = document.getElementById('btn-toggle-preview');
    const btnCloseSplit = document.getElementById('btn-close-split');

    if (isSplitLayoutVisible) {
        if (btnCloseSplit) btnCloseSplit.classList.remove('disabled');
        if (splitGroup.leftPath === splitGroup.rightPath) {
            isPreviewMode = true;
            if (btnPreview) btnPreview.classList.add('active');
        } else {
            isPreviewMode = false;
            if (btnPreview) btnPreview.classList.remove('active');
        }
    } else {
        if (btnCloseSplit) btnCloseSplit.classList.add('disabled');
        isPreviewMode = false;
        if (btnPreview) btnPreview.classList.remove('active');
    }
}

/**
 * ファイルのタブを閉じる関数
 * @param {HTMLElement} element - 閉じるタブのDOM要素
 * @param {boolean} isSettings - 設定タブかどうか
 */
function closeTab(element, isSettings = false) {
    const filePath = element.dataset.filepath;
    const isSettingsFile = (filePath === 'settings://view');

    // 実際の閉じる処理を行う内部関数
    const performClose = () => {
        if (element) element.remove();

        if (filePath) {
            // 設定画面の場合はDOMを退避
            if (isSettingsFile) {
                detachSettingsView();
            }

            const fileData = openedFiles.get(filePath);

            // 履歴保存 (設定画面以外)
            if (fileData && !isSettingsFile) {
                closedTabsHistory.push({
                    path: filePath,
                    fileName: fileData.fileName,
                    content: fileData.content || (globalEditorView && currentFilePath === filePath ? globalEditorView.state.doc.toString() : ''),
                    isVirtual: fileData.isVirtual || false
                });
                if (closedTabsHistory.length > 20) closedTabsHistory.shift();
            }

            // 分割グループメンバーが閉じられた場合、分割を強制的に解除する
            const isSplitGroupMember = filePath === splitGroup.leftPath || filePath === splitGroup.rightPath;

            if (isSplitGroupMember) {
                if (isSplitLayoutVisible) {
                    closeSplitView();
                } else {
                    splitGroup.leftPath = null;
                    splitGroup.rightPath = null;
                    isSplitView = false;
                }
            }

            openedFiles.delete(filePath);
            fileModificationState.delete(filePath);

            if (currentFilePath === filePath) {
                currentFilePath = null;
                // エディタクリア
                if (globalEditorView && !isSettingsFile) {
                    globalEditorView.dispatch({
                        changes: { from: 0, to: globalEditorView.state.doc.length, insert: "" },
                        annotations: ExternalChange.of(true)
                    });
                }
                switchToLastFileOrReadme();
            }
        } else if (isSettings) {
            // fallback: datasetがない場合
            if (element) element.remove();
            detachSettingsView();
            switchToLastFileOrReadme();
        }
    };

    // --- ここから保存確認ロジック ---
    if (filePath && !isSettingsFile) {
        const isDirty = fileModificationState.get(filePath);
        const fileData = openedFiles.get(filePath);
        const isVirtual = fileData && fileData.isVirtual;

        if (isDirty) {
            // ケース1: 自動保存がON、かつ実ファイル(パスがある)の場合 -> 即保存して閉じる
            if (appSettings.autoSave && !isVirtual) {
                saveCurrentFile(false, filePath).then(() => {
                    performClose();
                });
                return;
            }

            // ケース2: 自動保存OFF、または未保存の新規ファイルの場合 -> 確認ダイアログを出す
            showSaveConfirmModal(
                fileData ? fileData.fileName : 'Untitled',
                async () => {
                    // 「保存する」が選ばれた場合
                    await saveCurrentFile(false, filePath);
                    // 保存後に再度ダーティチェック（キャンセルされた場合などを考慮）
                    if (!fileModificationState.get(filePath)) {
                        performClose();
                    }
                },
                () => {
                    // 「保存しない」が選ばれた場合 -> そのまま閉じる（破棄）
                    performClose();
                }
            );
            return; // ダイアログの結果待ちなのでここで中断
        }
    }

    // 変更がない、または設定タブの場合は即座に閉じる
    performClose();
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

async function saveCurrentFile(isSaveAs = false, targetPath = null) {
    const filePath = targetPath || currentFilePath;

    if (!filePath) {
        console.warn('ファイルが選択されていません');
        return;
    }

    let content;
    const fileData = openedFiles.get(filePath);

    // PDFや画像などのバイナリファイルは保存処理を行わない（破壊防止）
    if (fileData && fileData.type && fileData.type !== 'text' && fileData.type !== 'diff' && fileData.type !== 'settings') {
        console.log('バイナリファイルのため保存をスキップしました:', filePath);
        return;
    }

    // --- コンテンツ取得ロジックの修正 ---

    // Diffモードの場合
    if (fileData && fileData.type === 'diff') {
        if (globalDiffView) {
            content = globalDiffView.b.state.doc.toString();
        } else {
            content = fileData.content;
        }
        // 保存先は仮想パス(DIFF://...)ではなく、実ファイルパスを使う
        if (!targetPath) targetPath = fileData.originalPath;

    } else {
        // 通常モード: パスが一致するエディタを探して内容を取得
        let sourceView = null;

        if (globalEditorView && globalEditorView.filePath === filePath) {
            sourceView = globalEditorView;
        } else if (splitEditorView && splitEditorView.filePath === filePath) {
            sourceView = splitEditorView;
        } else if (filePath === currentFilePath) {
            // パスが一致するものがない場合（基本ありえませんが）、アクティブなものを使用
            sourceView = getActiveView();
        }

        if (sourceView) {
            content = sourceView.state.doc.toString();
        } else if (fileData && fileData.content !== undefined) {
            // エディタに表示されていない（裏にある）場合はメモリ上のデータを使用
            content = fileData.content;
        } else if (targetPath && targetPath !== currentFilePath) {
            // ターゲット指定保存（別名保存など）で、まだ開いていない場合
            const targetFileData = openedFiles.get(targetPath);
            content = targetFileData ? targetFileData.content : "";
        }

        // それでも取得できない場合は処理中断
        if (content === undefined || content === null) {
            console.warn(`Content for ${filePath} not found.`);
            return;
        }
    }

    if (currentFilePath === 'StartPage' && !isSaveAs) return;

    try {
        // ▼ 仮想ファイル（新規作成）または「名前を付けて保存」の場合
        if ((fileData && fileData.isVirtual && fileData.type !== 'diff') || isSaveAs) {

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
            const savePath = (fileData && fileData.type === 'diff') ? targetPath : filePath;

            if (typeof window.electronAPI?.saveFile === 'function') {
                await window.electronAPI.saveFile(savePath, content);

                // 保存時刻を記録 (現在時刻 + 猶予を持たせるため少し未来の時間にするのが安全ですが、今回は現在時刻で管理します)
                const mapKey = savePath.replace(/\\/g, '/');
                lastSaveTimeMap.set(mapKey, Date.now());

                if (fileData) {
                    fileData.content = content;
                }

                // Diffかどうかにかかわらず、保存された実ファイルの未保存状態をクリア
                fileModificationState.delete(savePath);

                // 実ファイルのタブがあれば更新（●を消す）
                const realTab = document.querySelector(`[data-filepath="${CSS.escape(savePath)}"]`);
                if (realTab) {
                    const fileName = path.basename(savePath);
                    realTab.innerHTML = `<span class="tab-filename">${fileName}</span> <span class="close-tab" data-filepath="${savePath}">×</span>`;
                }

                // Diffビューの場合、Diffタブ自体の未保存状態もクリア
                if (fileData.type === 'diff') {
                    // ここでの filePath は DIFF://... のパス
                    fileModificationState.delete(filePath);
                    const diffTab = document.querySelector(`[data-filepath="${CSS.escape(filePath)}"]`);
                    if (diffTab) {
                        const fileName = fileData.fileName; // "Diff: filename"
                        diffTab.innerHTML = `<span class="tab-filename">${fileName}</span> <span class="close-tab" data-filepath="${filePath}">×</span>`;
                    }
                }
            }
        }
    } catch (error) {
        console.error('Failed to save file:', error);
        showNotification(`保存エラー: ${error.message}`, 'error');
    }
}

// タブの選択状態（青色）を更新するヘルパー関数
function updateTabVisuals() {
    const tabs = document.querySelectorAll('.editor-tabs .tab');
    tabs.forEach(tab => {
        const path = tab.dataset.filepath;

        // 設定タブかどうかにかかわらず、現在のファイルパスと一致するかで判定
        // (設定タブのパスは 'settings://view' となっている前提)
        if (path === currentFilePath) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
}

// アクティブなエディタを設定する関数（タブ表示更新を追加）
function setActiveEditor(view) {
    activeEditorView = view;

    const mainWrapper = document.getElementById('editor');
    const splitWrapper = document.getElementById('editor-split');

    // スタイルの切り替え（青い枠をつける）
    if (view === splitEditorView) {
        if (splitWrapper) splitWrapper.classList.add('active-editor-pane');
        if (mainWrapper) mainWrapper.classList.remove('active-editor-pane');
        activePane = 'right';
    } else {
        if (mainWrapper) mainWrapper.classList.add('active-editor-pane');
        if (splitWrapper) splitWrapper.classList.remove('active-editor-pane');
        activePane = 'left';
    }

    // グローバルなパス変数を、アクティブなエディタのものに更新
    if (view && view.filePath) {
        currentFilePath = view.filePath;

        // ファイル統計の更新
        updateFileStats();

        // タブの選択状態を同期
        updateTabVisuals();

        // ツールバーの表示制御
        const toolbar = document.querySelector('.toolbar');
        if (toolbar) {
            // Markdown判定用ヘルパー（ローカル関数）
            const isMarkdown = (filePath) => {
                if (!filePath) return false;
                if (filePath === 'StartPage') return true;
                if (filePath === 'settings://view') return false;
                const ext = path.extname(filePath).toLowerCase();
                return ['.md', '.markdown', '.txt'].includes(ext);
            };

            // 1. 表示判定: 左右どちらかのエディタでMarkdownが開かれていれば表示する
            //    (ツールバーが頻繁に点滅するのを防ぐため)
            const leftIsMd = globalEditorView && isMarkdown(globalEditorView.filePath);
            // 分割表示中かつ右側が存在する場合のみ右側もチェック
            const rightIsMd = isSplitLayoutVisible && splitEditorView && isMarkdown(splitEditorView.filePath);

            const shouldShow = appSettings.showToolbar && (leftIsMd || rightIsMd);

            if (shouldShow) {
                toolbar.classList.remove('hidden');

                // 2. 有効/無効判定: 現在アクティブなファイルがMarkdownでなければグレーアウトする
                if (!isMarkdown(currentFilePath)) {
                    toolbar.classList.add('disabled');
                } else {
                    toolbar.classList.remove('disabled');
                }
            } else {
                toolbar.classList.add('hidden');
                toolbar.classList.remove('disabled');
            }
        }
    }
}

// 指定したファイルを分割エディタで開く関数 (左分割対応・同一ファイル許可)
function openInSplitView(filePath, side = 'right') {
    let targetPath = filePath;

    // ファイルパスが指定されていない場合は現在アクティブなファイルを使用
    if (!targetPath) {
        targetPath = currentFilePath;
    }

    if (!targetPath) return;

    // 設定画面 ('settings://view') の重複オープン防止
    if (targetPath === 'settings://view') {
        const isOpenedInLeft = globalEditorView && globalEditorView.filePath === 'settings://view';
        const isOpenedInRight = splitEditorView && splitEditorView.filePath === 'settings://view';

        // 左右どちらかで既に開かれている場合
        if (isOpenedInLeft || isOpenedInRight) {
            showNotification('設定画面は既に開かれています。\n2つ同時に開くことはできません。', 'error');
            return; // ここで処理を終了（分割しない）
        }
    }

    // 分割解除ボタンを表示
    const btnCloseSplit = document.getElementById('btn-close-split');
    if (btnCloseSplit) btnCloseSplit.classList.remove('disabled');

    const splitEditorDiv = document.getElementById('editor-split');
    const mainEditorDiv = document.getElementById('editor');

    // 分割レイアウトを適用するヘルパー（初期化）
    const ensureSplitLayout = () => {
        if (!isSplitView) {
            isSplitView = true;

            mainEditorDiv.style.display = 'block';
            splitEditorDiv.style.display = 'block';

            // 保存された比率を適用
            const leftPercent = splitLayoutRatio * 100;
            const rightPercent = 100 - leftPercent;

            mainEditorDiv.style.width = `calc(${leftPercent}% - 3px)`;
            splitEditorDiv.style.width = `calc(${rightPercent}% - 3px)`;

            if (resizerEditorSplit) {
                resizerEditorSplit.classList.remove('hidden');
            }
            splitEditorDiv.style.borderLeft = 'none';
        }
    };

    // splitEditorView が未作成なら作成する（インスタンスがないと switchToFile がエラーになる可能性があるため）
    if (!splitEditorView) {
        // 初期状態は空で作成
        splitEditorView = new EditorView({
            parent: splitEditorDiv
        });
        // フォーカスイベントの登録
        splitEditorView.contentDOM.addEventListener('focus', () => { activePane = 'right'; setActiveEditor(splitEditorView); });
        splitEditorView.contentDOM.addEventListener('click', () => { activePane = 'right'; setActiveEditor(splitEditorView); });
    }

    // --- 左分割モード (side === 'left') ---
    if (side === 'left') {
        ensureSplitLayout();

        // 1. 現在の左側のファイルパスを取得
        const currentLeftPath = globalEditorView ? globalEditorView.filePath : null;

        // 2. グループ更新 (左:ターゲット, 右:元の左側)
        isSplitView = true;
        splitGroup.leftPath = targetPath;
        splitGroup.rightPath = currentLeftPath;

        // 3. 元の左側を右側に移すために右側を更新
        // (switchToFileを呼ぶことで、エディタの状態や設定画面のDOM移動などが適切に行われる)
        if (currentLeftPath) {
            switchToFile(currentLeftPath, 'right');
        }

        // 4. 左側でターゲットファイルを開く
        switchToFile(targetPath, 'left');

        // タイトルバー更新
        updateFileTitleBars();
        return;
    }

    // --- 通常の右分割モード (side === 'right') ---

    ensureSplitLayout();

    // グループ更新 (左:そのまま, 右:ターゲット)
    isSplitView = true;
    // 左側が設定画面の場合もあるので、現在の globalEditorView.filePath を信頼するのではなく
    // splitGroup.leftPath があればそれを維持、なければ現在のパスを採用
    const currentLeftPath = splitGroup.leftPath || (globalEditorView ? globalEditorView.filePath : null);

    splitGroup.leftPath = currentLeftPath;
    splitGroup.rightPath = targetPath;

    // 重要: switchToFile に描画処理を委譲する
    // これにより、splitGroup に基づいて左右の表示内容（設定画面含む）が正しく再描画される
    // 特に左側が設定画面だった場合、switchToFile がそのDOM配置を維持してくれる
    switchToFile(targetPath, 'right');

    // 念のためタイトルバー更新
    updateFileTitleBars();
}

// タブを切り替える関数 (Ctrl+Tab等での重複防止)
function switchTab(direction) {
    const tabs = Array.from(document.querySelectorAll('.editor-tabs .tab'));
    if (tabs.length <= 1) return;

    const activeTab = document.querySelector('.editor-tabs .tab.active');
    // アクティブなタブがない場合は先頭を選択
    if (!activeTab) {
        const target = tabs[0];
        if (target.id === 'tab-settings') openSettingsTab();
        else if (target.dataset.filepath) switchToFile(target.dataset.filepath, activePane);
        return;
    }

    const currentIndex = tabs.indexOf(activeTab);
    // 循環するようにインデックスを計算
    let nextIndex = (currentIndex + direction) % tabs.length;
    if (nextIndex < 0) nextIndex = tabs.length - 1;

    const targetTab = tabs[nextIndex];

    if (targetTab.id === 'tab-settings') {
        openSettingsTab();
    } else if (targetTab.dataset.filepath) {
        const path = targetTab.dataset.filepath;

        // 重複防止ロジック
        // 1. 左側のエディタで開かれているか判定
        const isOpenedInLeft = globalEditorView && globalEditorView.filePath === path;

        // 2. 右側のエディタで開かれているか判定
        const isOpenedInRight = isSplitView && splitEditorView && splitEditorView.filePath === path;

        // 【修正の核心】
        // 冗長なチェックを削除し、常に switchToFile を呼び出すことで、
        // ファイルがスプリットグループのメンバーであればレイアウト復元 (showSplitLayout)
        // が switchToFile 内で実行されるようにする。
        switchToFile(path, activePane);
    }
}

// editorTabsContainer のクリックイベントリスナーを修正:
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
            // 【修正】設定タブかどうかにかかわらず、パスベースで共通の処理を行う
            // これにより設定タブでも分割グループ判定が効くようになる

            let path = tabElement.dataset.filepath;

            // datasetがない場合（古い実装等）のフォールバック
            if (!path && tabElement.id === 'tab-settings') {
                path = 'settings://view';
            }

            if (path) {
                // --- Split Group Check ---
                const isLeftSplitFile = path === splitGroup.leftPath;
                const isRightSplitFile = path === splitGroup.rightPath;

                if (isLeftSplitFile || isRightSplitFile) {
                    // 分割グループのメンバーなら、対応するペインで表示（switchToFile内でレイアウト復元される）
                    switchToFile(path, isRightSplitFile ? 'right' : 'left');
                } else {
                    // それ以外なら、左ペイン（全画面）で表示
                    // 設定画面の場合もここで switchToFile が呼ばれ、openSettingsTab 経由でなくても正しく開く
                    if (path === 'settings://view') {
                        // openSettingsTabを通すことで初期化漏れを防ぐ（念のため）
                        openSettingsTab();
                    } else {
                        switchToFile(path, 'left');
                    }
                }

                updateTabVisuals();
                updateOutline();
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
            updateCurrentDirData();
        } else {
            currentDirectoryPath = '.';
        }

        const fileTreeContainer = document.getElementById('file-tree-container');
        if (!fileTreeContainer) return;

        // --- 修正: コンテナの置換(cloneNode)をやめ、既存コンテナを再利用する ---
        // イベントリスナーの多重登録を防ぐため、初期化フラグを使用
        if (!fileTreeContainer.dataset.initialized) {
            fileTreeContainer.dataset.initialized = 'true';

            // イベントリスナーの登録（初回のみ）
            fileTreeContainer.addEventListener('dragover', handleDragOver);
            fileTreeContainer.addEventListener('drop', handleDrop);
            fileTreeContainer.addEventListener('click', (e) => {
                const item = e.target.closest('.tree-item');
                if (!item) return;
                if (item.classList.contains('creation-mode')) return;
                if (e.target.tagName.toLowerCase() === 'input') return;

                e.stopPropagation();
                fileTreeContainer.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');

                if (item.classList.contains('file')) {
                    openFile(item.dataset.path, item.dataset.name);
                } else {
                    toggleFolder(item);
                }
            });

            fileTreeContainer.addEventListener('contextmenu', (e) => {
                const item = e.target.closest('.tree-item');
                if (!item) return;
                e.preventDefault();
                e.stopPropagation();
                fileTreeContainer.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                showContextMenu(e.pageX, e.pageY, item.dataset.path, item.dataset.name);
            });
        }

        // --- ルートアイテムの更新 ---
        // 既存のルートアイテムがあれば再利用、なければ作成
        let rootItem = fileTreeContainer.querySelector('.tree-item.expanded');
        if (!rootItem) {
            // なければHTMLを初期構築（初回のみ）
            fileTreeContainer.innerHTML = `
                <div class="tree-item expanded" data-path="${currentDirectoryPath}" data-name="Root">
                    <span class="tree-toggle">▼</span>
                    <span class="tree-icon">📁</span>
                    <span class="tree-label">Root</span>
                </div>
                <div class="tree-children"></div>
            `;
            rootItem = fileTreeContainer.querySelector('.tree-item');

            // ルートアイテムへのドラッグイベント設定
            rootItem.addEventListener('dragover', handleDragOver);
            rootItem.addEventListener('dragleave', handleDragLeave);
            rootItem.addEventListener('drop', handleDrop);
        }

        // ルート情報の更新
        // 【追加修正】パスが変わったかどうかを確認
        const previousPath = rootItem.dataset.path;

        rootItem.dataset.path = currentDirectoryPath;
        const rootLabel = rootItem.querySelector('.tree-label');
        if (rootLabel) {
            const folderName = currentDirectoryPath.split(/[/\\]/).pop() || currentDirectoryPath;
            rootLabel.textContent = folderName;
        }

        // 【追加修正】ディレクトリが変更された場合は、子要素コンテナをクリアして古い構造を消す
        if (previousPath && previousPath !== currentDirectoryPath) {
            const childrenContainer = rootItem.nextElementSibling;
            if (childrenContainer && childrenContainer.classList.contains('tree-children')) {
                childrenContainer.innerHTML = '';
            }
        }

        // 中身の更新（ここもDiff更新される）
        await loadDirectoryTreeContents(rootItem, currentDirectoryPath);

    } catch (error) {
        console.error('Failed to initialize file tree:', error);
    }
}

// 既存の関数を上書き
async function loadDirectoryTreeContents(folderElement, dirPath) {
    let childrenContainer = folderElement.nextElementSibling;
    if (!childrenContainer || !childrenContainer.classList.contains('tree-children')) {
        childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        folderElement.parentNode.insertBefore(childrenContainer, folderElement.nextSibling);
    }

    // innerHTML = '' を削除し、Diff更新関数を使用
    const items = await getSortedDirectoryContents(dirPath);
    renderFileTree(childrenContainer, items, dirPath);
}

// 既存の関数を上書き
async function reloadContainer(container, path) {
    // innerHTML = '' を削除し、Diff更新関数を使用
    const items = await getSortedDirectoryContents(path);
    renderFileTree(container, items, path);
}

/**
 * ファイルツリーのDOMを更新する関数（差分更新・ちらつき防止）
 */
function renderFileTree(container, items, parentPath) {
    if (!items) return;

    // 既存の要素をマップ化
    const existingElements = new Map();
    Array.from(container.children).forEach(child => {
        if (child.dataset.name) {
            existingElements.set(child.dataset.name, child);
        }
    });

    const processedNames = new Set();

    items.forEach(item => {
        processedNames.add(item.name);

        let element = existingElements.get(item.name);

        // 新規作成
        if (!element) {
            element = createTreeElement(item, parentPath);
            // 挿入位置の制御（ソート順通りに追加）
            container.appendChild(element);
        } else {
            // 既存更新（必要ならアイコンやクラスを更新）
            // 基本的に名前が同じなら大きな変化はないが、ディレクトリ<->ファイルの変更などはチェック推奨
            const isDir = item.isDirectory;
            const wasDir = !element.classList.contains('file');

            if (isDir !== wasDir) {
                // タイプが変わっている場合は作り直し
                const newElement = createTreeElement(item, parentPath);
                container.replaceChild(newElement, element);
                element = newElement;
            } else {
                // 既存のものを維持（位置だけ合わせるためにappendChild再実行も可だが、パフォーマンス的には触らない方が良い）
                // 順序が変わる場合は appendChild で末尾に移動させるなどの処理が必要だが、
                // 通常はファイルシステム順序は変わらないため、ここでは簡易的な追加のみとする
                if (!container.contains(element)) {
                    container.appendChild(element);
                }
            }
        }
    });

    // 削除されたファイルをDOMから削除
    existingElements.forEach((node, name) => {
        if (!processedNames.has(name)) {
            node.remove();
        }
    });
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

    // デフォルトのエフェクトを設定
    let effect = 'none';

    // 1. 内部ドラッグ (handleDragStartで 'text/plain' をセットしている場合) -> 移動
    if (e.dataTransfer.types.includes('text/plain')) {
        effect = 'move';
    }
    // 2. 外部からのファイル (Files を含んでいる場合) -> コピー
    else if (e.dataTransfer.types.includes('Files')) {
        effect = 'copy';
    }

    const targetItem = e.target.closest('.tree-item');
    if (targetItem) {
        // フォルダの上にいる時のみ受け入れる (ファイルの上は受け入れない)
        if (!targetItem.classList.contains('file')) {
            targetItem.classList.add('drag-over');
            e.dataTransfer.dropEffect = effect;
        } else {
            // ファイルの上に来たときは「なし」にする（誤操作防止）
            e.dataTransfer.dropEffect = 'none';
        }
    } else {
        // ツリーの空白部分（ルート）へのドロップを許可
        e.dataTransfer.dropEffect = effect;
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

    // スタイルリセット
    const targetItem = e.target.closest('.tree-item');
    if (targetItem) targetItem.classList.remove('drag-over');

    // ドロップ先のディレクトリを決定
    let destFolderPath;
    if (targetItem) {
        if (targetItem.classList.contains('file')) return; // ファイル上へのドロップは無視
        destFolderPath = targetItem.dataset.path;
    } else {
        // 空白部分ならルートディレクトリ
        destFolderPath = currentDirectoryPath;
    }

    if (!destFolderPath) return;

    // --- 分岐処理 ---

    // 1. 内部移動 (Move): handleDragStart でセットしたパスを取得
    const srcPath = e.dataTransfer.getData('text/plain');
    if (srcPath) {
        // 移動元と移動先が同じなら無視
        if (srcPath === destFolderPath) return;

        // 移動先のパスを作成 (destFolder/fileName)
        const fileName = path.basename(srcPath);
        const destPath = path.join(destFolderPath, fileName);

        if (srcPath !== destPath) {
            try {
                if (typeof window.electronAPI?.moveFile === 'function') {
                    const result = await window.electronAPI.moveFile(srcPath, destPath);
                    if (result.success) {
                        showNotification(`移動しました: ${fileName}`, 'success');
                        // ツリー更新等の処理があれば呼ぶ (例: initializeFileTreeWithState())
                        // initializeFileTreeWithState(); 
                    } else {
                        showNotification(`移動に失敗しました: ${result.error}`, 'error');
                    }
                }
            } catch (error) {
                console.error('Move failed:', error);
                showNotification(`エラーが発生しました: ${error.message}`, 'error');
            }
        }
        return; // 移動処理完了
    }

    // 2. 外部からのコピー (Copy): Files がある場合
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        let successCount = 0;
        for (const file of e.dataTransfer.files) {
            try {
                // file.path はElectron環境(コンテキスト分離ありでもドラッグ時は取得可能な場合が多い)でフルパス
                const result = await window.electronAPI.copyFileSystemEntry(file.path, destFolderPath);

                if (result.success) {
                    successCount++;
                } else {
                    showNotification(`コピー失敗 (${file.name}): ${result.error}`, 'error');
                }
            } catch (err) {
                console.error(err);
                showNotification(`エラー: ${err.message}`, 'error');
            }
        }

        if (successCount > 0) {
            showNotification(`${successCount} 件の項目をコピーしました`, 'success');
            // ファイルツリーを更新して新しいファイルを表示
            if (typeof initializeFileTreeWithState === 'function') {
                await initializeFileTreeWithState();
            } else {
                await initializeFileTree();
            }
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

        let name = inputField.value.trim();
        if (!name) {
            safeRemove();
            isCreating = false;
            return;
        }

        // フォルダでなく、かつ拡張子がない場合は .md を付与
        if (!isFolder && !name.includes('.') && !name.endsWith('/')) {
            name += '.md';
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
        let name = inputField.value.trim();

        if (!name) return null;

        // バリデーション時も拡張子補完を考慮してチェックする
        if (!isFolder && !name.includes('.') && !name.endsWith('/')) {
            name += '.md';
        }

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
 * ディスクからファイルを再読み込みし、カーソル位置を維持する
 * 修正: 左右のエディタそれぞれのfilePathを確認し、一致する場合のみ更新するように変更
 */
async function reloadFileFromDisk(filePath) {
    try {
        // 1. ディスクから最新の内容を読み込む
        const newContent = await window.electronAPI.loadFile(filePath);

        // --- 左側 (Main) エディタの更新チェック ---
        if (globalEditorView && globalEditorView.filePath === filePath) {
            const currentContent = globalEditorView.state.doc.toString();
            // 内容が異なる場合のみ更新
            if (newContent !== currentContent) {
                const currentSelection = globalEditorView.state.selection;
                const transaction = {
                    changes: { from: 0, to: globalEditorView.state.doc.length, insert: newContent },
                    selection: currentSelection,
                    scrollIntoView: true,
                    annotations: ExternalChange.of(true)
                };
                globalEditorView.dispatch(transaction);
            }
        }

        // --- 右側 (Split) エディタの更新チェック ---
        if (splitEditorView && splitEditorView.filePath === filePath) {
            const currentContent = splitEditorView.state.doc.toString();
            // 内容が異なる場合のみ更新
            if (newContent !== currentContent) {
                const currentSelection = splitEditorView.state.selection;
                const transaction = {
                    changes: { from: 0, to: splitEditorView.state.doc.length, insert: newContent },
                    selection: currentSelection,
                    scrollIntoView: true,
                    annotations: ExternalChange.of(true)
                };
                splitEditorView.dispatch(transaction);
            }
        }

        // 内部データの更新
        const fileData = openedFiles.get(filePath);
        if (fileData) {
            fileData.content = newContent;
        }

        updateFileStats();

        // 本当に外部からの変更があった場合のみ通知
        // showNotification('ファイルを再読み込みしました', 'info');

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

// コマンドパレット機能
class CommandPalette {
    constructor() {
        this.overlay = document.getElementById('command-palette');
        this.input = document.getElementById('command-palette-input');
        this.list = document.getElementById('command-palette-list');
        this.isOpen = false;
        this.selectedIndex = 0;
        this.filteredCommands = [];

        this.init();
    }

    init() {
        if (!this.overlay) return;

        // イベントリスナー
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });

        this.input.addEventListener('input', () => this.filterCommands());

        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredCommands.length - 1);
                this.renderList();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
                this.renderList();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this.executeSelected();
            } else if (e.key === 'Escape') {
                this.close();
            }
        });
    }

    open() {
        this.isOpen = true;
        this.overlay.classList.remove('hidden');
        this.input.value = '';
        this.input.focus();
        this.filterCommands();
    }

    close() {
        this.isOpen = false;
        this.overlay.classList.add('hidden');
        if (globalEditorView) globalEditorView.focus();
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    filterCommands() {
        const query = this.input.value.toLowerCase();

        // COMMANDS_REGISTRY (renderer.js内で定義済み) を使用
        this.filteredCommands = COMMANDS_REGISTRY.filter(cmd => {
            return cmd.name.toLowerCase().includes(query) || cmd.id.toLowerCase().includes(query);
        });

        this.selectedIndex = 0;
        this.renderList();
    }

    renderList() {
        this.list.innerHTML = '';

        this.filteredCommands.forEach((cmd, index) => {
            const item = document.createElement('div');
            item.className = 'command-item';
            if (index === this.selectedIndex) item.classList.add('selected');

            // キーバインドの表示用
            const keys = getKeybindingsForCommand(cmd.id);
            const keyStr = keys.length > 0 ? formatKeyDisplay(keys[0]) : '';

            item.innerHTML = `
                <span class="name">${cmd.name}</span>
                <span class="shortcut">${keyStr}</span>
            `;

            item.addEventListener('click', () => {
                this.selectedIndex = index;
                this.executeSelected();
            });

            // マウスオーバーで選択状態更新
            item.addEventListener('mouseenter', () => {
                this.selectedIndex = index;
                const prev = this.list.querySelector('.command-item.selected');
                if (prev) prev.classList.remove('selected');
                item.classList.add('selected');
            });

            this.list.appendChild(item);
        });

        // 選択アイテムが見えるようにスクロール
        const selectedEl = this.list.children[this.selectedIndex];
        if (selectedEl) {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }

    executeSelected() {
        const cmd = this.filteredCommands[this.selectedIndex];
        if (cmd) {
            this.close();
            // 少し遅らせて実行（UIが閉じるのを待つ）
            setTimeout(() => {
                // コンテキストに応じて実行 (editorコマンドの場合はviewを渡す必要がある)
                if (cmd.context === 'editor' && globalEditorView) {
                    cmd.run(globalEditorView);
                } else {
                    cmd.run();
                }
            }, 50);
        }
    }
}

// ========== 画面分割機能 (CodeMirror版) ==========

let splitEditorView = null; // 2つ目のエディタ
let isSplitView = false;    // 分割状態
let splitGroup = { leftPath: null, rightPath: null };
let isSplitLayoutVisible = false;

// ========== レイアウト管理ヘルパー (新規追加) ==========

/**
 * 分割レイアウト（左右2ペイン）をDOMに適用し、表示状態を更新する
 */
function showSplitLayout() {
    if (isSplitLayoutVisible) return;

    const mainEditorDiv = document.getElementById('editor');
    const splitEditorDiv = document.getElementById('editor-split');
    const mainTitleBar = document.getElementById('file-title-bar');
    const splitTitleBar = document.getElementById('file-title-bar-split');

    // レイアウトを分割状態に設定
    mainEditorDiv.style.display = 'block';
    splitEditorDiv.style.display = 'block';

    // 保存された比率に基づいて幅を設定
    const leftPercent = splitLayoutRatio * 100;
    const rightPercent = 100 - leftPercent;

    // リサイザーの幅(約6px)を考慮して少し引く
    mainEditorDiv.style.width = `calc(${leftPercent}% - 3px)`;
    splitEditorDiv.style.width = `calc(${rightPercent}% - 3px)`;

    // リサイザーを表示
    if (resizerEditorSplit) {
        resizerEditorSplit.classList.remove('hidden');
        // リサイザーの位置も比率に合わせる（左ペインの右端）
        // CSSで position: relative などの構成であれば不要な場合もあるが、
        // width設定だけで自動的に配置される構造であれば上記width設定で十分
    }
    splitEditorDiv.style.borderLeft = 'none';

    // タイトルバーを分割状態に設定
    if (mainTitleBar) {
        mainTitleBar.style.flex = 'none';
        mainTitleBar.style.width = `${leftPercent}%`; // 比率を適用
        mainTitleBar.style.borderRight = '1px solid var(--sidebar-border)';
        mainTitleBar.classList.remove('hidden');
    }
    if (splitTitleBar) {
        splitTitleBar.style.display = 'flex';
        splitTitleBar.style.width = `${rightPercent}%`; // 比率を適用
        splitTitleBar.classList.remove('hidden');
    }

    isSplitLayoutVisible = true;
    isSplitView = true; // 分割状態フラグを確実にONにする
}

/**
 * 分割レイアウトを解除し、メインエディタを全画面表示にする
 */
function hideSplitLayout() {
    if (!isSplitLayoutVisible) return;

    const mainEditorDiv = document.getElementById('editor');
    const splitEditorDiv = document.getElementById('editor-split');
    const mainTitleBar = document.getElementById('file-title-bar');
    const splitTitleBar = document.getElementById('file-title-bar-split');

    // メインエディタを全幅に
    mainEditorDiv.style.width = '100%';
    splitEditorDiv.style.display = 'none';
    splitEditorDiv.style.width = '0%';

    // リサイザーを非表示
    if (resizerEditorSplit) {
        resizerEditorSplit.classList.add('hidden');
    }

    // タイトルバーを全幅に
    if (mainTitleBar) {
        mainTitleBar.style.width = '100%';
        mainTitleBar.style.borderRight = 'none';
        mainTitleBar.style.flex = '1';
    }
    if (splitTitleBar) {
        splitTitleBar.style.display = 'none';
    }

    isSplitLayoutVisible = false;
    isSplitView = false; // 分割状態フラグを確実にOFFにする
}

// 分割を閉じる関数
function closeSplitView() {
    if (!isSplitView) return;

    // プレビューモード中なら、その終了処理（エディタ設定の復元など）もここで行う
    if (isPreviewMode) {
        isPreviewMode = false;

        // プレビューボタンの見た目を戻す
        const btnPreview = document.getElementById('btn-toggle-preview');
        if (btnPreview) btnPreview.classList.remove('active');

        // 左側エディタを「原文モード」から「元の言語モード」に戻す
        if (globalEditorView && currentFilePath) {
            globalEditorView.dispatch({
                effects: languageCompartment.reconfigure(getLanguageExtensions(currentFilePath))
            });
        }
    }

    isSplitView = false; // 永続的な分割状態を完全に解除する
    isSplitLayoutVisible = false;

    const mainEditorDiv = document.getElementById('editor');
    const splitEditorDiv = document.getElementById('editor-split');
    const mainTitleBar = document.getElementById('file-title-bar');
    const splitTitleBar = document.getElementById('file-title-bar-split');

    const btnCloseSplit = document.getElementById('btn-close-split');
    if (btnCloseSplit) btnCloseSplit.classList.add('disabled');

    // レイアウトを元に戻す
    if (mainEditorDiv) mainEditorDiv.style.width = '100%';
    if (splitEditorDiv) {
        splitEditorDiv.style.display = 'none';
        splitEditorDiv.style.width = '0%';
    }

    // リサイザーを非表示
    if (resizerEditorSplit) {
        resizerEditorSplit.classList.add('hidden');
    }

    // タイトルバーを元に戻す
    if (mainTitleBar) {
        mainTitleBar.style.width = '100%';
        mainTitleBar.style.borderRight = 'none';
    }
    if (splitTitleBar) {
        splitTitleBar.style.display = 'none';
    }

    // 分割ビューのファイルパス情報をリセットする
    if (splitEditorView) {
        splitEditorView.filePath = null;
    }

    // 分割グループをリセット
    splitGroup.leftPath = null;
    splitGroup.rightPath = null;

    // activePane と activeEditor を左に戻す
    activePane = 'left';
    setActiveEditor(globalEditorView);

    // 隠されていた README を再表示するかも
    if (openedFiles.size === 0) {
        showWelcomeReadme();
    }
}

// --- エディタ分割リサイザーのイベント ---
let lastSplitResizerClickTime = 0; // ダブルクリック判定用

if (resizerEditorSplit) {
    resizerEditorSplit.addEventListener('mousedown', (e) => {
        e.preventDefault(); // テキスト選択などを防止

        const now = Date.now();
        // 300ms以内に再クリックされたらダブルクリックとみなしてリセット
        if (now - lastSplitResizerClickTime < 300) {
            // --- リセット処理 ---
            isResizingEditorSplit = false;
            resizerEditorSplit.classList.remove('resizing');
            document.body.classList.remove('is-resizing-col');

            // 比率を初期値に戻す
            splitLayoutRatio = 0.5;

            // 幅の適用
            const mainEditorDiv = document.getElementById('editor');
            const splitEditorDiv = document.getElementById('editor-split');
            const mainTitleBar = document.getElementById('file-title-bar');
            const splitTitleBar = document.getElementById('file-title-bar-split');

            if (mainEditorDiv) mainEditorDiv.style.width = 'calc(50% - 3px)';
            if (splitEditorDiv) splitEditorDiv.style.width = 'calc(50% - 3px)';

            // タイトルバーもリセット
            if (mainTitleBar && !mainTitleBar.classList.contains('hidden')) {
                mainTitleBar.style.width = '50%';
            }
            if (splitTitleBar && !splitTitleBar.classList.contains('hidden')) {
                splitTitleBar.style.width = '50%';
            }

            // UI更新
            updateFileTitleBars();
            if (globalEditorView) globalEditorView.requestMeasure();
            if (splitEditorView) splitEditorView.requestMeasure();

            lastSplitResizerClickTime = 0; // 判定タイマーリセット
            return; // リサイズ処理を開始せずに終了
        }

        // --- 通常のリサイズ開始処理 ---
        lastSplitResizerClickTime = now;
        isResizingEditorSplit = true;
        resizerEditorSplit.classList.add('resizing');
        document.body.classList.add('is-resizing-col');
    });
}

// 既存の mousemove イベント内に追加、または新規に追加
document.addEventListener('mousemove', (e) => {

    // --- 左サイドバーのリサイズ (元のロジックのまま) ---
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

    // --- 右サイドバーのリサイズ (元のロジックのまま) ---
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

    // --- 下パネル（ターミナル）のリサイズ (元のロジックのまま) ---
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

    // --- エディタ分割のリサイズ処理 (修正) ---
    if (isResizingEditorSplit && isSplitView) {
        const wrapper = document.getElementById('editor-wrapper');
        const mainEditorDiv = document.getElementById('editor');
        const splitEditorDiv = document.getElementById('editor-split');
        const mainTitleBar = document.getElementById('file-title-bar');
        const splitTitleBar = document.getElementById('file-title-bar-split');

        if (!wrapper) return;

        const wrapperRect = wrapper.getBoundingClientRect();
        const wrapperWidth = wrapperRect.width;

        // マウス位置の相対座標（ラッパー左端からの距離）
        let newLeftWidth = e.clientX - wrapperRect.left;

        // リサイザーの幅（CSSで6pxに設定されている想定）
        const resizerWidth = 6;

        // 最小幅制限 (例えば 100px)
        if (newLeftWidth < 100) newLeftWidth = 100;
        if (newLeftWidth > wrapperWidth - 100) newLeftWidth = wrapperWidth - 100;

        // ★修正: 比率を保存
        splitLayoutRatio = newLeftWidth / wrapperWidth;

        // 比率を使って再計算 (整合性を保つため)
        const leftWidthPx = newLeftWidth;
        const rightWidthPx = wrapperWidth - newLeftWidth - resizerWidth;

        // エディタ幅の適用 (px指定の方が計算ズレが少ないです)
        if (mainEditorDiv) mainEditorDiv.style.width = `${leftWidthPx}px`;
        if (splitEditorDiv) splitEditorDiv.style.width = `${rightWidthPx}px`;

        // ▼▼▼ 修正箇所: タイトルバー幅の適用（同期させる） ▼▼▼
        if (mainTitleBar && splitTitleBar) {
            const isMainVisible = !mainTitleBar.classList.contains('hidden');
            const isSplitVisible = !splitTitleBar.classList.contains('hidden');

            if (isMainVisible && isSplitVisible) {
                mainTitleBar.style.width = `${leftWidthPx}px`;
                // 右側タイトルバーは隙間を埋めるためリサイザー幅分も含める
                splitTitleBar.style.width = `${rightWidthPx + resizerWidth}px`;
            }
        }
    }
});

// 既存の mouseup イベント内に追加、または新規に追加
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
    if (isResizingEditorSplit) {
        isResizingEditorSplit = false;
        if (resizerEditorSplit) resizerEditorSplit.classList.remove('resizing');
        document.body.classList.remove('is-resizing-col');

        // CodeMirrorの表示崩れを防ぐためにリフレッシュ
        if (globalEditorView) globalEditorView.requestMeasure();
        if (splitEditorView) splitEditorView.requestMeasure();
    }
});

// 3. 各タブにドラッグ機能を有効化する関数（これを後で呼び出します）
function enableTabDragging(tabElement) {
    tabElement.setAttribute('draggable', 'true');

    tabElement.addEventListener('dragstart', (e) => {
        tabElement.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';

        // 【修正】ここを 'text/plain' から変更しました
        // これでエディタに文字として貼り付けられるのを防ぎます
        e.dataTransfer.setData('application/x-markdown-tab', tabElement.dataset.filepath || '');
    });

    tabElement.addEventListener('dragend', () => {
        tabElement.classList.remove('dragging');
    });
}

// ========== タブ並べ替え機能 (新規追加) ==========
function setupTabReordering() {
    if (!editorTabsContainer) return;

    editorTabsContainer.addEventListener('dragover', (e) => {
        e.preventDefault(); // ドロップを許可
        const draggingTab = document.querySelector('.tab.dragging');
        // タブ同士の並べ替え以外（ファイルツリーからのドロップなど）は無視
        if (!draggingTab) return;

        const afterElement = getTabAfterElement(editorTabsContainer, e.clientX);
        if (afterElement == null) {
            editorTabsContainer.appendChild(draggingTab);
        } else {
            editorTabsContainer.insertBefore(draggingTab, afterElement);
        }
    });
}

function getTabAfterElement(container, x) {
    const draggableElements = [...container.querySelectorAll('.tab:not(.dragging)')];

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        // 要素の中心点
        const boxCenter = box.left + box.width / 2;
        const offset = x - boxCenter;

        // カーソルが中心より左 (offset < 0) かつ、これまでの候補の中で一番近い (offsetが大きい)
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// 現在アクティブなエディタを取得する関数（ツールバーなどで使用）
function getActiveView() {
    return activeEditorView || globalEditorView;
}

/**
 * 設定画面をクリックした際に、その配置場所に応じてアクティブ状態にするハンドラ
 */
function setupSettingsActivationHandler() {
    const settingsEl = document.getElementById('content-settings');
    if (!settingsEl) return;

    settingsEl.addEventListener('mousedown', (e) => {
        // 親へのイベント伝播を止める（誤作動防止）
        e.stopPropagation();

        // 分割表示中で、右側に設定画面がある場合
        if (isSplitLayoutVisible && splitGroup.rightPath === 'settings://view') {
            if (splitEditorView) setActiveEditor(splitEditorView);
        }
        // それ以外（左側、または全画面）の場合
        else {
            if (globalEditorView) setActiveEditor(globalEditorView);
        }
    });
}

// ショートカットキー登録 (Ctrl+Shift+P)
COMMANDS_REGISTRY.push({
    id: 'view:command-palette',
    name: 'コマンドパレット',
    defaultKey: 'Mod-Shift-p',
    context: 'global',
    run: () => commandPalette && commandPalette.toggle()
});

document.addEventListener('click', () => {
    ContextMenu.close();
});

// カスタムリンク用アイコン定義
const CUSTOM_LINK_ICONS = {
    'globe': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
    'file-text': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
    'tool': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
    'github': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>',
    'message': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
    'star': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>',
    'link': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>'
};

// 右サイドバーにカスタムリンクアイコンを描画
function renderRightSidebarIcons() {
    const activityBar = document.querySelector('.right-activity-bar');
    if (!activityBar) return;

    // 既存の動的追加アイコンをクリア（クラス 'custom-link-icon' を持つもの）
    const existing = activityBar.querySelectorAll('.custom-link-icon');
    existing.forEach(el => el.remove());

    const links = appSettings.customLinks || [];

    links.forEach(link => {
        const div = document.createElement('div');
        div.className = 'icon custom-link-icon';
        div.title = link.name;
        div.dataset.id = link.id;
        div.innerHTML = CUSTOM_LINK_ICONS[link.icon] || CUSTOM_LINK_ICONS['globe'];

        // クリックイベント
        div.addEventListener('click', () => {
            toggleCustomLinkView(link.id);
        });

        // アクティブ状態の反映
        if (activeCustomLinkId === link.id) {
            div.classList.add('active');
        }

        activityBar.appendChild(div);
    });
}

// カスタムリンクの表示切り替え処理
function toggleCustomLinkView(linkId) {
    if (activeCustomLinkId === linkId) {
        // 既に開いている場合は閉じる
        activeCustomLinkId = null;
        // iframeをクリア
        const iframe = document.getElementById('custom-webview-frame');
        if (iframe) iframe.src = '';
    } else {
        // 開く（他を閉じる）
        activeCustomLinkId = linkId;
        isTerminalVisible = false;
        isPdfPreviewVisible = false;
        isBacklinksVisible = false;

        // リンク情報を取得して表示
        const link = (appSettings.customLinks || []).find(l => l.id === linkId);
        if (link) {
            const iframe = document.getElementById('custom-webview-frame');
            const title = document.getElementById('custom-webview-title');
            if (iframe) iframe.src = link.url;
            if (title) title.textContent = link.name;
        }
    }
    updateTerminalVisibility();
}

// ========== プレビュー機能 ==========

async function togglePreviewMode() {
    const btn = document.getElementById('btn-toggle-preview');

    if (isPreviewMode) {
        // 分割表示を終了して全画面に戻す
        closeSplitView();
    } else {
        // --- プレビューモード開始 ---

        // 1. ファイルが開かれているかチェック
        if (!currentFilePath) return;

        // 2. 拡張子チェック (.md, .markdown, .txt, README)
        const lowerPath = currentFilePath.toLowerCase();
        const fileName = path.basename(lowerPath);
        const ext = path.extname(lowerPath);
        const allowedExts = ['.md', '.markdown', '.txt'];

        // StartPage などのファイル名、または許可された拡張子か
        const isTargetFile = currentFilePath === 'StartPage' || fileName.includes('readme') || allowedExts.includes(ext);

        if (!isTargetFile) {
            showNotification('プレビューはMarkdown/テキストファイルのみ利用可能です', 'error');
            return;
        }

        // 3. 画面分割チェック (既に分割されている場合は実行しない)
        if (isSplitLayoutVisible) {
            showNotification('画面分割中はプレビューモードを利用できません', 'error');
            return;
        }

        isPreviewMode = true;

        // 4. 右側に「いつものプレビュー」を表示 (リサイザーも自動で有効になります)
        openInSplitView(currentFilePath, 'right');

        // 5. 左側を「原文（Plain Text）」に変更
        if (globalEditorView) {
            globalEditorView.dispatch({
                effects: languageCompartment.reconfigure([])
            });
        }

        // 6. 右側を「完全な読み取り専用」にする (カーソルも非表示)
        setTimeout(() => {
            if (splitEditorView) {
                splitEditorView.dispatch({
                    effects: [
                        StateEffect.appendConfig.of(EditorState.readOnly.of(true)),
                        StateEffect.appendConfig.of(EditorView.editable.of(false)) // カーソル非表示・編集無効化
                    ]
                });
            }
            // フォーカスは左側（入力用）に戻す
            if (globalEditorView) {
                setActiveEditor(globalEditorView);
                globalEditorView.focus();
            }
        }, 100);

        if (btn) btn.classList.add('active');
    }
}

// プレビュー内容の更新
async function updatePreviewContent() {
    if (!isPreviewMode || !globalEditorView) return;

    const previewContainer = document.querySelector('#preview-pane .markdown-rendered');
    if (!previewContainer) return;

    const markdown = globalEditorView.state.doc.toString();
    const title = document.getElementById('file-title-input')?.value || 'Untitled';

    // 既存のPDF用HTML変換関数を再利用してレンダリング
    try {
        const html = await convertMarkdownToHtml(markdown, appSettings.pdfOptions || {}, title);
        previewContainer.innerHTML = html;
    } catch (e) {
        console.error("Preview render error:", e);
    }
}

// サポートされている実行言語リスト (main.jsと同期)
const SUPPORTED_RUN_LANGUAGES = new Set([
    'js', 'javascript', 'ts', 'typescript', 'py', 'python',
    'php', 'rb', 'ruby', 'pl', 'perl', 'lua', 'r', 'dart',
    'go', 'rs', 'rust', 'c', 'cpp', 'java', 'kt', 'kotlin',
    'scala', 'swift', 'cs', 'csharp', 'sh', 'bash', 'zsh', 'shell',
    'bf', 'brainfuck', 'ws', 'whitespace', 'sql',
    'ps1', 'powershell', 'bat', 'cmd', 'batch'
]);

const btnRunCode = document.getElementById('btn-run-code');
const runArgsInput = document.getElementById('run-args-input'); // 要素取得

function updateRunButtonVisibility() {
    if (!btnRunCode) return;

    // ファイルが開かれていない場合は非表示
    if (!currentFilePath) {
        btnRunCode.style.display = 'none';
        if (runArgsInput) runArgsInput.style.display = 'none';
        return;
    }

    // 拡張子または言語IDから判定
    const ext = currentFilePath.split('.').pop().toLowerCase();

    // 設定ファイルなどは除外
    if (currentFilePath.startsWith('settings:')) {
        btnRunCode.style.display = 'none';
        if (runArgsInput) runArgsInput.style.display = 'none';
        return;
    }

    if (SUPPORTED_RUN_LANGUAGES.has(ext)) {
        btnRunCode.style.display = 'flex';
        if (runArgsInput) runArgsInput.style.display = 'block';
    } else {
        btnRunCode.style.display = 'none';
        if (runArgsInput) runArgsInput.style.display = 'none';
    }
}

// 3. setActiveEditor をフックしてタブ切り替え時にボタン表示を更新
const originalSetActiveEditor = typeof setActiveEditor === 'function' ? setActiveEditor : null;

setActiveEditor = function (view) {
    if (originalSetActiveEditor) {
        originalSetActiveEditor(view);
    }
    updateRunButtonVisibility();
};

// ヘルパー: コマンドが存在するか非同期でチェック
function checkCommandExistsAsync(command) {
    return new Promise(resolve => {
        // --version を付けて実行し、エラーが出なければ存在するとみなす
        const testCmd = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
        require('child_process').exec(testCmd, (error) => {
            resolve(!error);
        });
    });
}

if (btnRunCode) {
    btnRunCode.addEventListener('click', async (e) => {
        const activePath = currentFilePath;
        if (!activePath) return;

        // 未保存なら保存
        if (fileModificationState.get(activePath)) {
            await saveCurrentFile(false);
        }

        // 言語判定と正規化
        let ext = activePath.split('.').pop().toLowerCase();
        let langLower = ext;

        if (langLower === 'js') langLower = 'javascript';
        if (langLower === 'ts') langLower = 'typescript';
        if (langLower === 'py') langLower = 'python';
        if (langLower === 'rb') langLower = 'ruby';
        if (langLower === 'pl') langLower = 'perl';
        if (langLower === 'rs') langLower = 'rust';
        if (langLower === 'kt') langLower = 'kotlin';
        if (langLower === 'cs') langLower = 'csharp';
        if (langLower === 'sh' || langLower === 'zsh') langLower = 'bash';
        if (langLower === 'bf') langLower = 'brainfuck';
        if (langLower === 'ws') langLower = 'whitespace';
        if (langLower === 'ps1') langLower = 'powershell';
        if (langLower === 'bat' || langLower === 'cmd') langLower = 'batch';

        // 実際に実行処理を行う関数
        const executeWithCommand = async (customExecPath = null) => {

            // ターミナル表示 & 初期化待ち
            if (!isTerminalVisible) {
                isTerminalVisible = true;
                updateTerminalVisibility();
                if (terminals.size === 0) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }

            const fileNameNoExt = path.parse(activePath).name;
            const isWin = process.platform === 'win32';
            const safePath = `"${activePath}"`; // パスをクォート

            // 引数の取得と整形
            const argsInput = document.getElementById('run-args-input');
            const rawArgs = argsInput ? argsInput.value.trim() : '';
            // 引数がある場合は先頭にスペースを入れる
            const argsStr = rawArgs ? ` ${rawArgs}` : '';

            let command = '';

            switch (langLower) {
                case 'javascript':
                    command = `node ${safePath}${argsStr}`;
                    break;
                case 'typescript':
                    command = `tsc ${safePath} && node "${path.join(path.dirname(activePath), fileNameNoExt + '.js')}"${argsStr}`;
                    break;
                case 'python':
                    // 指定があればそれを使う、なければOSごとのデフォルト
                    if (customExecPath) {
                        command = `"${customExecPath}" ${safePath}${argsStr}`;
                    } else {
                        command = isWin ? `py ${safePath}${argsStr}` : `python3 ${safePath}${argsStr}`;
                    }
                    break;
                case 'php':
                    command = `php ${safePath}${argsStr}`;
                    break;
                case 'ruby':
                    command = `ruby ${safePath}${argsStr}`;
                    break;
                case 'perl':
                    command = `perl ${safePath}${argsStr}`;
                    break;
                case 'lua':
                    command = `lua ${safePath}${argsStr}`;
                    break;
                case 'r':
                    command = `Rscript ${safePath}${argsStr}`;
                    break;
                case 'dart':
                    command = `dart ${safePath}${argsStr}`;
                    break;
                case 'go':
                    command = `go run ${safePath}${argsStr}`;
                    break;
                case 'rust':
                    const rustOut = isWin ? `${fileNameNoExt}.exe` : fileNameNoExt;
                    const rustRun = isWin ? `.\\${rustOut}` : `./${rustOut}`;
                    command = `rustc ${safePath} -o "${rustOut}" && ${rustRun}${argsStr}`;
                    break;
                case 'c':
                    const cOut = isWin ? `${fileNameNoExt}.exe` : fileNameNoExt;
                    const cRun = isWin ? `.\\${cOut}` : `./${cOut}`;
                    command = `gcc ${safePath} -o "${cOut}" && ${cRun}${argsStr}`;
                    break;
                case 'cpp':
                    const cppOut = isWin ? `${fileNameNoExt}.exe` : fileNameNoExt;
                    const cppRun = isWin ? `.\\${cppOut}` : `./${cppOut}`;
                    command = `g++ ${safePath} -o "${cppOut}" && ${cppRun}${argsStr}`;
                    break;
                case 'csharp':
                    // dotnet run の引数として渡すため -- を使用
                    command = `dotnet run --${argsStr}`;
                    break;
                case 'swift':
                    command = `swift ${safePath}${argsStr}`;
                    break;
                case 'scala':
                    // scala-cli または scala の使える方を採用
                    let scalaCmd = 'scala';
                    // まず scala-cli の存在チェック
                    const hasScalaCli = await checkCommandExistsAsync('scala-cli');
                    if (hasScalaCli) {
                        scalaCmd = 'scala-cli';
                    }
                    command = `${scalaCmd} ${safePath}${argsStr}`;
                    break;
                case 'bash':
                    // WSLが選択された場合の特別処理
                    if (customExecPath === 'wsl') {
                        // WindowsパスをWSLパス(/mnt/ドライブ/...)に変換するヘルパー
                        const toWslPath = (p) => p.replace(/^([a-zA-Z]):/, (m, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, '/');
                        const wslPath = toWslPath(activePath);
                        // wslコマンド経由でbashを実行
                        command = `wsl bash "${wslPath}"${argsStr}`;
                    } else {
                        // 通常のBash (Git Bashなど)
                        let bashExec = 'bash';
                        if (customExecPath) {
                            bashExec = `"${customExecPath}"`;
                        } else if (isWin) {
                            // Windowsの場合のデフォルトフォールバック (Git Bash自動検出)
                            try {
                                const fs = require('fs');
                                const os = require('os');
                                const candidates = [
                                    'C:\\Program Files\\Git\\bin\\bash.exe',
                                    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
                                    path.join(os.homedir(), 'AppData\\Local\\Programs\\Git\\bin\\bash.exe')
                                ];
                                for (const p of candidates) {
                                    if (fs.existsSync(p)) {
                                        bashExec = `"${p}"`;
                                        break;
                                    }
                                }
                            } catch (e) { /* ignore */ }
                        }
                        command = `${bashExec} ${safePath}${argsStr}`;
                    }
                    break;
                case 'batch':
                    command = `cmd /c ${safePath}${argsStr}`;
                    break;
                case 'sql':
                    // SQLファイルはリダイレクト入力のため通常引数はとらないが、sqlite3自体の引数として渡すか、無視するか。
                    // ここではリダイレクト形式を維持し、引数は影響させない（エラー防止のため）
                    command = `sqlite3 :memory: < ${safePath}`;
                    break;
                case 'kotlin':
                    command = `kotlinc ${safePath} -include-runtime -d "${fileNameNoExt}.jar" && java -jar "${fileNameNoExt}.jar"${argsStr}`;
                    break;
                case 'java':
                    let javaClassName = fileNameNoExt;
                    if (globalEditorView && globalEditorView.filePath === activePath) {
                        const content = globalEditorView.state.doc.toString();
                        const match = content.match(/public\s+class\s+(\w+)/);
                        if (match) {
                            javaClassName = match[1];
                        }
                    }
                    command = `javac ${safePath} && java ${javaClassName}${argsStr}`;
                    break;
                case 'brainfuck':
                case 'whitespace':
                    console.log(`Delegating ${langLower} execution to main process...`);
                    const code = globalEditorView ? globalEditorView.state.doc.toString() : "";
                    // 必要であれば executeCode の引数に追加する修正が別途必要
                    const result = await window.electronAPI.executeCode(code, langLower, null, path.dirname(activePath));

                    if (activeTerminalId) {
                        if (result.stdout) window.electronAPI.writeToTerminal(activeTerminalId, result.stdout.replace(/\n/g, '\r\n'));
                        if (result.stderr) window.electronAPI.writeToTerminal(activeTerminalId, `\r\nError:\r\n${result.stderr.replace(/\n/g, '\r\n')}`);
                    }
                    return;

                default:
                    showNotification(`言語 '${langLower}' の実行コマンドは未定義です`, 'error');
                    return;
            }

            // ターミナルへ送信
            const targetTermId = activeTerminalId || (terminals.size > 0 ? terminals.keys().next().value : null);
            if (targetTermId) {
                console.log(`Executing: ${command}`);
                window.electronAPI.writeToTerminal(targetTermId, command + '\r');
            } else {
                await createTerminalSession();
                setTimeout(() => {
                    if (activeTerminalId) {
                        window.electronAPI.writeToTerminal(activeTerminalId, command + '\r');
                    }
                }, 500);
            }
        };

        // --- 実行環境の選択が必要な言語の場合 ---
        if (['python', 'bash'].includes(langLower)) {
            try {
                // 利用可能なバージョン/シェルを取得
                const versions = await window.electronAPI.getLangVersions(langLower);

                // 選択肢が複数ある場合はメニューを表示
                if (versions && versions.length > 1) {
                    const menuItems = versions.map(v => ({
                        label: v.label, // 例: "Python 3.12" or "Git Bash"
                        click: () => executeWithCommand(v.path)
                    }));

                    // 先頭に「デフォルトで実行」を追加（オプション）
                    menuItems.unshift({
                        label: 'デフォルトで実行',
                        click: () => executeWithCommand(null) // nullならデフォルトロジック
                    });

                    menuItems.push({ type: 'separator' });

                    // マウス位置にメニューを表示
                    ContextMenu.show(e.pageX, e.pageY, menuItems);
                    return; // メニュー選択待ちのためここで処理を中断
                }
            } catch (err) {
                console.warn('Failed to get lang versions:', err);
            }
        }

        // 選択肢がない、または不要な場合は即座に実行
        await executeWithCommand(null);
    });
}