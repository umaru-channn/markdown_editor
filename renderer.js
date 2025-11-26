/**
 * Markdown IDE - Main Renderer Process
 * Integrated layout with full Markdown functionality (CodeMirror 6) and Terminal Support
 * Update: Added Search functionality (Ctrl+F) with VS Code like styling
 * Update: Added drawSelection for persistent selection visibility
 * Update: Dynamic language switching based on file extension
 * Fix: Corrected variable name in showContextMenu to prevent "An object could not be cloned" error
 * Fix: Wrapped StreamLanguage in LanguageSupport to prevent "Cannot read properties of undefined (reading 'parser')" error
 */

const path = require('path');
const { EditorState, Prec, Compartment, Annotation } = require("@codemirror/state");
const { EditorView, keymap, highlightActiveLine, lineNumbers, drawSelection, dropCursor } = require("@codemirror/view");
const { defaultKeymap, history, historyKeymap, undo, redo, indentMore, indentLess } = require("@codemirror/commands");
// 変更点: LanguageSupport をインポートに追加
const { syntaxHighlighting, defaultHighlightStyle, LanguageDescription, indentUnit, StreamLanguage, LanguageSupport } = require("@codemirror/language");
const { oneDark } = require("@codemirror/theme-one-dark");
const { livePreviewPlugin } = require("./livePreviewPlugin.js");
const { tablePlugin } = require("./tablePlugin.js");

// 言語パッケージのインポート（Modern）
const { markdown, markdownLanguage } = require("@codemirror/lang-markdown");
const { javascript } = require("@codemirror/lang-javascript");
const { html: htmlLang } = require("@codemirror/lang-html");
const { css } = require("@codemirror/lang-css");
const { json } = require("@codemirror/lang-json");
const { python } = require("@codemirror/lang-python");
const { cpp } = require("@codemirror/lang-cpp");
const { java } = require("@codemirror/lang-java");
const { rust } = require("@codemirror/lang-rust");
const { sql } = require("@codemirror/lang-sql");
const { php } = require("@codemirror/lang-php");
const { go } = require("@codemirror/lang-go");
const { xml } = require("@codemirror/lang-xml");
const { yaml } = require("@codemirror/lang-yaml");

// 言語パッケージのインポート（Legacy / StreamLanguage）
const { csharp, scala, kotlin, dart } = require("@codemirror/legacy-modes/mode/clike");
const { ruby } = require("@codemirror/legacy-modes/mode/ruby");
const { swift } = require("@codemirror/legacy-modes/mode/swift");
const { shell } = require("@codemirror/legacy-modes/mode/shell");
const { powerShell } = require("@codemirror/legacy-modes/mode/powershell");
const { dockerFile } = require("@codemirror/legacy-modes/mode/dockerfile");
const { lua } = require("@codemirror/legacy-modes/mode/lua");
const { perl } = require("@codemirror/legacy-modes/mode/perl");
const { r } = require("@codemirror/legacy-modes/mode/r");
const { diff: diffLanguage } = require("@codemirror/legacy-modes/mode/diff");

// @codemirror/search から必要なクラスをインポート
const {
    search,
    setSearchQuery,
    SearchQuery,
    findNext,
    findPrevious,
    replaceNext,
    replaceAll,
    closeSearchPanel
} = require("@codemirror/search");

// プログラムによる変更を識別するためのアノテーション
const ExternalChange = Annotation.define();

// ========== DOM要素取得 ==========
const ideContainer = document.getElementById('ide-container');
const leftPane = document.getElementById('left-pane');
const rightPane = document.getElementById('right-pane');
const rightActivityBar = document.querySelector('.right-activity-bar');
const bottomPane = document.getElementById('bottom-pane');
const centerPane = document.getElementById('center-pane');

// トップバー操作
const btnToggleLeftPane = document.getElementById('btn-toggle-leftpane');
const topSideSwitchButtons = document.querySelectorAll('.side-switch');

// ウィンドウコントロール
const btnToggleRightActivity = document.getElementById('btn-toggle-right-activity');
const btnMinimize = document.getElementById('btn-minimize');
const btnMaximize = document.getElementById('btn-maximize');
const btnClose = document.getElementById('btn-close');

// 左ペイン
const leftPaneHeader = document.getElementById('left-pane-header');
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
const contentReadme = document.getElementById('content-readme');
const contentSettings = document.getElementById('content-settings');
const tabReadme = document.getElementById('tab-readme');

// ファイルタイトル入力
const fileTitleBar = document.getElementById('file-title-bar');
const fileTitleInput = document.getElementById('file-title-input');

// ファイル統計情報
const fileStatsElement = document.getElementById('file-stats');

// ツールバーボタン
const btnBulletList = document.getElementById('btn-bullet-list');
const btnNumberList = document.getElementById('btn-number-list');
const btnCheckList = document.getElementById('btn-check-list');

// 最近使ったファイルリスト
const btnRecentClear = document.getElementById('btn-recent-clear');
const recentFilesList = document.getElementById('recent-files-list');

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

// 設定管理
let appSettings = {
    fontSize: '16px',
    fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
    theme: 'light',
    autoSave: true
};

// CodeMirror Compartments for dynamic reconfiguration
const themeCompartment = new Compartment();
const editorStyleCompartment = new Compartment();
const languageCompartment = new Compartment(); // 言語設定用のCompartment

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

// ========== 左ペイン幅の動的制御用変数更新関数 ==========
function updateLeftPaneWidthVariable() {
    const isHidden = leftPane.classList.contains('hidden');
    const width = isHidden ? '0px' : '240px';
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

    // 4. ファイルタイトルバーの表示制御
    if (targetId === 'content-readme' && currentFilePath !== 'README.md') {
        if (fileTitleBar) fileTitleBar.classList.remove('hidden');
    } else {
        if (fileTitleBar) fileTitleBar.classList.add('hidden');
    }
}

// ========== 設定関連の関数 ==========

async function loadSettings() {
    try {
        const settings = await window.electronAPI.loadAppSettings();
        if (settings) {
            appSettings = { ...appSettings, ...settings };
        }
        applySettingsToUI();
        updateEditorSettings();
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

function applySettingsToUI() {
    // DOM要素への反映
    const fontSizeInput = document.getElementById('font-size');
    const fontFamilyInput = document.getElementById('font-family');
    const themeInput = document.getElementById('theme');
    const autoSaveInput = document.getElementById('auto-save');

    if (fontSizeInput) fontSizeInput.value = appSettings.fontSize;
    if (fontFamilyInput) fontFamilyInput.value = appSettings.fontFamily;
    if (themeInput) themeInput.value = appSettings.theme;
    if (autoSaveInput) autoSaveInput.checked = appSettings.autoSave;

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

    document.getElementById('auto-save')?.addEventListener('change', (e) => {
        appSettings.autoSave = e.target.checked;
        saveSettings();
    });
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

// ========== CodeMirror Initialization (LiveMark機能の統合) ==========

const codeLanguages = (info) => {
    const lang = String(info).trim().toLowerCase();
    if (!lang) return null;

    if (lang === 'js' || lang === 'javascript' || lang === 'node') return LanguageDescription.of({ name: 'javascript', support: javascript() });
    if (lang === 'ts' || lang === 'typescript') return LanguageDescription.of({ name: 'typescript', support: javascript({ typescript: true }) });
    if (lang === 'html' || lang === 'htm') return LanguageDescription.of({ name: 'html', support: htmlLang() });
    if (lang === 'css' || lang === 'scss') return LanguageDescription.of({ name: 'css', support: css() });
    if (lang === 'py' || lang === 'python') return LanguageDescription.of({ name: 'python', support: python() });
    if (lang === 'md' || lang === 'markdown') return LanguageDescription.of({ name: 'markdown', support: markdown({ base: markdownLanguage, codeLanguages: codeLanguages }) });
    if (lang === 'c' || lang === 'cpp') return LanguageDescription.of({ name: 'cpp', support: cpp() });
    if (lang === 'java') return LanguageDescription.of({ name: 'java', support: java() });
    if (lang === 'rust') return LanguageDescription.of({ name: 'rust', support: rust() });
    if (lang === 'sql') return LanguageDescription.of({ name: 'sql', support: sql() });
    if (lang === 'json') return LanguageDescription.of({ name: 'json', support: json() });
    if (lang === 'php') return LanguageDescription.of({ name: 'php', support: php() });
    if (lang === 'go' || lang === 'golang') return LanguageDescription.of({ name: 'go', support: go() });
    if (lang === 'xml') return LanguageDescription.of({ name: 'xml', support: xml() });
    if (lang === 'yaml' || lang === 'yml') return LanguageDescription.of({ name: 'yaml', support: yaml() });

    // Legacy / StreamLanguage supports (変更点: new LanguageSupport()でラップする)
    if (lang === 'c#' || lang === 'csharp' || lang === 'cs') return LanguageDescription.of({ name: 'csharp', support: new LanguageSupport(StreamLanguage.define(csharp)) });
    if (lang === 'ruby' || lang === 'rb') return LanguageDescription.of({ name: 'ruby', support: new LanguageSupport(StreamLanguage.define(ruby)) });
    if (lang === 'swift') return LanguageDescription.of({ name: 'swift', support: new LanguageSupport(StreamLanguage.define(swift)) });
    if (lang === 'kotlin' || lang === 'kt') return LanguageDescription.of({ name: 'kotlin', support: new LanguageSupport(StreamLanguage.define(kotlin)) });
    if (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh') return LanguageDescription.of({ name: 'bash', support: new LanguageSupport(StreamLanguage.define(shell)) });
    if (lang === 'powershell' || lang === 'ps1') return LanguageDescription.of({ name: 'powershell', support: new LanguageSupport(StreamLanguage.define(powerShell)) });
    if (lang === 'dockerfile' || lang === 'docker') return LanguageDescription.of({ name: 'dockerfile', support: new LanguageSupport(StreamLanguage.define(dockerFile)) });
    if (lang === 'lua') return LanguageDescription.of({ name: 'lua', support: new LanguageSupport(StreamLanguage.define(lua)) });
    if (lang === 'perl' || lang === 'pl') return LanguageDescription.of({ name: 'perl', support: new LanguageSupport(StreamLanguage.define(perl)) });
    if (lang === 'r') return LanguageDescription.of({ name: 'r', support: new LanguageSupport(StreamLanguage.define(r)) });
    if (lang === 'dart') return LanguageDescription.of({ name: 'dart', support: new LanguageSupport(StreamLanguage.define(dart)) });
    if (lang === 'scala') return LanguageDescription.of({ name: 'scala', support: new LanguageSupport(StreamLanguage.define(scala)) });
    if (lang === 'diff' || lang === 'patch') return LanguageDescription.of({ name: 'diff', support: new LanguageSupport(StreamLanguage.define(diffLanguage)) });

    return null;
};

// 拡張子に基づいて適切な言語Extensionの配列を返す関数
function getLanguageExtensions(filePath) {
    // デフォルト（ファイルパスがない、または不明な場合）はMarkdownとして扱う
    const defaultMarkdown = [
        markdown({ base: markdownLanguage, codeLanguages: codeLanguages }),
        livePreviewPlugin,
        tablePlugin
    ];

    if (!filePath) return defaultMarkdown;

    const ext = path.extname(filePath).toLowerCase();

    // 拡張子に応じた言語設定
    switch (ext) {
        // Markdownとして扱う拡張子 (.md, .markdown, .txt など)
        case '.md':
        case '.markdown':
        case '.txt':
        case '.text':
        case '.log':
            return defaultMarkdown;

        // 各プログラミング言語
        case '.js':
        case '.jsx':
            return [javascript({ jsx: true })];
        case '.ts':
        case '.tsx':
            return [javascript({ typescript: true, jsx: true })];
        case '.html':
        case '.htm':
            return [htmlLang()];
        case '.css':
        case '.scss':
        case '.less':
            return [css()];
        case '.json':
            return [json()];
        case '.py':
            return [python()];
        case '.c':
        case '.cpp':
        case '.h':
        case '.hpp':
            return [cpp()];
        case '.java':
            return [java()];
        case '.rs':
            return [rust()];
        case '.sql':
            return [sql()];
        case '.php':
            return [php()];
        case '.go':
            return [go()];
        case '.xml':
            return [xml()];
        case '.yaml':
        case '.yml':
            return [yaml()];
        
        // Legacy Modes (変更点: new LanguageSupport()でラップする)
        case '.cs':
            return [new LanguageSupport(StreamLanguage.define(csharp))];
        case '.rb':
            return [new LanguageSupport(StreamLanguage.define(ruby))];
        case '.swift':
            return [new LanguageSupport(StreamLanguage.define(swift))];
        case '.kt':
        case '.kts':
            return [new LanguageSupport(StreamLanguage.define(kotlin))];
        case '.sh':
        case '.bash':
        case '.zsh':
            return [new LanguageSupport(StreamLanguage.define(shell))];
        case '.ps1':
        case '.psm1':
            return [new LanguageSupport(StreamLanguage.define(powerShell))];
        case 'dockerfile':
        case '.dockerfile':
            return [new LanguageSupport(StreamLanguage.define(dockerFile))];
        case '.lua':
            return [new LanguageSupport(StreamLanguage.define(lua))];
        case '.pl':
        case '.pm':
            return [new LanguageSupport(StreamLanguage.define(perl))];
        case '.r':
            return [new LanguageSupport(StreamLanguage.define(r))];
        case '.dart':
            return [new LanguageSupport(StreamLanguage.define(dart))];
        case '.scala':
            return [new LanguageSupport(StreamLanguage.define(scala))];
        case '.diff':
        case '.patch':
            return [new LanguageSupport(StreamLanguage.define(diffLanguage))];

        // 未知の拡張子や拡張子なしの場合も、このエディタの性質上Markdownとして扱う
        default:
            // "Dockerfile" (no ext) check
            if (path.basename(filePath).toLowerCase() === 'dockerfile') {
                return [new LanguageSupport(StreamLanguage.define(dockerFile))];
            }
            return defaultMarkdown;
    }
}

const startDoc = `# Markdown IDE の使い方

このエディタは、Markdown記法をリアルタイムでプレビューしながら記述できるIDEです。
上部のツールバーを使って、簡単に装飾や要素を挿入できます。

## 🛠 ツールバー機能

### 基本操作
- 💾 **保存**: \`Ctrl + S\`
- 📤 **PDFエクスポート**: 記述した内容をPDFとして保存します。
- ↩/↪ **元に戻す/やり直し**: \`Ctrl + Z\` / \`Ctrl + Y\`

### 検索機能
- 🔍 **検索**: \`Ctrl + F\` (編集画面内を検索・置換できます)

### テキスト装飾
ツールバーのボタンで以下の装飾が可能です。
- **太字**: \`**Bold**\` (Ctrl + B)
- *斜体*: \`*Italic*\` (Ctrl + I)
- ~~取り消し線~~: \`~~Strike~~\` (Ctrl + Shift + S)
- ==ハイライト==: \`==Highlight==\`

### 見出し
\`H2\`, \`H3\` ボタンで素早く見出しを作成できます。\`Ctrl + 1\` ~ \`Ctrl + 6\` のショートカットも利用可能です。

### リスト
- 箇条書きリスト
1. 番号付きリスト
- [ ] チェックリスト（タスクリスト）

### 挿入機能
- **リンク**: \`[タイトル](URL)\`
- **画像**: \`![alt](画像URL)\`
- **引用**: \`> 引用テキスト\`
- **コード**: インライン \` \`code\` \` やコードブロック
- **区切り線**: \`---\`

## ✨ 高度な機能

### テーブル（表）
ツールバーの \`Table\` ボタンで挿入できます。
作成されたテーブルは、マウス操作で**列幅の変更**や**行・列の追加/削除**が可能です。

| 機能 | 説明 | 対応 |
| :--- | :--- | :---: |
| リサイズ | 列の境界線をドラッグ | ✅ |
| 編集 | セルを直接編集 | ✅ |
| 右クリック | 行・列の操作メニュー | ✅ |

### 改ページ (Page Break)
PDFエクスポート時の改ページ位置を指定できます。ツールバーの改ページボタンを押すと挿入されます。

<div class="page-break"></div>

（↑ここに改ページが入っています）

### ブックマークカード (URL貼り付け)
URLをエディタに貼り付けると、メニューが表示され「ブックマーク」を選択するとリッチなカード形式で表示されます。

@card https://www.electronjs.org/

### コードブロック
言語を指定してシンタックスハイライトが可能です。

\`\`\`javascript
function hello() {
    console.log("Hello, Markdown IDE!");
}
\`\`\`

## ⌨️ ショートカットキー
- \`Ctrl + S\`: 保存
- \`Ctrl + B\`: 太字
- \`Ctrl + I\`: 斜体
- \`Ctrl + Shift + S\`: 取り消し線
- \`Ctrl + 1\` ~ \`6\`: 見出し1~6
- \`Ctrl + F\`: 検索
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

    const orderedMatch = text.match(ORDERED_RE);
    if (orderedMatch) {
        const currentNum = orderedMatch[2];
        nextMarker = incrementOrderedNumber(currentNum) + ".";
    } else if (marker.startsWith("- [")) {
        nextMarker = "- [ ]";
    }

    const insertText = `\n${indent}${nextMarker} `;
    dispatch({ changes: { from: to, insert: insertText }, selection: { anchor: to + insertText.length } });
    return true;
};

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

function initEditor() {
    if (globalEditorView) return;

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

    const state = EditorState.create({
        doc: startDoc,
        extensions: [
            // 日本語化設定（標準パネルは使わないが念のため）
            EditorState.phrases.of({
                "Find": "検索...",
            }),
            themeCompartment.of(initialTheme),
            editorStyleCompartment.of(initialStyle),
            indentUnit.of("    "),
            Prec.highest(keymap.of(obsidianLikeListKeymap)),
            pasteHandler,
            history(),

            // 重要変更: search({ top: true }) を削除し、UIなしの search() のみに変更
            search(),

            // drawSelectionでエディタの選択範囲を独自に描画する（フォーカスアウト時も表示するため）
            drawSelection(),
            dropCursor(),

            // 重要: Prec.highestを使って、標準の検索キーバインドより優先度を高くする
            // これにより、もし標準のキーマップが残っていても、こちらの処理が優先される
            Prec.highest(keymap.of([
                { key: "Mod-f", run: () => { searchWidgetControl?.open(); return true; } },
                { key: "Mod-h", run: () => { searchWidgetControl?.toggleReplace(); return true; } },
                {
                    key: "Escape", run: () => {
                        const widget = document.getElementById('custom-search-widget');
                        if (widget && !widget.classList.contains('hidden')) {
                            widget.classList.add('hidden');
                            globalEditorView.focus();
                            return true;
                        }
                        return false;
                    }
                },
                // エディタ操作系（優先度高）
                { key: "Mod-s", run: () => { saveCurrentFile(false); return true; } },
                { key: "Mod-b", run: (view) => { toggleMark(view, "**"); return true; } },
                { key: "Mod-i", run: (view) => { toggleMark(view, "*"); return true; } },
                { key: "Mod-Shift-s", run: (view) => { toggleMark(view, "~~"); return true; } },
                { key: "Mod-1", run: (view) => { toggleLinePrefix(view, "#"); return true; } },
                { key: "Mod-2", run: (view) => { toggleLinePrefix(view, "##"); return true; } },
                { key: "Mod-3", run: (view) => { toggleLinePrefix(view, "###"); return true; } },
                { key: "Mod-4", run: (view) => { toggleLinePrefix(view, "####"); return true; } },
                { key: "Mod-5", run: (view) => { toggleLinePrefix(view, "#####"); return true; } },
                { key: "Mod-6", run: (view) => { toggleLinePrefix(view, "######"); return true; } },
            ])),

            // キーバインディング
            keymap.of([
                ...defaultKeymap,
                ...historyKeymap,
            ]),

            syntaxHighlighting(defaultHighlightStyle),
            
            // 言語設定とプラグインを動的に切り替えられるようにCompartment化
            // デフォルトはMarkdownモード
            languageCompartment.of(getLanguageExtensions('default.md')),

            EditorView.lineWrapping,
            highlightActiveLine(),
            lineNumbers(),
            EditorView.updateListener.of(update => {
                if (update.docChanged) {
                    const isExternal = update.transactions.some(tr => tr.annotation(ExternalChange));
                    onEditorInput(!isExternal);
                }
            })
        ],
    });

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

// ========== ツールバーボタン イベントリスナー ==========
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
document.getElementById('btn-table')?.addEventListener('click', () => insertTable(globalEditorView));

document.getElementById('code-btn')?.addEventListener('click', () => insertCodeBlock(globalEditorView));
document.getElementById('inline-code-btn')?.addEventListener('click', () => toggleMark(globalEditorView, "`"));
document.getElementById('quote-btn')?.addEventListener('click', () => toggleLinePrefix(globalEditorView, ">"));
document.getElementById('hr-btn')?.addEventListener('click', () => insertHorizontalRule(globalEditorView));
document.getElementById('btn-page-break')?.addEventListener('click', () => insertPageBreak(globalEditorView));

if (btnBulletList) btnBulletList.addEventListener('click', () => toggleList(globalEditorView, 'ul'));
if (btnNumberList) btnNumberList.addEventListener('click', () => toggleList(globalEditorView, 'ol'));
if (btnCheckList) btnCheckList.addEventListener('click', () => toggleList(globalEditorView, 'task'));

document.getElementById('btn-close-file-toolbar')?.addEventListener('click', () => {
    if (currentFilePath) {
        const tab = document.querySelector(`[data-filepath="${CSS.escape(currentFilePath)}"]`);
        closeTab(tab, false);
    }
});

const btnExportPdf = document.getElementById('btn-export-pdf');
if (btnExportPdf) {
    btnExportPdf.addEventListener('click', async () => {
        if (!globalEditorView) return;
        const markdownContent = globalEditorView.state.doc.toString();

        if (!markdownContent.trim()) {
            showNotification('エクスポートするコンテンツがありません。', 'error');
            return;
        }

        try {
            const processedMarkdown = await processMarkdownForExport(markdownContent);
            const htmlContent = marked.parse(processedMarkdown, { breaks: true, gfm: true });

            if (typeof window.electronAPI?.exportPdf === 'function') {
                const result = await window.electronAPI.exportPdf(htmlContent);
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
    });
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
function onEditorInput(markAsDirty = true) {
    if (markAsDirty && currentFilePath && currentFilePath !== 'README.md') {
        fileModificationState.set(currentFilePath, true);
        const tab = document.querySelector(`[data-filepath="${CSS.escape(currentFilePath)}"]`);
        if (tab && !tab.innerHTML.includes('●')) {
            tab.innerHTML = tab.innerHTML.replace('<span class="close-tab"', ' ● <span class="close-tab"');
        }
    }

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

    if (rightActivityBar) {
        rightActivityBar.classList.toggle('hidden', !isRightActivityBarVisible);
    }

    const showPdf = isPdfPreviewVisible;
    const showTerminalRight = isTerminalVisible && isPositionRight;
    const needRightPane = (showPdf || showTerminalRight) && isRightActivityBarVisible;

    const barWidth = isRightActivityBarVisible ? rightActivityBarWidth : 0;
    document.documentElement.style.setProperty('--right-activity-offset,', barWidth + 'px');

    // レイアウト変更中のフラグは一時的に立てるが、CSSトランジション削除に伴い即座に解除してOK
    document.body.classList.add('is-layout-changing');

    if (needRightPane) {
        rightPane.classList.remove('hidden');
        if (resizerRight) resizerRight.classList.remove('hidden');

        if (showPdf) {
            if (terminalHeader) terminalHeader.classList.add('hidden');
            if (terminalContainer) terminalContainer.classList.add('hidden');
            if (pdfPreviewHeader) pdfPreviewHeader.classList.remove('hidden');
            if (pdfPreviewContainer) pdfPreviewContainer.classList.remove('hidden');
        } else {
            if (terminalHeader) terminalHeader.classList.remove('hidden');
            if (terminalContainer) terminalContainer.classList.remove('hidden');
            if (pdfPreviewHeader) pdfPreviewHeader.classList.add('hidden');
            if (pdfPreviewContainer) pdfPreviewContainer.classList.add('hidden');
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
        if (!bottomPane.style.height || bottomPane.style.height === '0px') {
            bottomPane.style.height = '200px';
            resizerBottom.style.top = `calc(100vh - 200px - 24px)`;
        }

        const currentHeight = bottomPane.style.height || '200px';
        const heightVal = parseInt(currentHeight);

        centerPane.style.marginBottom = heightVal + 'px';

    } else {
        bottomPane.classList.add('hidden');
        if (resizerBottom) resizerBottom.classList.add('hidden');

        if (!isTerminalVisible || isPositionRight) {
            centerPane.style.marginBottom = '0px';
        }
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

    if (headerButtonsFiles) headerButtonsFiles.classList.add('content-hidden');
    if (headerButtonsGit) headerButtonsGit.classList.add('content-hidden');
    if (headerButtonsOutline) headerButtonsOutline.classList.add('content-hidden');
    if (headerButtonsRecent) headerButtonsRecent.classList.add('content-hidden');

    if (targetId === 'files' && headerButtonsFiles) {
        headerButtonsFiles.classList.remove('content-hidden');
    } else if (targetId === 'git' && headerButtonsGit) {
        headerButtonsGit.classList.remove('content-hidden');
    } else if (targetId === 'outline' && headerButtonsOutline) {
        headerButtonsOutline.classList.remove('content-hidden');
    } else if (targetId === 'recent' && headerButtonsRecent) {
        headerButtonsRecent.classList.remove('content-hidden');
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

if (btnPdfPreview) {
    btnPdfPreview.addEventListener('click', () => {
        togglePdfPreview();
    });
}

function togglePdfPreview() {
    if (isPdfPreviewVisible) {
        isPdfPreviewVisible = false;
    } else {
        isPdfPreviewVisible = true;
        isTerminalVisible = false;
        generatePdfPreview();
    }
    updateTerminalVisibility();
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

        const processedMarkdown = await processMarkdownForExport(markdownContent);
        const htmlContent = marked.parse(processedMarkdown, { breaks: true, gfm: true });

        if (typeof window.electronAPI?.generatePdf === 'function') {
            await renderHtmlToPdf(htmlContent);
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
    let processed = markdown.replace(/==([^=]+)==/g, '<mark>$1</mark>');

    processed = processed.replace(/^(\s+)(\d+(?:-\d+)+\.)/gm, (match, indent, marker) => {
        return '&nbsp;'.repeat(indent.length) + marker;
    });

    const bookmarkRegex = /^@card\s+(https?:\/\/[^\s]+)$/gm;
    const matches = [...processed.matchAll(bookmarkRegex)];

    if (matches.length === 0) return processed;

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

        const html = `<a href="${data.url}" class="cm-bookmark-widget" target="_blank" rel="noopener noreferrer">
    <div class="cm-bookmark-content">
        <div class="cm-bookmark-title">${data.title}</div>
        <div class="cm-bookmark-desc">${data.description}</div>
        <div class="cm-bookmark-meta">
            <img src="${faviconUrl}" class="cm-bookmark-favicon">
            <span class="cm-bookmark-domain">${data.domain}</span>
        </div>
    </div>
    ${data.image ? `<div class="cm-bookmark-cover"><img src="${data.image}" class="cm-bookmark-image"></div>` : ''}
</a>`;

        return {
            original: match[0],
            replacement: html
        };
    }));

    for (const item of replacements) {
        processed = processed.replaceAll(item.original, item.replacement);
    }

    return processed;
}

async function renderHtmlToPdf(htmlContent) {
    try {
        const pdfData = await window.electronAPI.generatePdf(htmlContent);
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
        if (typeof pdfjsLib === 'undefined') {
            console.error('PDF.js library not loaded');
            return;
        }

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
    
    return `${date.getFullYear()}/${(date.getMonth()+1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
}

function renderRecentFiles() {
    if (!recentFilesList) return;
    recentFilesList.innerHTML = '';

    if (recentFiles.length === 0) {
        recentFilesList.innerHTML = '<li style="padding: 10px; color: #888; font-size: 12px;">履歴はありません</li>';
        return;
    }

    recentFiles.forEach(item => {
        const separator = item.path.includes('\\') ? '\\' : '/';
        const fileName = item.path.split(separator).pop();
        const dirPath = item.path.substring(0, item.path.length - fileName.length);
        
        // 短縮パス生成 (最後のフォルダ名/.../)
        let displayPath = dirPath;
        const dirParts = dirPath.split(separator).filter(p => p);
        if (dirParts.length > 0) {
            displayPath = '.../' + dirParts[dirParts.length - 1] + '/';
        }

        const li = document.createElement('li');
        li.className = 'recent-file-item';
        li.title = item.path; // ホバーでフルパス表示
        li.innerHTML = `
            <div class="recent-file-name">${fileName}</div>
            <div class="recent-file-info">
                <span class="recent-file-path">${displayPath}</span>
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
    btnRecentClear.addEventListener('click', async () => {
        if (confirm('最近開いたファイルの履歴をすべて消去しますか？')) {
            recentFiles = [];
            await saveRecentFiles();
            renderRecentFiles();
        }
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

const btnGitStage = document.getElementById('btn-git-stage');
const btnGitUnstage = document.getElementById('btn-git-unstage');
const btnGitRefresh = document.getElementById('btn-git-refresh');

if (btnGitStage) {
    btnGitStage.addEventListener('click', () => {
        console.log('すべての変更をステージングしました。(処理未実装)');
    });
}

if (btnGitUnstage) {
    btnGitUnstage.addEventListener('click', () => {
        console.log('すべての変更をアンステージングしました。(処理未実装)');
    });
}

if (btnGitRefresh) {
    btnGitRefresh.addEventListener('click', () => {
        console.log('Gitの状態を更新しました。(処理未実装)');
    });
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
let isResizingRight = false;
let isResizingBottom = false;

if (resizerRight) {
    resizerRight.addEventListener('mousedown', () => {
        isResizingRight = true;
        resizerRight.classList.add('resizing');
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
                    alert(`ファイル名の変更に失敗しました: ${result.error}`);
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

window.addEventListener('load', async () => {
    console.log('Markdown IDE loaded');

    await loadSettings();
    await loadRecentFiles();
    setupSettingsListeners();
    setupSyncSettings();

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

    if (isTerminalVisible) {
        initializeTerminal();
    }
    updateTerminalVisibility();

    if (document.querySelector('.side-switch.active')) {
        switchHeaderButtons(document.querySelector('.side-switch.active').dataset.target);
    }

    if (typeof window.electronAPI?.onFileSystemChanged === 'function') {
        window.electronAPI.onFileSystemChanged((payload) => {
            console.log('File system change detected:', payload);
            if (window.fileTreeUpdateTimeout) clearTimeout(window.fileTreeUpdateTimeout);
            window.fileTreeUpdateTimeout = setTimeout(() => {
                initializeFileTreeWithState();
            }, 500);
        });
    }

    // エディタのコンテキストメニューリスナー設定
    if (editorContainer) {
        editorContainer.addEventListener('contextmenu', (e) => {
            if (!globalEditorView) return;
            e.preventDefault();
            window.electronAPI.showEditorContextMenu();
        });
    }

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

// ========== ファイルシステム操作 ==========

async function openFile(filePath, fileName) {
    // パスを正規化して統一（区切り文字の違いや相対パスの問題を解消）
    const normalizedPath = path.resolve(filePath);

    // 履歴に追加
    addToRecentFiles(normalizedPath);

    try {
        if (openedFiles.has('README.md')) {
            closeWelcomeReadme();
        }

        // 既に開いているかチェック（正規化されたパスを使用）
        let tab = document.querySelector(`[data-filepath="${CSS.escape(normalizedPath)}"]`);

        // 既にタブがある場合は、ファイル読み込みをスキップして切り替えるだけにする
        if (tab) {
            switchToFile(normalizedPath);
            return;
        }

        let fileContent = '';
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

        if (!tab) {
            tab = document.createElement('div');
            tab.className = 'tab';
            tab.dataset.filepath = normalizedPath;
            tab.innerHTML = `${fileName} <span class="close-tab" data-filepath="${normalizedPath}">×</span>`;
            editorTabsContainer.appendChild(tab);
            openedFiles.set(normalizedPath, { content: fileContent, fileName: fileName });
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
        fileName: 'README.md'
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
    currentFilePath = filePath;
    const fileData = openedFiles.get(filePath);
    const fileContent = fileData ? fileData.content : '';

    if (globalEditorView) {
        // エディタの内容を更新
        globalEditorView.dispatch({
            changes: { from: 0, to: globalEditorView.state.doc.length, insert: fileContent },
            // 言語モードを動的に切り替え
            effects: languageCompartment.reconfigure(getLanguageExtensions(filePath)),
            annotations: ExternalChange.of(true)
        });
    }

    if (fileTitleInput) {
        const fileName = fileData ? fileData.fileName : filePath.split(/[\/\\]/).pop();
        const extIndex = fileName.lastIndexOf('.');
        const fileNameWithoutExt = extIndex > 0 ? fileName.substring(0, extIndex) : fileName;
        fileTitleInput.value = fileNameWithoutExt;
    }

    switchMainView('content-readme');

    updateOutline();

    if (isPdfPreviewVisible) {
        generatePdfPreview();
    }

    if (fileData) {
        document.title = `${fileData.fileName} - Markdown IDE`;
    }

    updateFileStats();
}

function closeTab(element, isSettings = false) {
    if (element) element.remove();

    if (isSettings) {
        switchToLastFileOrReadme();
    } else {
        const filePath = element.dataset.filepath;

        if (filePath) {
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

async function saveCurrentFile(isSaveAs = false) {
    if (!currentFilePath) {
        console.warn('ファイルが選択されていません');
        return;
    }
    if (!globalEditorView) return;
    if (currentFilePath === 'README.md') return;

    try {
        const content = globalEditorView.state.doc.toString();
        if (typeof window.electronAPI?.saveFile === 'function') {
            await window.electronAPI.saveFile(currentFilePath, content);

            const fileData = openedFiles.get(currentFilePath);
            if (fileData) {
                fileData.content = content;
            }
            fileModificationState.delete(currentFilePath);

            const tab = document.querySelector(`[data-filepath="${CSS.escape(currentFilePath)}"]`);
            if (tab) {
                const fileName = currentFilePath.split(/[\/\\]/).pop();
                tab.innerHTML = `${fileName} <span class="close-tab" data-filepath="${currentFilePath}">×</span>`;
            }
            console.log(`✅ ファイルを保存しました: ${currentFilePath}`);
        }
    } catch (error) {
        console.error('Failed to save file:', error);
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
}

async function initializeFileTree() {
    try {
        if (typeof window.electronAPI?.getCurrentDirectory === 'function') {
            currentDirectoryPath = await window.electronAPI.getCurrentDirectory();
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
            // フォーカスが外れたときはキャンセル扱いにするか、
            // 自動保存するかはUXによるが、ここでは誤操作防止のため
            // バリデーションエラーがあればキャンセル、なければ作成とする手もあるが
            // 既存の挙動（safeRemove）に合わせておく（ただしエラー状態なら作成しない）
            
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

// ========== フォントサイズ調整用ヘルパー ==========
function adjustFontSize(delta) {
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
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveCurrentFile();
    }

    // フォントサイズ拡大縮小 (Zoom In/Out)
    // Ctrl + + / Ctrl + = / Ctrl + ; (JIS)
    if (e.ctrlKey || e.metaKey) {
        if (e.key === '+' || e.key === ';' || e.key === '=') {
            e.preventDefault();
            adjustFontSize(2); // +2px
        } else if (e.key === '-') {
            e.preventDefault();
            adjustFontSize(-2); // -2px
        } else if (e.key === '0') {
            e.preventDefault();
            appSettings.fontSize = '16px'; // リセット
            saveSettings();
            applySettingsToUI();
            updateEditorSettings();
        }
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const activeTab = document.querySelector('.editor-tabs .tab.active');
        if (activeTab) {
            if (activeTab.id === 'tab-settings') {
                closeTab(activeTab, true);
            }
            else if (activeTab.dataset.filepath) {
                closeTab(activeTab, false);
            }
        }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        e.preventDefault();

        const tabs = Array.from(document.querySelectorAll('.editor-tabs .tab'));
        if (tabs.length <= 1) return;

        const activeIndex = tabs.findIndex(tab => tab.classList.contains('active'));
        if (activeIndex === -1) return;

        let nextIndex;
        if (e.shiftKey) {
            nextIndex = (activeIndex - 1 + tabs.length) % tabs.length;
        } else {
            nextIndex = (activeIndex + 1) % tabs.length;
        }

        tabs[nextIndex].click();
    }

    if (e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) {
        const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        if (activeTag === 'input' || activeTag === 'textarea' || document.activeElement.classList.contains('cm-content')) return;

        const selectedItem = document.getElementById('file-tree-container')?.querySelector('.tree-item.selected');
        if (selectedItem) {
            if (selectedItem.classList.contains('creation-mode')) return;

            const path = selectedItem.dataset.path;
            const name = selectedItem.dataset.name;
            if (path && name) {
                // 確認ポップアップを消して直接実行
                confirmAndDelete(path);
            }
        }
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

let activeContextMenu = null;

function showContextMenu(x, y, itemPath, name) {
    if (activeContextMenu) activeContextMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const renameOption = document.createElement('div');
    renameOption.className = 'context-menu-item';
    renameOption.textContent = '名前の変更';
    renameOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        // Fix: Use itemPath instead of path module
        const treeItem = document.querySelector(`.tree-item[data-path="${CSS.escape(itemPath)}"]`);
        if (treeItem) {
            startRenaming(treeItem);
        }
    });

    const deleteOption = document.createElement('div');
    deleteOption.className = 'context-menu-item';
    deleteOption.textContent = '削除';
    deleteOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        // 確認ポップアップを消して直接実行
        confirmAndDelete(itemPath);
    });

    // --- 区切り線 ---
    const separator = document.createElement('div');
    separator.style.height = '1px';
    separator.style.backgroundColor = 'rgba(128, 128, 128, 0.3)';
    separator.style.margin = '4px 0';

    // 相対パスをコピー
    const copyRelPathOption = document.createElement('div');
    copyRelPathOption.className = 'context-menu-item';
    copyRelPathOption.textContent = '相対パスをコピー';
    copyRelPathOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        const relPath = path.relative(currentDirectoryPath, itemPath);
        navigator.clipboard.writeText(relPath);
        showNotification('相対パスをコピーしました', 'success');
    });

    // 絶対パスをコピー
    const copyAbsPathOption = document.createElement('div');
    copyAbsPathOption.className = 'context-menu-item';
    copyAbsPathOption.textContent = '絶対パスをコピー';
    copyAbsPathOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        navigator.clipboard.writeText(itemPath);
        showNotification('絶対パスをコピーしました', 'success');
    });

    // エクスプローラーで表示
    const openExplorerOption = document.createElement('div');
    openExplorerOption.className = 'context-menu-item';
    openExplorerOption.textContent = 'エクスプローラーで表示';
    openExplorerOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        window.electronAPI.showItemInFolder(itemPath);
    });

    menu.appendChild(renameOption);
    menu.appendChild(deleteOption);
    menu.appendChild(separator);
    menu.appendChild(copyRelPathOption);
    menu.appendChild(copyAbsPathOption);
    menu.appendChild(openExplorerOption);

    document.body.appendChild(menu);
    activeContextMenu = menu;
}

// 空白部分用のコンテキストメニュー表示
function showEmptySpaceContextMenu(x, y) {
    if (activeContextMenu) activeContextMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const newFileOption = document.createElement('div');
    newFileOption.className = 'context-menu-item';
    newFileOption.textContent = '新規ファイル';
    newFileOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        showCreationInput(false); // 新規ファイル作成
    });

    const newFolderOption = document.createElement('div');
    newFolderOption.className = 'context-menu-item';
    newFolderOption.textContent = '新規フォルダ';
    newFolderOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        showCreationInput(true); // 新規フォルダ作成
    });

    // --- 区切り線(ルートディレクトリ用) ---
    const separator = document.createElement('div');
    separator.style.height = '1px';
    separator.style.backgroundColor = 'rgba(128, 128, 128, 0.3)';
    separator.style.margin = '4px 0';

    // 相対パスをコピー (ルートなので "." )
    const copyRelPathOption = document.createElement('div');
    copyRelPathOption.className = 'context-menu-item';
    copyRelPathOption.textContent = '相対パスをコピー';
    copyRelPathOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        navigator.clipboard.writeText('.'); 
        showNotification('相対パス(.)をコピーしました', 'success');
    });

    // 絶対パスをコピー
    const copyAbsPathOption = document.createElement('div');
    copyAbsPathOption.className = 'context-menu-item';
    copyAbsPathOption.textContent = '絶対パスをコピー';
    copyAbsPathOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        navigator.clipboard.writeText(currentDirectoryPath);
        showNotification('絶対パスをコピーしました', 'success');
    });

    // エクスプローラーで開く
    const openExplorerOption = document.createElement('div');
    openExplorerOption.className = 'context-menu-item';
    openExplorerOption.textContent = 'エクスプローラーで開く';
    openExplorerOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        window.electronAPI.openPath(currentDirectoryPath);
    });

    menu.appendChild(newFileOption);
    menu.appendChild(newFolderOption);
    menu.appendChild(separator);
    menu.appendChild(copyRelPathOption);
    menu.appendChild(copyAbsPathOption);
    menu.appendChild(openExplorerOption);

    document.body.appendChild(menu);
    activeContextMenu = menu;
}

document.addEventListener('click', () => {
    if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
    }
});