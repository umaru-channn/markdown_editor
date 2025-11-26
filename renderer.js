/**
 * Markdown IDE - Main Renderer Process
 * Integrated layout with full Markdown functionality (CodeMirror 6) and Terminal Support
 */

const { EditorState, Prec, Compartment, Annotation } = require("@codemirror/state");
const { EditorView, keymap, highlightActiveLine, lineNumbers } = require("@codemirror/view");
const { defaultKeymap, history, historyKeymap, undo, redo, indentMore, indentLess } = require("@codemirror/commands");
const { markdown, markdownLanguage } = require("@codemirror/lang-markdown");
const { syntaxHighlighting, defaultHighlightStyle, LanguageDescription, indentUnit } = require("@codemirror/language");
const { javascript } = require("@codemirror/lang-javascript");
const { oneDark } = require("@codemirror/theme-one-dark");
const { livePreviewPlugin } = require("./livePreviewPlugin.js");
// ★追加: テーブル拡張機能の読み込み
const { tableExtension, tableKeymap } = require("./tableExtensionVars.js");

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
const headingSelector = document.getElementById('heading-selector');
const btnBulletList = document.getElementById('btn-bullet-list');
const btnNumberList = document.getElementById('btn-number-list');
const btnCheckList = document.getElementById('btn-check-list');

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

    // 5. エディタへの自動フォーカスを削除
    // ファイルを開いたときに勝手にエディタへカーソルが移動するのを防ぐため削除しました。
    /*
    if (targetId === 'content-readme' && globalEditorView) {
        globalEditorView.focus();
    }
    */
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
    if (lang === 'html' || lang === 'htm') return LanguageDescription.of({ name: 'html', support: require("@codemirror/lang-html").html() });
    if (lang === 'css' || lang === 'scss') return LanguageDescription.of({ name: 'css', support: require("@codemirror/lang-css").css() });
    if (lang === 'py' || lang === 'python') return LanguageDescription.of({ name: 'python', support: require("@codemirror/lang-python").python() });
    if (lang === 'md' || lang === 'markdown') return LanguageDescription.of({ name: 'markdown', support: require("@codemirror/lang-markdown").markdown() });
    // 必要に応じて他言語を追加

    return null;
};

const startDoc = `# マークダウン記法の使い方

Markdown（マークダウン）は、手軽に文章の構造や装飾を書くための記法です。
左側に書くと、右側にプレビューが表示されます。

## 見出し
# H1 見出し
## H2 見出し
### H3 見出し
#### H4 見出し
##### H5 見出し
###### H6 見出し

## テキストの装飾
**太字** や *斜体* 、~~取り消し線~~ が使えます。

## リスト
- リスト項目1
- リスト項目2
    - ネストされた項目

1. 番号付きリスト
2. 番号付きリスト
    1-1. ネストされた番号付きリスト

## テーブル
| Header 1 | Header 2 |
| :--- | :--- |
| Cell 1 | Cell 2 |
| Cell 3 | Cell 4 |

## コード
インラインの \`code\` や、コードブロックが書けます：

\`\`\`javascript
console.log('Hello, Markdown!');
const x = 10;
\`\`\`
`;

// ========== リスト操作ロジック (Custom List Handling) ==========

// 正規表現: ハイフン区切りの番号 (1-1. や 2-1-1. など) に対応
const LIST_RE = /^(\s*)((?:[-*+]|\d+(?:-\d+)*\.)|(- \[[ xX]\]))\s+/;
// 番号部分だけを抽出する正規表現 (例: "1-1." -> "1-1")
const ORDERED_RE = /^(\s*)(\d+(?:-\d+)*)\.\s/;

/**
 * 次の連番文字列を生成する関数
 * @param {string} currentNum - 現在の番号文字列 (例: "1", "1-1", "2-1")
 * @returns {string} 次の番号文字列 (例: "2", "1-2", "2-2")
 */
function incrementOrderedNumber(currentNum) {
    const parts = currentNum.split('-');
    const lastPart = parts.pop();
    if (!isNaN(lastPart)) {
        parts.push(String(parseInt(lastPart, 10) + 1));
        return parts.join('-');
    }
    return currentNum; // Fallback
}

/**
 * Enterキー: リストの継続と連番処理
 */
const handleListNewline = (view) => {
    const { state, dispatch } = view;
    const { from, to, empty } = state.selection.main;
    if (!empty) return false;

    const line = state.doc.lineAt(from);
    const text = line.text;
    // カーソルが行末にあるか（または行末までの空白のみか）簡易チェック
    // 厳密にはカーソルより後ろに文字がないことを確認すべきだが、
    // リスト継続は通常行末でEnterを押したときに発動する

    const match = text.match(LIST_RE);
    if (!match) return false;

    const fullMatch = match[0];
    const indent = match[1];
    const marker = match[2];

    // カーソルが行頭のマーカー部分にある場合は通常の改行
    if (from < line.from + fullMatch.length) return false;

    // コンテンツが空の場合 (マーカーのみの行でEnter) -> リスト解除
    if (text.trim().length === fullMatch.trim().length) {
        dispatch({ changes: { from: line.from, to: line.to, insert: "" } });
        return true;
    }

    // コンテンツがある場合 -> 次の項目を作成
    let nextMarker = marker;

    // 番号付きリストの場合、番号をインクリメント
    const orderedMatch = text.match(ORDERED_RE);
    if (orderedMatch) {
        const currentNum = orderedMatch[2]; // "1" or "1-1"
        nextMarker = incrementOrderedNumber(currentNum) + ".";
    } else if (marker.startsWith("- [")) {
        // タスクリストは未チェック状態で継続
        nextMarker = "- [ ]";
    }

    const insertText = `\n${indent}${nextMarker} `;
    dispatch({ changes: { from: to, insert: insertText }, selection: { anchor: to + insertText.length } });
    return true;
};

/**
 * Tabキー: インデントと番号のネスト化 (例: 1. -> 1-1.)
 */
const handleListIndent = (view) => {
    const { state, dispatch } = view;
    const { from, empty } = state.selection.main;

    // 範囲選択時は通常のインデント
    if (!empty && state.selection.ranges.some(r => !r.empty)) {
        return indentMore(view);
    }

    const line = state.doc.lineAt(from);
    const text = line.text;
    const match = text.match(ORDERED_RE);

    if (match) {
        // 番号付きリストの場合
        const currentIndent = match[1];
        const currentNum = match[2]; // "2" とか "1-2"

        // 1つ上の行を探して、親となる番号を取得する
        let parentNum = null;
        if (line.number > 1) {
            for (let i = line.number - 1; i >= 1; i--) {
                const prevLine = state.doc.line(i);
                const prevMatch = prevLine.text.match(ORDERED_RE);
                if (prevMatch) {
                    const prevIndent = prevMatch[1];
                    // インデントが現在の行と同じか少ない行を見つける
                    // ネストする場合、親は「同じインデントレベル」の直前の項目であることが多い
                    // あるいは Markdownの構造的には、親はインデントが少ないはずだが、
                    // ユーザーの要望「1-1」を作るには、「直前の 1.」の子にしたい。
                    // 直前の行がリストなら、それを親とするのが自然。
                    if (prevIndent.length === currentIndent.length) {
                        parentNum = prevMatch[2];
                        break;
                    }
                    if (prevIndent.length < currentIndent.length) {
                        // インデントが浅いものが見つかったらそれが親の可能性が高い
                        parentNum = prevMatch[2];
                        break;
                    }
                } else if (prevLine.text.trim() !== "") {
                    // 空行以外でリストでない行に当たったら探索終了
                    break;
                }
            }
        }

        // 親番号が見つかったら "親番号-1." にする。見つからなければ "1." にする（あるいは "1-1." にする？）
        // ユーザー要望: ネスト -> 1-1. 
        // 通常、1. の下でTabしたら 1-1. になってほしい。
        // つまり直前の行の番号 + "-1"

        // 直前の行を見る（単純化）
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

        // インデントを追加し、マーカーを置換
        const indentUnitText = "    "; // 4スペース
        const changes = [
            { from: line.from, insert: indentUnitText }, // インデント追加
            { from: line.from + match[1].length, to: line.from + match[1].length + match[2].length + 1, insert: newMarker } // マーカー置換
        ];

        dispatch({ changes });
        return true;
    }

    // その他のリストや通常テキストは通常のインデント動作
    return indentMore(view);
};

/**
 * Shift-Tabキー: インデント解除と親連番の再開 (例: 1-1. -> 2.)
 */
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
        // インデントがない場合は何もしない（これ以上解除できない）
        if (currentIndent.length === 0) return indentLess(view);

        // インデントを減らした後、そのレベルでの「続きの番号」を探す
        // つまり、上方向に探索し、(現在のインデント - 1単位) と同じインデントを持つ行を探す

        let targetIndentLen = Math.max(0, currentIndent.length - 4); // 4スペース減らすと仮定
        // タブ文字混在などを考慮すると厳密には難しいが、簡易的に長さを比較

        let nextNum = "1"; // デフォルト

        for (let i = line.number - 1; i >= 1; i--) {
            const prevLine = state.doc.line(i);
            const prevMatch = prevLine.text.match(ORDERED_RE);

            if (prevMatch) {
                const prevIndent = prevMatch[1];
                // ターゲットと同じインデントレベルの行が見つかった
                if (prevIndent.length <= targetIndentLen) {
                    // その番号をインクリメント
                    nextNum = incrementOrderedNumber(prevMatch[2]);
                    break;
                }
            }
        }

        const newMarker = `${nextNum}.`;

        // インデントを削除し、マーカーを置換
        // インデント削除: 先頭から4文字（またはタブ1つ）削除
        let deleteLen = 0;
        if (text.startsWith("\t")) deleteLen = 1;
        else if (text.startsWith("    ")) deleteLen = 4;
        else if (text.startsWith(" ")) deleteLen = currentIndent.length; // インデント全削除フォールバック

        if (deleteLen > 0) {
            const changes = [
                { from: line.from, to: line.from + deleteLen, insert: "" }, // インデント削除
                { from: line.from + match[1].length, to: line.from + match[1].length + match[2].length + 1, insert: newMarker } // マーカー置換
            ];
            dispatch({ changes });
            return true;
        }
    }

    return indentLess(view);
};

// Obsidian風リスト操作キーマップ (カスタマイズ版)
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
    // 既存のモーダルがあれば削除
    const existingModal = document.querySelector('.modal-overlay');
    if (existingModal) existingModal.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.width = '400px'; // 幅を少し広げる

    const message = document.createElement('div');
    message.className = 'modal-message';
    message.textContent = `URLが検出されました: ${url}\nどのように貼り付けますか？`;
    message.style.whiteSpace = 'pre-wrap';
    message.style.wordBreak = 'break-all';

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';

    // キャンセルボタン
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn';
    cancelBtn.textContent = 'キャンセル';

    // 通常のURLとして貼り付けボタン
    const plainBtn = document.createElement('button');
    plainBtn.className = 'modal-btn';
    plainBtn.textContent = '通常のURL';

    // リンク
    const linkBtn = document.createElement('button');
    linkBtn.className = 'modal-btn';
    linkBtn.textContent = 'リンク';

    // ブックマーク - Primary
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
        // カーソル位置にURLを挿入
        view.dispatch(view.state.replaceSelection(url));
        closeModal();
    });

    linkBtn.addEventListener('click', async () => {
        // UIフィードバック: 取得中...
        linkBtn.disabled = true;
        linkBtn.textContent = '取得中...';
        
        try {
            let title = url;
            if (window.electronAPI && window.electronAPI.fetchUrlTitle) {
                title = await window.electronAPI.fetchUrlTitle(url);
            }
            // リンク形式で挿入 [Title](URL)
            view.dispatch(view.state.replaceSelection(`[${title}](${url})`));
            showNotification('リンクを作成しました', 'success');
        } catch (e) {
            console.error('Failed to fetch title', e);
            // 失敗時はURLをタイトルとして挿入
            view.dispatch(view.state.replaceSelection(`[${url}](${url})`));
            showNotification('タイトルの取得に失敗しました', 'error');
        }
        closeModal();
    });

    // ブックマーク: @card を付けて挿入 (プラグインがこれを検知してカード化する)
    bookmarkBtn.addEventListener('click', () => {
        const state = view.state;
        const doc = state.doc;
        const selection = state.selection.main;
        
        // 前後の改行判定
        const hasNewlineBefore = selection.from === 0 || doc.sliceString(selection.from - 1, selection.from) === '\n';
        const hasNewlineAfter = selection.to === doc.length || doc.sliceString(selection.to, selection.to + 1) === '\n';
        
        // @card 識別子を付与
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
        // 簡易的なURLチェック (http/httpsで始まり、空白を含まない)
        const urlRegex = /^(http|https):\/\/[^ "]+$/;

        if (urlRegex.test(text)) {
            event.preventDefault();
            showPasteOptionModal(text, view);
            return true;
        }
        return false;
    }
});

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
            themeCompartment.of(initialTheme),
            editorStyleCompartment.of(initialStyle),
            indentUnit.of("    "),
            
            // ★追加: テーブル拡張機能 (Widget)
            tableExtension,
            // ★追加: テーブル拡張機能 (Keymap) - 優先度を高く設定
            Prec.high(tableKeymap),

            // カスタムキーマップを最高優先度で登録
            Prec.highest(keymap.of(obsidianLikeListKeymap)),
            // ペーストイベントハンドラを追加
            pasteHandler,
            history(),
            keymap.of([
                ...defaultKeymap,
                ...historyKeymap,
                { key: "Mod-s", run: () => { saveCurrentFile(false); return true; } }
            ]),
            syntaxHighlighting(defaultHighlightStyle),
            markdown({ base: markdownLanguage, codeLanguages: codeLanguages }),
            livePreviewPlugin,
            EditorView.lineWrapping,
            highlightActiveLine(),
            lineNumbers(),
            EditorView.updateListener.of(update => {
                if (update.docChanged) {
                    // 変更がプログラムによるもの（ExternalChange）か判定
                    const isExternal = update.transactions.some(tr => tr.annotation(ExternalChange));
                    // 外部変更（読み込み時など）の場合は未保存マークを付けない (false)
                    onEditorInput(!isExternal);
                }
            })
        ],
    });

    globalEditorView = new EditorView({
        state: state,
        parent: editorContainer,
    });
}

// ========== エディタ操作ヘルパー ==========
function toggleLinePrefix(view, prefix) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from } = state.selection.main;
    const line = state.doc.lineAt(from);
    const match = line.text.match(/^\s*(#+\s*|>\s*)/); // 引用(>)も対象に追加

    let changes;
    let newCursorPos;

    // すでに同じプレフィックスがある場合は削除、ない場合は追加
    if (match && match[1].trim() === prefix.trim()) {
        const matchLen = match[0].length;
        changes = { from: line.from, to: line.from + matchLen, insert: "" };
        // 変更後の行末 = 元の行末 - 削除した文字数
        newCursorPos = line.to - matchLen;
    } else {
        const insertText = prefix.endsWith(' ') ? prefix : prefix + ' ';
        if (match) {
            // 置換
            const matchLen = match[0].length;
            changes = { from: line.from, to: line.from + matchLen, insert: insertText };
            // 変更後の行末 = 元の行末 - 削除文字数 + 挿入文字数
            newCursorPos = line.to - matchLen + insertText.length;
        } else {
            // 追加
            changes = { from: line.from, to: line.from, insert: insertText };
            // 変更後の行末 = 元の行末 + 挿入文字数
            newCursorPos = line.to + insertText.length;
        }
    }

    // 変更を適用し、カーソルを「変更後の行の末尾」に移動させる
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

    // 解除ロジック
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

    // 適用ロジック
    dispatch({
        changes: { from: from, to: to, insert: `${mark}${selectedText}${mark}` },
        // 選択範囲なしの場合: マーカーの中間にカーソルを置く
        // 選択範囲ありの場合: マーカーの後ろにカーソルを置く
        selection: empty
            ? { anchor: from + mark.length, head: from + mark.length }
            : { anchor: to + mark.length * 2, head: to + mark.length * 2 }
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
    let totalChangeLength = 0; // 累積文字数変化量

    for (let i = startLine.number; i <= endLine.number; i++) {
        const line = state.doc.line(i);
        const text = line.text;
        const bulletMatch = text.match(/^(\s*)([-*+] )\s*/);
        const orderedMatch = text.match(/^(\s*)(\d+(?:-\d+)*\. )\s*/); // ハイフン付き番号も考慮
        const checkMatch = text.match(/^(\s*)(- \[[ x]\] )\s*/);

        let diff = 0;

        if (type === 'ul') {
            if (bulletMatch) {
                const delLen = bulletMatch[0].length - bulletMatch[1].length; // インデント以外の部分の長さ
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

    // カーソルを最終行の末尾に移動
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
    // 画像記法 ![alt](url) を挿入し、url部分を選択状態にする
    dispatch({
        changes: { from: from, to: to, insert: `![${text}](url)` },
        selection: { anchor: from + 2 + text.length + 2, head: from + 2 + text.length + 5 }
    });
    view.focus();
}

function insertHorizontalRule(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from } = state.selection.main;
    const line = state.doc.lineAt(from);
    // 現在行の最後に改行して水平線を挿入
    const insert = `\n---\n`;
    // 挿入後のカーソル位置（水平線の次の行）
    const newPos = line.to + insert.length;
    dispatch({
        changes: { from: line.to, insert: insert },
        selection: { anchor: newPos, head: newPos }
    });
    view.focus();
}

// ★追加: 改ページを挿入する関数
function insertPageBreak(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from } = state.selection.main;
    const line = state.doc.lineAt(from);
    
    // 現在行の最後に改行して改ページ用タグを挿入
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
        // コードブロック内（1行目の `` ` の次）にカーソルを置くのが親切だが、
        // 「後ろから始めてほしい」という要望なので、ブロックの後に置くか、
        // 少なくともバッククォートの前（行頭）には置かない。
        // ここではブロックの中（書き始めの位置）に置く。
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
document.getElementById('link-btn')?.addEventListener('click', () => insertLink(globalEditorView));
document.getElementById('image-btn')?.addEventListener('click', () => insertImage(globalEditorView));
document.getElementById('code-btn')?.addEventListener('click', () => insertCodeBlock(globalEditorView));
document.getElementById('inline-code-btn')?.addEventListener('click', () => toggleMark(globalEditorView, "`")); // インラインコード追加
document.getElementById('quote-btn')?.addEventListener('click', () => toggleLinePrefix(globalEditorView, ">"));
document.getElementById('hr-btn')?.addEventListener('click', () => insertHorizontalRule(globalEditorView));
// ★追加: 改ページボタンのイベントリスナー
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

// ★変更: PDFエクスポートボタンのイベントリスナー (alert -> showNotification)
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
            const htmlContent = marked.parse(markdownContent);
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

// 初期化時に元のアイテムリストを保存（Moreボタン以外）
function initToolbarOverflow() {
    if (!toolbarLeft || !toolbarMoreBtn) return;

    // Moreボタン以外の要素を配列として保存
    originalToolbarItems = Array.from(toolbarLeft.children).filter(el => el !== toolbarMoreBtn);

    // ResizeObserverでツールバーのサイズ変更を監視
    const resizeObserver = new ResizeObserver(() => {
        // デバウンス（setTimeout）を削除し、アニメーションフレームで即座に処理
        requestAnimationFrame(() => {
            handleToolbarResize();
        });
    });
    resizeObserver.observe(toolbarLeft);

    // Moreボタンのクリックイベント
    toolbarMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toolbarOverflowMenu.classList.toggle('hidden');

        // メニューの位置調整 (ボタンの下、右端合わせ)
        const rect = toolbarMoreBtn.getBoundingClientRect();
        const toolbarRect = toolbarLeft.parentElement.getBoundingClientRect();

        // 右端を合わせる
        const rightOffset = toolbarRect.right - rect.right;
        toolbarOverflowMenu.style.right = rightOffset + 'px';
        toolbarOverflowMenu.style.left = 'auto';
    });

    // メニュー外クリックで閉じる
    document.addEventListener('click', (e) => {
        if (!toolbarOverflowMenu.contains(e.target) && e.target !== toolbarMoreBtn) {
            toolbarOverflowMenu.classList.add('hidden');
        }
    });
}

function handleToolbarResize() {
    if (!toolbarLeft || originalToolbarItems.length === 0) return;

    // 一旦すべてのアイテムをツールバーに戻す（これが重い場合は最適化が必要だが、ボタン数なら許容範囲）
    const currentChildren = Array.from(toolbarLeft.children);
    const itemsInMenu = Array.from(toolbarOverflowMenu.children);

    // メニューにあるアイテムをツールバーに戻す
    itemsInMenu.forEach(item => {
        toolbarLeft.insertBefore(item, toolbarMoreBtn);
    });

    // 順番を元に戻す（これがないと並び順が狂う）
    originalToolbarItems.forEach(item => {
        if (item.parentElement !== toolbarLeft) {
            toolbarLeft.insertBefore(item, toolbarMoreBtn);
        }
    });

    toolbarMoreBtn.classList.add('hidden');

    // コンテナの利用可能な幅を取得
    const containerWidth = toolbarLeft.clientWidth;

    // Moreボタンの幅（スタイルから推測、または固定値）
    const moreBtnWidth = 32;

    let currentWidth = 0;
    let overflowStartIndex = -1;

    // 各アイテムの幅を積算し、あふれる位置を特定
    for (let i = 0; i < originalToolbarItems.length; i++) {
        const item = originalToolbarItems[i];

        // offsetWidthを使って高速化（getBoundingClientRectより軽い）
        const itemWidth = item.offsetWidth + 4; // gap考慮 (CSSのgap: 4pxと一致させる)

        // 次のアイテムを追加したときに、Moreボタンを表示するスペースも含めて収まるか確認
        if (currentWidth + itemWidth > containerWidth - moreBtnWidth - 10) {
            overflowStartIndex = i;
            break;
        }
        currentWidth += itemWidth;
    }

    // あふれるアイテムがある場合、メニューに移動
    if (overflowStartIndex !== -1) {
        toolbarMoreBtn.classList.remove('hidden');

        // あふれたアイテムをメニューに移動
        const fragment = document.createDocumentFragment();
        for (let i = overflowStartIndex; i < originalToolbarItems.length; i++) {
            fragment.appendChild(originalToolbarItems[i]);
        }
        toolbarOverflowMenu.appendChild(fragment);
    }
}

// ========== 基本機能 ==========
/**
 * エディタの内容が変更されたときに呼ばれる処理
 * @param {boolean} markAsDirty - 未保存マーク（●）をつけるかどうか。ファイル読み込み時はfalseにする。
 */
function onEditorInput(markAsDirty = true) {
    // 未保存マークの処理（markAsDirtyがtrueの場合のみ実行）
    if (markAsDirty && currentFilePath && currentFilePath !== 'README.md') {
        fileModificationState.set(currentFilePath, true);
        const tab = document.querySelector(`[data-filepath="${CSS.escape(currentFilePath)}"]`);
        if (tab && !tab.innerHTML.includes('●')) {
            tab.innerHTML = tab.innerHTML.replace('<span class="close-tab"', ' ● <span class="close-tab"');
        }
    }

    // アウトライン更新（デバウンス）
    if (window.outlineUpdateTimeout) clearTimeout(window.outlineUpdateTimeout);
    window.outlineUpdateTimeout = setTimeout(() => {
        updateOutline();
        syncOutlineWithCursor();
    }, 500);

    // PDFプレビュー更新
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
                // 上下配置に関わらず、常にボタンの下（または上）にドロップダウンを表示し、右端を合わせる
                shellDropdown.style.top = `${rect.bottom + 2}px`;
                shellDropdown.style.bottom = 'auto';

                // 画面右端からの距離を計算して、ドロップダウンの右端をボタンの右側に合わせる
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

    // 右アクティビティバーの幅を計算（表示なら幅分、非表示なら0）
    const barWidth = isRightActivityBarVisible ? rightActivityBarWidth : 0;
    // CSS変数にセットして、styles.css側で利用できるようにする
    document.documentElement.style.setProperty('--right-activity-offset', barWidth + 'px');

    // レイアウト変更開始フラグを立てる
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

        // メインコンテンツ全体ではなく、センターペイン（エディタ部分）のみ底上げする
        const currentHeight = bottomPane.style.height || '200px';
        const heightVal = parseInt(currentHeight);

        centerPane.style.marginBottom = heightVal + 'px';

    } else {
        bottomPane.classList.add('hidden');
        if (resizerBottom) resizerBottom.classList.add('hidden');

        // ステータスバーがFlexboxに入ったため、通常時は0pxでOK
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

    // アニメーション終了後にレイアウト計算を行うためのリスナー設定
    const transitionTarget = mainContent;

    const handleTransitionEnd = (e) => {
        // アニメーションが完了したら
        if ((e.target === mainContent && e.propertyName === 'margin-right') ||
            (e.target === centerPane && e.propertyName === 'margin-bottom')) {

            document.body.classList.remove('is-layout-changing');

            if (isTerminalVisible && activeTerminalId) {
                fitTerminal(activeTerminalId);
                const t = terminals.get(activeTerminalId);
                if (t) t.xterm.focus();
            }
        }
    };

    // 毎回追加削除するのは面倒なので、transitionendは一度だけ発火するように調整するか、フォールバックに頼る
    mainContent.addEventListener('transitionend', handleTransitionEnd, { once: true });
    centerPane.addEventListener('transitionend', handleTransitionEnd, { once: true });

    // フォールバック: トランジションが発生しない場合やイベントが発火しない場合のため
    setTimeout(() => {
        if (document.body.classList.contains('is-layout-changing')) {
            document.body.classList.remove('is-layout-changing');
            if (isTerminalVisible && activeTerminalId) fitTerminal(activeTerminalId);
        }
    }, 300); // CSSのtransition時間より少し長く

    if (isTerminalVisible) {
        if (terminals.size === 0) {
            initializeTerminal();
        } else if (activeTerminalId) {
            const targetContainer = isPositionRight ? terminalContainer : terminalBottomContainer;
            const term = terminals.get(activeTerminalId);
            if (term && term.element.parentElement !== targetContainer) {
                targetContainer.appendChild(term.element);
            }
            // fitTerminalはtransitionend後に呼ばれるのでここでは最低限の表示のみ
        }
    }
}

// ========== ヘッダーボタン切り替え ==========
function switchHeaderButtons(targetId) {
    const headerButtonsFiles = document.getElementById('header-buttons-files');
    const headerButtonsGit = document.getElementById('header-buttons-git');
    const headerButtonsOutline = document.getElementById('header-buttons-outline');

    if (headerButtonsFiles) headerButtonsFiles.classList.add('content-hidden');
    if (headerButtonsGit) headerButtonsGit.classList.add('content-hidden');
    if (headerButtonsOutline) headerButtonsOutline.classList.add('content-hidden');

    if (targetId === 'files' && headerButtonsFiles) {
        headerButtonsFiles.classList.remove('content-hidden');
    } else if (targetId === 'git' && headerButtonsGit) {
        headerButtonsGit.classList.remove('content-hidden');
    } else if (targetId === 'outline' && headerButtonsOutline) {
        headerButtonsOutline.classList.remove('content-hidden');
    }
}

// ========== イベントリスナー設定 ==========

// ターミナル開閉
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

// ターミナル位置切り替え
if (btnTogglePosition) {
    btnTogglePosition.addEventListener('click', () => {
        isPositionRight = !isPositionRight;
        requestAnimationFrame(() => {
            updateTerminalVisibility();
        });
    });
}

// 左ペイン表示/非表示
if (btnToggleLeftPane) {
    btnToggleLeftPane.addEventListener('click', () => {
        const willHide = !leftPane.classList.contains('hidden');

        // アニメーション開始フラグ
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

        // フォールバック
        setTimeout(() => {
            document.body.classList.remove('is-layout-changing');
        }, 300);
    });
}

// 左ペイン内容切り替え
topSideSwitchButtons.forEach(btn => {
    btn.addEventListener('click', () => {
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
        }

        switchHeaderButtons(targetId);
    });
});

// Zenモード
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

// PDFプレビュー
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

        const htmlContent = marked.parse(markdownContent);

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

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        if (ideContainer.classList.contains('zen-mode-active')) {
            ideContainer.classList.remove('zen-mode-active');
            isRightActivityBarVisible = savedRightActivityBarState;
            updateTerminalVisibility();
        }
    }
});

// 設定タブ
if (btnSettings) {
    btnSettings.addEventListener('click', () => {
        openSettingsTab();
    });
}

// 右アクティビティバー表示/非表示
if (btnToggleRightActivity) {
    btnToggleRightActivity.addEventListener('click', () => {
        isRightActivityBarVisible = !isRightActivityBarVisible;
        updateTerminalVisibility();
    });
}

// ウィンドウコントロール
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

// ========== ファイルエクスプローラーボタン処理 ==========
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

// ========== Git用ボタン処理 (未実装部分はログ出力) ==========
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

// ========== アウトライン機能の実装 ==========
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

// ========== リサイザー機能 ==========
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
            // ここはmainContentのままでOK
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

            // mainContentではなくcenterPaneの下マージンを更新する
            // これによりエディタだけが押し上げられ、サイドバーは影響を受けない
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

// ========== ファイル名変更処理 ==========
if (fileTitleInput) {
    fileTitleInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            fileTitleInput.blur(); // フォーカスを外して変更を確定させる
        }
    });

    fileTitleInput.addEventListener('blur', async () => {
        const newName = fileTitleInput.value.trim();

        if (!newName || !currentFilePath) return;

        // パスからファイル名（拡張子なし）を抽出して比較
        const separator = currentFilePath.includes('\\') ? '\\' : '/';
        const currentFileName = currentFilePath.split(separator).pop();
        const currentExt = currentFileName.includes('.') ? '.' + currentFileName.split('.').pop() : '';
        const currentNameWithoutExt = currentFileName.replace(currentExt, '');

        // 変更がない場合は何もしない
        if (newName === currentNameWithoutExt) return;

        try {
            if (typeof window.electronAPI?.renameFile === 'function') {
                const result = await window.electronAPI.renameFile(currentFilePath, newName);

                if (result.success) {
                    // リネーム後のタブ更新処理（共通化のため関数化推奨だがここではインライン展開）
                    const oldPath = currentFilePath;
                    const newPath = result.path;
                    const newFileName = newPath.split(separator).pop();

                    // 内部状態の更新
                    const fileData = openedFiles.get(oldPath);
                    if (fileData) {
                        fileData.fileName = newFileName;
                        openedFiles.set(newPath, fileData);
                        openedFiles.delete(oldPath);
                    }

                    // 変更状態の移行
                    if (fileModificationState.has(oldPath)) {
                        fileModificationState.set(newPath, fileModificationState.get(oldPath));
                        fileModificationState.delete(oldPath);
                    }

                    currentFilePath = newPath;
                    document.title = `${newFileName} - Markdown IDE`;

                    // タブの更新
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

                    // ファイルツリーの更新
                    initializeFileTreeWithState();

                    console.log(`Renamed ${oldPath} to ${newPath}`);
                } else {
                    console.error('Rename failed:', result.error);
                    alert(`ファイル名の変更に失敗しました: ${result.error}`);
                    // 入力を元に戻す
                    fileTitleInput.value = currentNameWithoutExt;
                }
            }
        } catch (e) {
            console.error('Error during rename:', e);
            fileTitleInput.value = currentNameWithoutExt;
        }
    });
}

// タブや内部状態を更新するヘルパー関数（ツリーからのリネーム用）
function updateTabsAfterRename(oldPath, newPath, newName) {
    // 内部状態の更新
    const fileData = openedFiles.get(oldPath);
    if (fileData) {
        fileData.fileName = newName; // ファイル名だけを更新（拡張子込み）
        openedFiles.set(newPath, fileData);
        openedFiles.delete(oldPath);
    }

    // 変更状態の移行
    if (fileModificationState.has(oldPath)) {
        fileModificationState.set(newPath, fileModificationState.get(oldPath));
        fileModificationState.delete(oldPath);
    }

    // カレントファイルなら更新
    if (currentFilePath === oldPath) {
        currentFilePath = newPath;
        document.title = `${newName} - Markdown IDE`;

        // タイトルバー入力欄の更新
        if (fileTitleInput) {
            const extIndex = newName.lastIndexOf('.');
            const nameNoExt = extIndex > 0 ? newName.substring(0, extIndex) : newName;
            fileTitleInput.value = nameNoExt;
        }
    }

    // タブの更新
    const tab = document.querySelector(`[data-filepath="${CSS.escape(oldPath)}"]`);
    if (tab) {
        tab.dataset.filepath = newPath;
        const closeBtn = tab.querySelector('.close-tab');
        if (closeBtn) {
            closeBtn.dataset.filepath = newPath;
        }

        // ファイル名表示更新
        const isDirty = tab.innerHTML.includes('●');
        // ファイル名が長すぎる場合の考慮が必要ならここで行うが、簡易的にそのまま
        // タブ内のHTML構造を維持
        tab.childNodes[0].textContent = newName + ' ';
    }
}

// ツリーアイテムのリネーム開始関数
function startRenaming(treeItem) {
    const labelSpan = treeItem.querySelector('.tree-label');
    if (!labelSpan) return;

    const originalName = treeItem.dataset.name;
    const originalPath = treeItem.dataset.path;

    // 既存のラベルを非表示に
    labelSpan.style.display = 'none';

    // 入力フィールド作成
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input'; // cssでスタイル定義
    input.value = originalName;

    // 挿入
    treeItem.appendChild(input);
    input.focus();

    // 拡張子を除いて選択状態にする（ファイルの場合）
    const lastDotIndex = originalName.lastIndexOf('.');
    if (lastDotIndex > 0) {
        input.setSelectionRange(0, lastDotIndex);
    } else {
        input.select();
    }

    let isCommitted = false;

    const finish = async (shouldCommit) => {
        if (isCommitted) return; // 二重実行防止
        isCommitted = true;

        const newName = input.value.trim();

        // 入力欄を削除してラベルを戻す（成功したらあとでツリーリロードされるが、失敗時やキャンセルのために戻す処理は必要）
        input.remove();
        labelSpan.style.display = '';

        if (shouldCommit && newName && newName !== originalName) {
            try {
                if (typeof window.electronAPI?.renameFile === 'function') {
                    // renameFileは拡張子なしの名前を受け取る仕様になっている箇所があるか確認が必要だが、
                    // main.jsの実装を見る限り、拡張子がない場合に補完するロジックが入っている。
                    // ここではフルネーム（拡張子込み）を渡すことを想定して main.js 側が動くはず。
                    // ただし、renderer.jsの既存のrenameFile呼び出し（タイトルバー）は拡張子を除いて渡している。
                    // ここでは入力されたまま（拡張子込み）を渡すのが自然。
                    // main.jsの `rename-file` は `newName` に拡張子がない場合のみ補完するので、
                    // 拡張子付きで渡せばそのまま使われるはず。

                    const result = await window.electronAPI.renameFile(originalPath, newName);
                    if (result.success) {
                        showNotification(`名前を変更しました: ${newName}`, 'success');

                        // タブなどの関連UI更新
                        updateTabsAfterRename(originalPath, result.path, newName);

                        // ツリーをリロードして整合性を保つ
                        // ファイルシステム監視が動いているなら自動更新されるが、即時反映のため呼ぶ
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
        finish(true); // フォーカス外れたら確定
    });

    input.addEventListener('click', (e) => e.stopPropagation()); // ツリーのクリックイベント（開閉）を防止
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('dragstart', (e) => e.stopPropagation()); // ドラッグ防止
}

// ========== ★追加: トースト通知機能 ==========
function showNotification(message, type = 'info') {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `notification-toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // アニメーション用
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // 自動削除 (3秒後)
    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => {
            toast.remove();
        });
    }, 3000);
}

// ========== ファイルエクスプローラのイベント設定（新規） ==========
function setupFileExplorerEvents() {
    const fileContentContainer = document.getElementById('content-files');
    if (fileContentContainer) {
        fileContentContainer.addEventListener('click', (e) => {
            // ツリーアイテムがクリックされた場合は何もしない（アイテムのリスナーで処理）
            if (e.target.closest('.tree-item')) return;

            // 空き領域がクリックされた場合
            const container = document.getElementById('content-files');
            if (container) {
                container.focus();
                // 既存の選択状態を解除
                const selectedItems = container.querySelectorAll('.tree-item.selected');
                selectedItems.forEach(el => el.classList.remove('selected'));
            }
        });
    }
}

// ========== 初期化 ==========
window.addEventListener('load', async () => {
    console.log('Markdown IDE loaded');

    // 設定を読み込む
    await loadSettings();
    setupSettingsListeners();

    initEditor();
    showWelcomeReadme();
    initializeFileTree();
    setupFileExplorerEvents(); // ★追加: 空き領域クリックイベントの設定
    updateOutline();
    updateLeftPaneWidthVariable();
    initToolbarOverflow(); // ツールバーのレスポンシブ初期化

    if (isTerminalVisible) {
        initializeTerminal();
    }
    updateTerminalVisibility();

    if (document.querySelector('.side-switch.active')) {
        switchHeaderButtons(document.querySelector('.side-switch.active').dataset.target);
    }

    // ★追加: ファイルシステム変更通知のリスナー
    if (typeof window.electronAPI?.onFileSystemChanged === 'function') {
        window.electronAPI.onFileSystemChanged((payload) => {
            console.log('File system change detected:', payload);
            // デバウンス処理
            if (window.fileTreeUpdateTimeout) clearTimeout(window.fileTreeUpdateTimeout);
            window.fileTreeUpdateTimeout = setTimeout(() => {
                initializeFileTreeWithState();
            }, 500); // 頻繁な更新を防ぐため0.5秒待つ
        });
    }
});

// ========== ファイルシステム操作 ==========

// ファイルを開く
async function openFile(filePath, fileName) {
    try {
        if (openedFiles.has('README.md')) {
            closeWelcomeReadme();
        }

        let fileContent = '';
        if (typeof window.electronAPI?.loadFile === 'function') {
            try {
                fileContent = await window.electronAPI.loadFile(filePath);
            } catch (error) {
                console.error('Failed to load file content:', error);
                fileContent = `ファイルを読み込めません: ${error.message}`;
            }
        } else {
            fileContent = `ファイル: ${fileName}\n(内容は読み込めません)`;
        }

        let tab = document.querySelector(`[data-filepath="${CSS.escape(filePath)}"]`);
        if (!tab) {
            tab = document.createElement('div');
            tab.className = 'tab';
            tab.dataset.filepath = filePath;
            tab.innerHTML = `${fileName} <span class="close-tab" data-filepath="${filePath}">×</span>`;
            editorTabsContainer.appendChild(tab);
            openedFiles.set(filePath, { content: fileContent, fileName: fileName });
        }

        switchToFile(filePath);
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
        // ファイル切り替え時は ExternalChange アノテーションを付けて dispatch
        globalEditorView.dispatch({
            changes: { from: 0, to: globalEditorView.state.doc.length, insert: fileContent },
            annotations: ExternalChange.of(true) // プログラムによる変更であることを明示
        });
    }

    // ファイル名入力欄の更新
    if (fileTitleInput) {
        const fileName = fileData ? fileData.fileName : filePath.split(/[\/\\]/).pop();
        // 拡張子を除く
        const extIndex = fileName.lastIndexOf('.');
        const fileNameWithoutExt = extIndex > 0 ? fileName.substring(0, extIndex) : fileName;
        fileTitleInput.value = fileNameWithoutExt;
    }

    // ビューの同期
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
    // 要素削除
    if (element) element.remove();

    if (isSettings) {
        // 設定タブを閉じた場合、直近のファイルに戻る
        switchToLastFileOrReadme();
    } else {
        // ファイルタブを閉じた場合
        const filePath = element.dataset.filepath;

        // READMEは特別扱いせず閉じる
        if (filePath) {
            openedFiles.delete(filePath);
            fileModificationState.delete(filePath);

            if (currentFilePath === filePath) {
                currentFilePath = null;
                if (globalEditorView) {
                    // タブを閉じてエディタをクリアする際も ExternalChange を付与
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

// ========== タブ管理：イベント委譲 ==========
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

// ★追加: 展開状態を保存しながらファイルツリーを更新する関数
async function initializeFileTreeWithState() {
    const fileTreeContainer = document.getElementById('file-tree-container');
    if (!fileTreeContainer) return;

    // 現在開いているフォルダのパスを保存
    const expandedPaths = new Set();
    const items = fileTreeContainer.querySelectorAll('.tree-item');
    items.forEach(item => {
        const toggle = item.querySelector('.tree-toggle');
        // トグルが「▶」ではなく「▼」になっており、かつ子要素が表示されているものを保存
        if (toggle && toggle.textContent === '▼' && item.nextElementSibling && item.nextElementSibling.style.display !== 'none') {
            expandedPaths.add(item.dataset.path);
        }
    });
    // ルートディレクトリは常に展開対象
    if (currentDirectoryPath) expandedPaths.add(currentDirectoryPath);

    // ツリーの再構築
    await initializeFileTree();

    // 展開状態の復元
    // 注: DOMが再構築されるため、新しいDOMに対して操作する必要がある
    // initializeFileTreeは非同期でルート直下のみ読み込むため、深層のフォルダを開くには再帰的な処理が必要
    // ここでは簡易的に、保存されたパスのリストを使って順番に開いていく

    // パスの深さ順にソート（親フォルダから順に開くため）
    const sortedPaths = Array.from(expandedPaths).sort((a, b) => a.length - b.length);

    // 新しいコンテナを取得（initializeFileTreeで置換されているため）
    const newContainer = document.getElementById('file-tree-container');
    if (!newContainer) return;

    for (const path of sortedPaths) {
        // パスに対応する要素を探す
        const item = newContainer.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`);
        if (item) {
            const toggle = item.querySelector('.tree-toggle');
            if (toggle && toggle.textContent === '▶') {
                // まだ開いていない場合は開く
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

            // ★追加: ルートアイテムにもドラッグ＆ドロップイベントを追加
            rootItem.addEventListener('dragover', handleDragOver);
            rootItem.addEventListener('dragleave', handleDragLeave);
            rootItem.addEventListener('drop', handleDrop);
        }

        // ★追加: コンテナ全体（余白含む）へのドロップ対応
        newFileTreeContainer.addEventListener('dragover', handleDragOver);
        newFileTreeContainer.addEventListener('drop', handleDrop);

        // クリックイベント委譲
        newFileTreeContainer.addEventListener('click', (e) => {
            const item = e.target.closest('.tree-item');

            // ★修正: アイテム以外（空き領域）のクリックはここでは無視し、親(#content-files)のリスナーに任せる
            // stopPropagationしなければ親まで伝播する
            if (!item) {
                return;
            }

            if (item.classList.contains('creation-mode')) return;
            // リネーム用input内でのクリックは無視
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

        // コンテキストメニューイベント委譲
        newFileTreeContainer.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.tree-item');
            if (!item) return;
            if (item.classList.contains('creation-mode')) return;
            // リネーム中はメニューを出さない
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

        // 常に最新の内容をロードするように変更（ファイル監視と同期しやすくするため）
        // if (childrenContainer.children.length === 0) { 
        await loadDirectoryTreeContents(folderElement, folderPath);
        // }
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

    // ルートアイテム（pathがcurrentDirectoryPathと同じ）はドラッグ不可にする
    if (!item || !item.dataset.path || item.dataset.path === currentDirectoryPath) {
        e.preventDefault();
        return;
    }

    // ドラッグするファイルのパスを設定
    e.dataTransfer.setData('text/plain', item.dataset.path);
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation(); // イベントバブリング防止
}

function handleDragOver(e) {
    e.preventDefault(); // ドロップを許可するために必須
    e.stopPropagation(); // イベントバブリング防止

    const targetItem = e.target.closest('.tree-item');
    if (targetItem) {
        // フォルダの上にある場合のみハイライト（ファイルの上にはドロップできないようにする...が、
        // 親フォルダへのドロップとして扱うならファイル上でもOKかもしれない。
        // ここではシンプルにフォルダのみをターゲットとする）
        if (!targetItem.classList.contains('file')) {
            targetItem.classList.add('drag-over');
            e.dataTransfer.dropEffect = 'move';
        } else {
            e.dataTransfer.dropEffect = 'none';
        }
    } else {
        // 余白（ルート）へのドロップを許可
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
    e.stopPropagation(); // イベントバブリング防止（これが二重実行防止の鍵）

    const targetItem = e.target.closest('.tree-item');
    if (targetItem) targetItem.classList.remove('drag-over');

    const srcPath = e.dataTransfer.getData('text/plain');
    if (!srcPath) return;

    let destFolderPath;

    if (targetItem) {
        // 移動先がフォルダでない場合はキャンセル（ファイルへのドロップは無視）
        if (targetItem.classList.contains('file')) return;
        destFolderPath = targetItem.dataset.path;
    } else {
        // ターゲットがない（余白へのドロップ）場合、ルートディレクトリを移動先とする
        destFolderPath = currentDirectoryPath;
    }

    if (!destFolderPath) return;

    // 自分自身やその子孫への移動を禁止するためのチェックはメインプロセスで行うか、ここで行う
    if (srcPath === destFolderPath) return; // 自分自身へのドロップ

    // ファイル名を抽出 (区切り文字は / または \)
    const fileName = srcPath.split(/[/\\]/).pop();

    // 移動先の区切り文字を推測 (destFolderPathに含まれるもの、なければ /)
    const destSep = destFolderPath.includes('\\') ? '\\' : '/';

    // 移動先パスを作成 (重複するセパレータを防ぐ)
    let destPath = destFolderPath;
    if (!destPath.endsWith(destSep)) {
        destPath += destSep;
    }
    destPath += fileName;

    // 移動実行
    if (srcPath !== destPath) {
        try {
            if (typeof window.electronAPI?.moveFile === 'function') {
                const result = await window.electronAPI.moveFile(srcPath, destPath);
                if (result.success) {
                    showNotification(`移動しました: ${fileName}`, 'success');
                    // ファイルツリーの更新は onFileSystemChanged で行われるためここでは何もしない
                    // 必要なら即時反映ロジックを追加
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
    // ★修正: item.path (フルパス) があればそれを優先して dataset.path に設定する
    // メインプロセスから返ってくる item.path は既に path.join で正しく処理されているため
    // 手動結合によるパス区切り文字の不整合を防ぐ
    const itemPath = item.path || `${parentPath}/${item.name}`;

    const container = document.createElement('div');
    container.className = 'tree-item' + (item.isDirectory ? '' : ' file');
    container.dataset.path = itemPath;
    container.dataset.name = item.name;

    // ドラッグ&ドロップ属性とイベントリスナーを追加
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

        const separator = (targetPath.endsWith('/') || targetPath.endsWith('\\')) ? '' : '/';
        const newPath = targetPath + separator + name;

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
            // ★修正: 自動リロードに任せるため、ここでの手動リロードは必須ではないが、
            // 即時フィードバックのため残しておく（ただし、ウォッチャーとの競合はデバウンスで吸収）
            await reloadContainer(targetContainer, targetPath);

            if (!isFolder) {
                openFile(newPath, name);
            }

        } catch (e) {
            console.error(e);
            safeRemove();
        } finally {
            isCreating = false;
        }
    };

    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            finishCreation();
        } else if (e.key === 'Escape') {
            if (!isCreating) safeRemove();
        }
    });

    inputField.addEventListener('blur', () => {
        if (!isCreating) {
            setTimeout(safeRemove, 100);
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

// ========== ショートカットキーと削除機能 ==========
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveCurrentFile();
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
                showModalConfirm(name, () => {
                    confirmAndDelete(path);
                });
            }
        }
    }
});

function showModalConfirm(itemName, onConfirm) {
    const existingModal = document.querySelector('.modal-overlay');
    if (existingModal) existingModal.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';

    const message = document.createElement('div');
    message.className = 'modal-message';
    message.textContent = `「${itemName}」を本当に削除しますか？\n（フォルダの場合は中身も削除されます）`;

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn';
    cancelBtn.textContent = 'キャンセル';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'modal-btn primary';
    deleteBtn.textContent = '削除';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(deleteBtn);
    content.appendChild(message);
    content.appendChild(buttons);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const closeModal = () => {
        overlay.remove();
        if (globalEditorView) globalEditorView.focus();
    };

    cancelBtn.addEventListener('click', closeModal);

    deleteBtn.addEventListener('click', () => {
        onConfirm();
        closeModal();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });
}

async function confirmAndDelete(path) {
    try {
        if (typeof window.electronAPI?.deleteFile === 'function') {
            const success = await window.electronAPI.deleteFile(path);

            if (success) {
                // 削除成功時、開いているタブを確認して閉じる処理
                // path は削除されたファイルまたはフォルダのパス

                // 削除対象に含まれる開いているファイルを探す
                const tabsToClose = [];

                for (const [filePath, _] of openedFiles) {
                    // 完全一致（ファイル削除）または前方一致（フォルダ削除でその中身）
                    // 区切り文字を含めてチェックすることで、類似名の別ファイルを誤検知するのを防ぐ
                    // 例: "test" フォルダ削除で "test-file.md" が消えないように
                    if (filePath === path ||
                        filePath.startsWith(path + '\\') ||
                        filePath.startsWith(path + '/')) {
                        tabsToClose.push(filePath);
                    }
                }

                // 該当するタブを閉じる
                tabsToClose.forEach(filePath => {
                    const tab = document.querySelector(`[data-filepath="${CSS.escape(filePath)}"]`);
                    if (tab) {
                        // closeTab(element, isSettings)
                        closeTab(tab, false);
                    }
                });

                showNotification('削除しました', 'success');
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

function showContextMenu(x, y, path, name) {
    if (activeContextMenu) activeContextMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    // ★追加: 名前の変更
    const renameOption = document.createElement('div');
    renameOption.className = 'context-menu-item';
    renameOption.textContent = '名前の変更';
    renameOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        const treeItem = document.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`);
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
        showModalConfirm(name, () => {
            confirmAndDelete(path);
        });
    });

    menu.appendChild(renameOption);
    menu.appendChild(deleteOption);
    document.body.appendChild(menu);
    activeContextMenu = menu;
}

document.addEventListener('click', () => {
    if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
    }
});