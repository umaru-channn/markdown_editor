/**
 * Markdown IDE - Main Renderer Process
 * Integrated layout with full Markdown functionality
 */

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
// PDFプレビュー用ボタン（サイドバー）
const btnPdfPreview = document.getElementById('btn-pdf-preview');

// エディタ
const editor = document.getElementById('editor');

// ターミナルコンテナ
const terminalContainer = document.getElementById('terminal-container');
const terminalBottomContainer = document.getElementById('terminal-bottom-container');

// エディタタブ
const editorTabsContainer = document.getElementById('editor-tabs');
const contentReadme = document.getElementById('content-readme');
const contentSettings = document.getElementById('content-settings');
const tabReadme = document.getElementById('tab-readme');

// ファイル統計情報表示要素
const fileStatsElement = document.getElementById('file-stats');

// ========== 状態管理 ==========
let isPositionRight = true;
let isTerminalVisible = false;
let isRightActivityBarVisible = true;
let isMaximized = false;
let isProcessing = false;
// Zenモードに入る前の右アクティビティバーの状態を保存
let savedRightActivityBarState = true;

// ========== PDF Preview State ==========
let isPdfPreviewVisible = false;
let pdfDocument = null;

// ========== xterm.js ==========
let term = null;
let fitAddon = null;

// ========== コマンド履歴 ==========
let commandHistory = [];
let historyIndex = 0;
let commandBuffer = '';

// 補完用の変数
let completionCandidates = [];
let completionIndex = -1;
let completionPrefix = '';

// サポートされる言語のリスト
const supportedLanguages = [
    { name: 'JavaScript', value: 'javascript', aliases: ['js'] },
    { name: 'TypeScript', value: 'typescript', aliases: ['ts'] },
    { name: 'Python', value: 'python', aliases: ['py'] },
    { name: 'Java', value: 'java', aliases: [] },
    { name: 'C', value: 'c', aliases: [] },
    { name: 'C++', value: 'cpp', aliases: ['c++'] },
    { name: 'PHP', value: 'php', aliases: [] },
    { name: 'Ruby', value: 'ruby', aliases: ['rb'] },
    { name: 'Go', value: 'go', aliases: ['golang'] },
    { name: 'Rust', value: 'rust', aliases: ['rs'] },
    { name: 'Swift', value: 'swift', aliases: [] },
    { name: 'SQL', value: 'sql', aliases: [] },
    { name: 'Bash', value: 'bash', aliases: ['sh', 'shell'] },
    { name: 'JSON', value: 'json', aliases: [] },
    { name: 'YAML', value: 'yaml', aliases: ['yml'] },
    { name: 'CSS', value: 'css', aliases: [] },
    { name: 'HTML', value: 'markup', aliases: ['html', 'xml'] },
    { name: 'Markdown', value: 'markdown', aliases: ['md'] },
    { name: 'Mermaid', value: 'mermaid', aliases: [] }
];

// ========== ターミナル・右ペイン表示状態更新 (統合版) ==========
function updateTerminalVisibility() {
    const mainContent = centerPane.parentElement;
    const rightActivityBarWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--activitybar-width')) || 50;

    // DOM要素
    const terminalHeader = document.getElementById('terminal-header');
    const terminalContainer = document.getElementById('terminal-container');
    const pdfPreviewHeader = document.getElementById('pdf-preview-header');
    const pdfPreviewContainer = document.getElementById('pdf-preview-container');

    // アクティビティバーの表示切り替え
    if (rightActivityBar) {
        rightActivityBar.classList.toggle('hidden', !isRightActivityBarVisible);
    }

    // 右ペインを表示すべきか判定
    const showPdf = isPdfPreviewVisible;
    const showTerminalRight = isTerminalVisible && isPositionRight;
    const needRightPane = (showPdf || showTerminalRight) && isRightActivityBarVisible;

    if (needRightPane) {
        rightPane.classList.remove('hidden');
        // ★追加: 右リサイザーを表示
        if (resizerRight) resizerRight.classList.remove('hidden');

        // コンテンツの排他表示切り替え
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

        // 幅とマージンの調整
        const rightPaneWidth = rightPane.style.width || '350px';
        document.documentElement.style.setProperty('--right-pane-width', rightPaneWidth);
        const barWidth = isRightActivityBarVisible ? rightActivityBarWidth : 0;
        mainContent.style.marginRight = (parseFloat(rightPaneWidth) + barWidth) + 'px';

    } else {
        // 右ペインを隠す
        rightPane.classList.add('hidden');
        // ★追加: 右リサイザーを隠す
        if (resizerRight) resizerRight.classList.add('hidden');

        document.documentElement.style.setProperty('--right-pane-width', '0px');
        const barWidth = isRightActivityBarVisible ? rightActivityBarWidth : 0;
        mainContent.style.marginRight = barWidth + 'px';
    }

    // 下ペイン（ターミナル）の制御
    if (isTerminalVisible && !isPositionRight) {
        bottomPane.classList.remove('hidden');
        // ★追加: 下リサイザーを表示
        if (resizerBottom) resizerBottom.classList.remove('hidden');
    } else {
        bottomPane.classList.add('hidden');
        // ★追加: 下リサイザーを隠す
        if (resizerBottom) resizerBottom.classList.add('hidden');
    }

    // ボタンのアクティブ状態更新
    if (btnTerminalRight) btnTerminalRight.classList.toggle('active', isTerminalVisible);
    if (btnPdfPreview) btnPdfPreview.classList.toggle('active', isPdfPreviewVisible);

    // ターミナル初期化
    if (isTerminalVisible && !term && typeof initializeTerminal === 'function') {
        initializeTerminal();
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

// ========== タブ切り替え ==========
function switchTab(targetTab) {
    if (!targetTab) return;

    document.querySelectorAll('.editor-tabs .tab, .editor-tabs div[data-target]').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.center-pane .editor-area, .center-pane .settings-view-content').forEach(c => c.classList.add('content-hidden'));

    targetTab.classList.add('active');
    const contentId = targetTab.dataset.target;
    if (contentId) {
        const targetContent = document.getElementById(contentId);
        if (targetContent) {
            targetContent.classList.remove('content-hidden');
        }
    }
}

// ========== イベントリスナー設定 ==========

// ターミナル開閉
if (btnTerminalRight) {
    btnTerminalRight.addEventListener('click', () => {
        if (isTerminalVisible) {
            // 既に開いている場合は閉じる
            isTerminalVisible = false;
        } else {
            // 開く場合はPDFを閉じてから開く（排他制御）
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
        updateTerminalVisibility();
    });
}

// 左ペイン表示/非表示
if (btnToggleLeftPane) {
    btnToggleLeftPane.addEventListener('click', () => {
        const willHide = !leftPane.classList.contains('hidden');
        leftPane.classList.toggle('hidden', willHide);
        ideContainer.classList.toggle('left-pane-hidden', willHide);
    });
}

// 左ペイン内容切り替え（Files/Git/Outline）
topSideSwitchButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        if (tabReadme) switchTab(tabReadme);

        const targetId = btn.dataset.target;
        if (!targetId) return;

        leftPane.classList.remove('hidden');
        ideContainer.classList.remove('left-pane-hidden');

        topSideSwitchButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        leftPaneContents.forEach(content => content.classList.add('content-hidden'));
        const targetContent = document.getElementById('content-' + targetId);
        if (targetContent) {
            targetContent.classList.remove('content-hidden');
        }

        switchHeaderButtons(targetId);
    });
});

// Zenモード
if (btnZen) {
    btnZen.addEventListener('click', () => {
        // ★修正: Zenモードに入る前にターミナル/PDFプレビューを強制的に閉じる
        const enteringZenMode = !ideContainer.classList.contains('zen-mode-active');

        if (enteringZenMode) {

            // ★修正: 現在の右アクティビティバーの状態を保存
            savedRightActivityBarState = isRightActivityBarVisible;  

            // Zenモードに入る際、ターミナルとPDFプレビューを非表示にする
            isTerminalVisible = false;
            isPdfPreviewVisible = false;
            isRightActivityBarVisible = false;

            // ターミナル/PDFの非表示をDOMに反映させる
            updateTerminalVisibility();
        }

        ideContainer.classList.toggle('zen-mode-active');
    });
}

// PDFプレビュー（サイドバーアイコン）
if (btnPdfPreview) {
    btnPdfPreview.addEventListener('click', () => {
        togglePdfPreview();
    });
}

// PDF preview toggle function (排他制御付き)
function togglePdfPreview() {
    if (isPdfPreviewVisible) {
        // 既に開いている場合は閉じる
        isPdfPreviewVisible = false;
    } else {
        // 開く場合はターミナルを閉じてから開く（排他制御）
        isPdfPreviewVisible = true;
        isTerminalVisible = false;
        generatePdfPreview();
    }
    updateTerminalVisibility();
}

// Generate PDF preview from markdown content
async function generatePdfPreview() {
    try {
        // Get markdown content from editor
        const markdownContent = editor.value || '';

        if (!markdownContent.trim()) {
            const canvas = document.getElementById('pdf-canvas');
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.font = '16px Arial';
                ctx.fillStyle = '#999';
                ctx.fillText('マークダウンコンテンツがありません', 50, 50);
            }
            return;
        }

        // Convert markdown to HTML
        const htmlContent = marked.parse(markdownContent);

        // Render HTML to PDF using Electron's printToPDF
        await renderHtmlToPdf(htmlContent);
    } catch (error) {
        console.error('Failed to generate PDF preview:', error);
        alert(`PDFプレビューの生成に失敗しました: ${error.message}`);
    }
}

// Render HTML content to PDF
async function renderHtmlToPdf(htmlContent) {
    try {
        // Create a temporary container for rendering
        const tempContainer = document.createElement('div');
        tempContainer.style.position = 'absolute';
        tempContainer.style.left = '-9999px';
        tempContainer.style.width = '794px'; // A4 width in pixels at 96 DPI
        tempContainer.style.padding = '40px';
        tempContainer.style.backgroundColor = 'white';
        tempContainer.style.fontFamily = 'Arial, sans-serif';
        tempContainer.style.fontSize = '14px';
        tempContainer.style.lineHeight = '1.6';
        tempContainer.innerHTML = htmlContent;
        document.body.appendChild(tempContainer);

        // Use Electron's API to generate PDF
        if (typeof window.electronAPI?.generatePdf === 'function') {
            const pdfData = await window.electronAPI.generatePdf(htmlContent);
            document.body.removeChild(tempContainer);

            if (pdfData) {
                await displayPdfFromData(pdfData);
            }
        } else {
            // Fallback: Create a simple canvas-based preview
            await createCanvasBasedPreview(tempContainer);
            document.body.removeChild(tempContainer);
        }
    } catch (error) {
        console.error('Error rendering HTML to PDF:', error);
        throw error;
    }
}

// Create a canvas-based preview (fallback method)
async function createCanvasBasedPreview(htmlElement) {
    const canvas = document.getElementById('pdf-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Set canvas size to A4 proportions
    canvas.width = 794;
    canvas.height = 1123;

    // Fill white background
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw content
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

// Display PDF from data
async function displayPdfFromData(pdfData) {
    try {
        if (typeof pdfjsLib === 'undefined') {
            console.error('PDF.js library not loaded');
            return;
        }

        // Convert base64 to Uint8Array
        const pdfDataArray = Uint8Array.from(atob(pdfData), c => c.charCodeAt(0));

        // Load PDF document
        const loadingTask = pdfjsLib.getDocument({ data: pdfDataArray });
        pdfDocument = await loadingTask.promise;

        // ページ数表示の更新
        const pageInfo = document.getElementById('pdf-page-info');
        if (pageInfo) {
            pageInfo.textContent = `全 ${pdfDocument.numPages} ページ`;
        }

        // コンテナを取得してクリア
        const container = document.getElementById('pdf-preview-container');
        if (!container) return;
        container.innerHTML = ''; // 既存のキャンバスを削除

        // 全ページをレンダリング
        for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
            await renderPageToContainer(pageNum, container);
        }

    } catch (error) {
        console.error('Error displaying PDF:', error);
    }
}

// 新しいレンダリング関数: コンテナにキャンバスを追加して描画
async function renderPageToContainer(pageNumber, container) {
    try {
        const page = await pdfDocument.getPage(pageNumber);

        // キャンバスを作成
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        container.appendChild(canvas);

        const context = canvas.getContext('2d');
        // コンテナの幅に合わせてスケールを計算するロジックを入れるとより良いですが、
        // 一旦固定スケールまたは既存のロジックで描画します
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
        // Zenモードがアクティブな場合のみ処理
        if (ideContainer.classList.contains('zen-mode-active')) {
            ideContainer.classList.remove('zen-mode-active');
            
            // ★修正: Escapeで解除した際、保存しておいた状態に右アクティビティバーを戻す
            isRightActivityBarVisible = savedRightActivityBarState; 
            
            // レイアウトを再計算させる
            updateTerminalVisibility(); 
        }
    }
});

// 設定タブ
if (btnSettings) {
    btnSettings.addEventListener('click', () => {
        let settingsTab = document.getElementById('tab-settings');

        if (!settingsTab) {
            settingsTab = document.createElement('div');
            settingsTab.className = 'tab';
            settingsTab.id = 'tab-settings';
            settingsTab.dataset.target = 'content-settings';
            settingsTab.innerHTML = '設定 <span class="close-tab" id="close-settings-tab">x</span>';

            if (editorTabsContainer) {
                editorTabsContainer.appendChild(settingsTab);
            }

            settingsTab.addEventListener('click', (e) => {
                if (e.target.id !== 'close-settings-tab') {
                    switchTab(settingsTab);
                }
            });

            document.getElementById('close-settings-tab').addEventListener('click', (e) => {
                e.stopPropagation();
                settingsTab.remove();
                if (contentSettings) contentSettings.classList.add('content-hidden');
                if (tabReadme) switchTab(tabReadme);
            });
        }

        switchTab(settingsTab);
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
        // 既存のスタイル変更ロジックは維持しつつ、実際の最大化を実行
        window.electronAPI.maximizeWindow();

        // isMaximized の状態管理やアイコン切替は main.js 側のイベントで行うのが正確ですが
        // 簡易的には既存のロジックのままでも動作します
        isMaximized = !isMaximized;

        // ★追加: アイコンの切り替え処理
        const iconMax = btnMaximize.querySelector('.icon-maximize');
        const iconRestore = btnMaximize.querySelector('.icon-restore');

        if (isMaximized) {
            // 最大化状態：元に戻すアイコンを表示
            if (iconMax) iconMax.classList.add('hidden');
            if (iconRestore) iconRestore.classList.remove('hidden');
            btnMaximize.title = "元に戻す";
        } else {
            // 通常状態：最大化アイコンを表示
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
const btnNewFile = document.getElementById('btn-new-file');
const btnNewFolder = document.getElementById('btn-new-folder');
const btnSortAsc = document.getElementById('btn-sort-asc');
const btnSortDesc = document.getElementById('btn-sort-desc');

// ソートボタン (昇順)
if (btnSortAsc) {
    btnSortAsc.addEventListener('click', () => {
        currentSortOrder = 'asc';
        // ルートから再読み込みしてソートを反映
        initializeFileTree();
    });
}

// ソートボタン (降順)
if (btnSortDesc) {
    btnSortDesc.addEventListener('click', () => {
        currentSortOrder = 'desc';
        // ルートから再読み込みしてソートを反映
        initializeFileTree();
    });
}

// ※ 新規ファイル・新規フォルダボタンのイベントリスナーは、
//    ファイル末尾の方で createNewFile / createNewFolder 関数として
//    正しく紐付けられているため、ここでは alert の処理を削除するだけでOKです。

// ========== Git用ボタン処理 ==========
const btnGitStage = document.getElementById('btn-git-stage');
const btnGitUnstage = document.getElementById('btn-git-unstage');
const btnGitRefresh = document.getElementById('btn-git-refresh');

if (btnGitStage) {
    btnGitStage.addEventListener('click', () => {
        alert('すべての変更をステージングしました。');
    });
}

if (btnGitUnstage) {
    btnGitUnstage.addEventListener('click', () => {
        alert('すべての変更をアンステージングしました。');
    });
}

if (btnGitRefresh) {
    btnGitRefresh.addEventListener('click', () => {
        alert('Gitの状態を更新しました。');
    });
}

// ========== アウトライン用ボタン処理 ==========
const btnOutlineCollapse = document.getElementById('btn-outline-collapse');
const btnOutlineExpand = document.getElementById('btn-outline-expand');

if (btnOutlineCollapse) {
    btnOutlineCollapse.addEventListener('click', () => {
        alert('すべての項目を折りたたみました。');
    });
}

if (btnOutlineExpand) {
    btnOutlineExpand.addEventListener('click', () => {
        alert('すべての項目を展開しました。');
    });
}

// ========== ツールバーボタン処理 ==========
const headingSelector = document.getElementById('heading-selector');
const btnBulletList = document.getElementById('btn-bullet-list');
const btnNumberList = document.getElementById('btn-number-list');
const btnAlignCenter = document.getElementById('btn-align-center');
const colorPicker = document.getElementById('color-picker');

if (headingSelector) {
    headingSelector.addEventListener('change', (e) => {
        const level = e.target.value;
        if (level) {
            document.execCommand('formatBlock', false, `<${level}>`);
        } else {
            document.execCommand('formatBlock', false, '<p>');
        }
    });
}

if (btnBulletList) {
    btnBulletList.addEventListener('click', () => {
        document.execCommand('insertUnorderedList', false, null);
    });
}

if (btnNumberList) {
    btnNumberList.addEventListener('click', () => {
        document.execCommand('insertOrderedList', false, null);
    });
}

if (btnAlignCenter) {
    btnAlignCenter.addEventListener('click', () => {
        document.execCommand('justifyCenter', false, null);
    });
}

if (colorPicker) {
    colorPicker.addEventListener('change', (e) => {
        document.execCommand('foreColor', false, e.target.value);
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
        }
    }

    if (isResizingBottom && resizerBottom) {
        const newHeight = window.innerHeight - e.clientY - 24;

        if (newHeight > 50 && newHeight < window.innerHeight - 200) {
            bottomPane.style.height = newHeight + 'px';
            resizerBottom.style.top = (window.innerHeight - newHeight - 24) + 'px';
        }
    }
});

document.addEventListener('mouseup', () => {
    if (isResizingRight) {
        isResizingRight = false;
        if (resizerRight) resizerRight.classList.remove('resizing');
    }
    if (isResizingBottom) {
        isResizingBottom = false;
        if (resizerBottom) resizerBottom.classList.remove('resizing');
    }
});

if (resizerBottom) {
    resizerBottom.addEventListener('mousedown', () => {
        isResizingBottom = true;
        if (resizerBottom) resizerBottom.classList.add('resizing');
    });
}

// ファイルの統計情報を更新する関数
function updateFileStats(content) {
    if (!fileStatsElement) return;

    const text = content || editor.value || '';
    
    // 1. 文字数を計算
    const charCount = text.length;
    
    // 2. 行数を計算 (最後の空行は含まない)
    const lineCount = text.split('\n').length;

    fileStatsElement.textContent = `文字数: ${charCount} | 行数: ${lineCount}`;
}

// ========== 初期化 ==========
updateTerminalVisibility();
if (document.querySelector('.side-switch.active')) {
    switchHeaderButtons(document.querySelector('.side-switch.active').dataset.target);
}

// ========== タブ管理：イベント委譲 ==========
// タブコンテナに委譲リスナーを追加
if (editorTabsContainer) {
    editorTabsContainer.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('.close-tab');
        const tabElement = e.target.closest('.tab');

        if (closeBtn && tabElement) {
            // クローズボタンクリック
            e.stopPropagation();
            const filePath = closeBtn.dataset.filepath;
            if (filePath) {
                closeFile(filePath, tabElement);
            } else if (tabElement.id === 'tab-settings') {
                // 設定タブを閉じる場合の処理も追加しておくと親切
                tabElement.remove();
                const contentSettings = document.getElementById('content-settings');
                if (contentSettings) contentSettings.classList.add('content-hidden');
                // 別のタブがあれば開く
                const firstTab = document.querySelector('.editor-tabs .tab');
                if (firstTab) firstTab.click();
            }
        } else if (tabElement && !e.target.classList.contains('close-tab')) {
            // タブクリックで切り替え
            const filePath = tabElement.dataset.filepath;

            if (filePath) {
                // 通常のファイルタブの場合
                switchToFile(filePath);
            } else if (tabElement.dataset.target) {
                // ★追加: README.md や設定タブなど、target属性を持つタブの場合
                switchTab(tabElement);
            }
        }
    });
}
// ========== ページ初期化 ==========
// ページ読み込み後の初期化
window.addEventListener('load', () => {
    console.log('Markdown IDE loaded');

    // エディタにフォーカス
    if (editor) {
        editor.focus();
    }

    // ★変更: 専用関数で README を表示
    showWelcomeReadme();

    // ファイルツリーを初期化
    initializeFileTree();
});

// ========== ファイルシステム操作 ==========
let currentFilePath = null;
let currentDirectoryPath = null;
let openedFiles = new Map(); // 開いているファイルのタブと内容を管理
let fileModificationState = new Map(); // ファイル修正状態を追跡
let treeEventsAttached = false; // イベント重複防止フラグ

// ファイルツリーの初期化とイベント設定 (イベント委譲版)
async function initializeFileTree() {
    try {
        if (typeof window.electronAPI?.getCurrentDirectory === 'function') {
            currentDirectoryPath = await window.electronAPI.getCurrentDirectory();
        } else {
            currentDirectoryPath = '.';
        }

        const fileTree = document.querySelector('.file-tree');
        if (!fileTree) return;

        // ★重要: 既存のクローン要素があれば削除してリセット（イベント多重登録防止）
        const newFileTree = fileTree.cloneNode(true);
        fileTree.parentNode.replaceChild(newFileTree, fileTree);

        // ここからは newFileTree (新しいDOM) を操作
        const rootItem = newFileTree.querySelector('.tree-item.expanded');

        if (rootItem) {
            rootItem.dataset.path = currentDirectoryPath;
            const rootLabel = rootItem.querySelector('.tree-label');
            if (rootLabel) {
                const folderName = currentDirectoryPath.split(/[/\\]/).pop() || currentDirectoryPath;
                rootLabel.textContent = folderName;
            }
            // 初回読み込み時は、現在のDOM構造に対して読み込み処理を行うため
            // loadDirectoryTree は使わず、直接ヘルパーを呼ぶか、
            // ここではシンプルに中身をクリアして再読み込みする形をとります
            const rootChildren = rootItem.nextElementSibling;
            if (rootChildren) rootChildren.innerHTML = ''; // クリア
            await loadDirectoryTreeContents(rootItem, currentDirectoryPath); // 下記で定義する新関数
        }

        // ========== イベント委譲 (Event Delegation) 設定 ==========
        // ツリー全体に1つのイベントリスナーを設定し、クリックされた要素を判定する

        // 1. クリック (選択 & フォルダ開閉)
        newFileTree.addEventListener('click', (e) => {
            const item = e.target.closest('.tree-item');
            if (!item) return;

            // 入力モード中は無視
            if (item.classList.contains('creation-mode')) return;

            e.stopPropagation();

            // 選択状態の更新 (全体から削除して、クリックしたものだけに追加)
            newFileTree.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');

            // フォルダなら開閉
            if (!item.classList.contains('file')) {
                toggleFolder(item);
            }
        });

        // 2. ダブルクリック (ファイルを開く)
        newFileTree.addEventListener('dblclick', (e) => {
            const item = e.target.closest('.tree-item');
            if (!item || !item.classList.contains('file')) return;

            if (item.classList.contains('creation-mode')) return;

            e.stopPropagation();
            openFile(item.dataset.path, item.dataset.name);
        });

        // 3. 右クリック (コンテキストメニュー)
        newFileTree.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.tree-item');
            if (!item) return;

            if (item.classList.contains('creation-mode')) return;

            e.preventDefault();
            e.stopPropagation();

            // 右クリックでも選択状態にする
            newFileTree.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');

            showContextMenu(e.pageX, e.pageY, item.dataset.path, item.dataset.name);
        });

    } catch (error) {
        console.error('Failed to initialize file tree:', error);
    }
}

// ★追加: loadDirectoryTreeのロジックを分離したヘルパー関数
// (loadDirectoryTree関数自体もこれを使うように修正が必要です)
async function loadDirectoryTreeContents(folderElement, dirPath) {
    let childrenContainer = folderElement.nextElementSibling;
    if (!childrenContainer || !childrenContainer.classList.contains('tree-children')) {
        childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        folderElement.parentNode.insertBefore(childrenContainer, folderElement.nextSibling);
    }

    childrenContainer.innerHTML = ''; // クリア

    const items = await getSortedDirectoryContents(dirPath);
    if (items && items.length > 0) {
        items.forEach(item => {
            const element = createTreeElement(item, dirPath);
            childrenContainer.appendChild(element);
        });
    }
    // ★ポイント: ここで attachTreeEventListeners を呼ばない
    // (イベントは親の .file-tree で一括管理しているため)
}

// 修正後の loadDirectoryTree
async function loadDirectoryTree(dirPath) {
    // DOMから該当するフォルダ要素を探すのは困難なため、
    // 基本的に initializeFileTree か toggleFolder から呼ばれるロジックにします。
    // ここでは互換性のために残しますが、中身はシンプルに。
    const rootItem = document.querySelector('.tree-item.expanded');
    if (rootItem && rootItem.dataset.path === dirPath) {
        await loadDirectoryTreeContents(rootItem, dirPath);
    }
}

// 修正後の toggleFolder
async function toggleFolder(folderElement) {
    const toggle = folderElement.querySelector('.tree-toggle');
    if (!toggle) return; // ファイル等の場合

    const folderPath = folderElement.dataset.path;
    const isExpanded = toggle.textContent === '▼' || toggle.style.transform === 'rotate(90deg)'; // CSS回転対応

    if (isExpanded) {
        // 折りたたみ
        toggle.textContent = '▶';
        toggle.style.transform = ''; // 回転リセット
        const childrenContainer = folderElement.nextElementSibling;
        if (childrenContainer && childrenContainer.classList.contains('tree-children')) {
            childrenContainer.style.display = 'none';
        }
    } else {
        // 展開
        toggle.textContent = '▼';
        toggle.style.transform = 'rotate(90deg)'; // CSS回転

        let childrenContainer = folderElement.nextElementSibling;
        if (!childrenContainer || !childrenContainer.classList.contains('tree-children')) {
            childrenContainer = document.createElement('div');
            childrenContainer.className = 'tree-children';
            folderElement.parentNode.insertBefore(childrenContainer, folderElement.nextSibling);
        }

        childrenContainer.style.display = 'block';

        // 中身が空（または未ロード）なら読み込む
        if (childrenContainer.children.length === 0) {
            await loadDirectoryTreeContents(folderElement, folderPath);
        }
    }
}

// 修正後の reloadContainer
async function reloadContainer(container, path) {
    container.innerHTML = '';
    const items = await getSortedDirectoryContents(path);
    items.forEach(item => {
        const element = createTreeElement(item, path);
        container.appendChild(element);
    });
}

// ========== ソート設定とヘルパー ==========
let currentSortOrder = 'asc'; // 'asc' (昇順) または 'desc' (降順)

// ディレクトリの中身を取得してソートする関数
async function getSortedDirectoryContents(dirPath) {
    // IPC経由でファイル一覧を取得
    let items = await readDirectory(dirPath);

    // ソート実行
    return items.sort((a, b) => {
        // 1. フォルダを常に先頭にする
        if (a.isDirectory !== b.isDirectory) {
            return b.isDirectory ? 1 : -1;
        }

        // 2. 名前で比較
        const comparison = a.name.localeCompare(b.name);

        // 昇順ならそのまま、降順なら反転
        return currentSortOrder === 'asc' ? comparison : -comparison;
    });
}

// ディレクトリを読み込む（IPC経由）
async function readDirectory(dirPath) {
    try {
        if (typeof window.electronAPI?.readDirectory === 'function') {
            return await window.electronAPI.readDirectory(dirPath);
        } else {
            console.warn('readDirectory API not available');
            return [];
        }
    } catch (error) {
        console.error('Failed to read directory:', error);
        return [];
    }
}

// ========== アイコン定義とツリー要素作成 ==========

// 拡張子に応じたアイコンと色を取得する関数 (VS Codeライクな定義)
function getFileIconData(filename) {
    const ext = filename.split('.').pop().toLowerCase();

    // 定義マップ: { text: 表示文字, color: 色 }
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

    // デフォルトのファイルアイコン
    return iconMap[ext] || { text: '📄', color: '#90a4ae' };
}

// ツリー要素を動的に作成 (アイコン位置修正版)
function createTreeElement(item, parentPath) {
    const itemPath = `${parentPath}/${item.name}`;
    const container = document.createElement('div');
    container.className = 'tree-item' + (item.isDirectory ? '' : ' file');
    container.dataset.path = itemPath;
    container.dataset.name = item.name;

    // ★修正: フォルダの場合のみトングル(▼)を作成
    // ファイルの場合は作成しないことで、アイコンが左端(▼の位置)に来ます
    if (item.isDirectory) {
        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle';
        toggle.textContent = '▶';
        container.appendChild(toggle);
    }

    // アイコン作成
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

// フォルダを展開/折りたたみ
async function toggleFolder(folderElement) {
    const toggle = folderElement.querySelector('.tree-toggle');
    const folderPath = folderElement.dataset.path;
    const isExpanded = toggle.textContent === '▼';

    if (isExpanded) {
        // 折りたたみ
        toggle.textContent = '▶';
        const childrenContainer = folderElement.nextElementSibling;
        if (childrenContainer && childrenContainer.classList.contains('tree-children')) {
            childrenContainer.style.display = 'none';
        }
    } else {
        // 展開
        toggle.textContent = '▼';
        let childrenContainer = folderElement.nextElementSibling;

        if (!childrenContainer || !childrenContainer.classList.contains('tree-children')) {
            childrenContainer = document.createElement('div');
            childrenContainer.className = 'tree-children';
            folderElement.parentNode.insertBefore(childrenContainer, folderElement.nextSibling);
        }

        // 既に読み込み済みならスキップ
        if (childrenContainer.children.length === 0) {
            try {
                const items = await readDirectory(folderPath);
                items.forEach(item => {
                    const element = createTreeElement(item, folderPath);
                    childrenContainer.appendChild(element);
                });
            } catch (error) {
                console.error('Failed to load folder contents:', error);
            }
        }

        childrenContainer.style.display = 'block';
    }
}

// ファイルを開く
async function openFile(filePath, fileName) {
    try {
        // ★追加: ファイルを開く際、README.md が開いていたら閉じる
        if (openedFiles.has('README.md')) {
            closeWelcomeReadme();
        }

        currentFilePath = filePath;

        // ファイル内容を読み込む
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

        // 既存のタブをチェック
        let tab = document.querySelector(`[data-filepath="${CSS.escape(filePath)}"]`);
        if (!tab) {
            // 新しいタブを作成
            tab = document.createElement('div');
            tab.className = 'tab active';
            tab.dataset.filepath = filePath;
            tab.innerHTML = `${fileName} <span class="close-tab" data-filepath="${filePath}">×</span>`;

            editorTabsContainer.appendChild(tab);

            // ファイル内容をメモリに保存
            openedFiles.set(filePath, { content: fileContent, fileName: fileName });
        } else {
            // 既存のタブをアクティブにする
            document.querySelectorAll('.editor-tabs .tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
        }

        // エディタの内容を更新
        switchToFile(filePath);
    } catch (error) {
        console.error('Failed to open file:', error);
        alert(`ファイルを開けませんでした: ${error.message}`);
    }
}

// ★追加: ウェルカムページ（README.md）を表示する関数
function showWelcomeReadme() {
    const readmePath = 'README.md';

    // 既に開いていれば何もしない（念のため）
    if (openedFiles.has(readmePath)) return;

    const initialMarkdown = `# マークダウン記法の使い方

Markdown（マークダウン）は、手軽に文章の構造や装飾を書くための記法です。
左側に書くと、右側にプレビューが表示されます。

## 見出し
# H1 見出し
## H2 見出し
### H3 見出し

## テキストの装飾
**太字** や *斜体* 、~~取り消し線~~ が使えます。

## リスト
- リスト項目1
- リスト項目2
  - ネストされた項目

1. 番号付きリスト
2. 番号付きリスト

## コード
インラインの \`code\` や、コードブロックが書けます：

\`\`\`javascript
console.log('Hello, Markdown!');
const x = 10;
\`\`\`

## 引用
> これは引用文です。
> 複数行書くこともできます。

## リンクと画像
[Googleへのリンク](https://google.com)
![画像の説明](https://via.placeholder.com/150)

## テーブル
| 左揃え | 中央揃え | 右揃え |
| :--- | :---: | ---: |
| 項目1 | 項目2 | 項目3 |
| text | text | text |

## 水平線
---
`;

    // メモリに登録
    openedFiles.set(readmePath, {
        content: initialMarkdown,
        fileName: 'README.md'
    });

    // タブを作成（×ボタン無し）
    const tab = document.createElement('div');
    tab.className = 'tab'; // activeはswitchToFileで付く
    tab.dataset.filepath = readmePath;
    // ★ポイント: 閉じるボタン（<span class="close-tab">）を含めない
    tab.innerHTML = `README.md`;

    if (editorTabsContainer) {
        editorTabsContainer.appendChild(tab);
    }

    // 表示切り替え
    switchToFile(readmePath);
}

// ★追加: ウェルカムページを閉じる関数
function closeWelcomeReadme() {
    const readmePath = 'README.md';
    const readmeTab = document.querySelector(`[data-filepath="${readmePath}"]`);

    if (readmeTab) {
        readmeTab.remove();
        openedFiles.delete(readmePath);
        fileModificationState.delete(readmePath);
    }
}

// ファイルを切り替える
function switchToFile(filePath) {

    // ★追加: 確実にエディタ画面を表示し、設定画面などを隠す
    const editorArea = document.getElementById('content-readme');
    const settingsArea = document.getElementById('content-settings');

    if (editorArea) editorArea.classList.remove('content-hidden');
    if (settingsArea) settingsArea.classList.add('content-hidden');

    currentFilePath = filePath;

    // メモリから内容を取得
    const fileData = openedFiles.get(filePath);
    const fileContent = fileData ? fileData.content : '';

    // textarea の場合
    editor.value = fileContent;

    // アクティブなタブを更新
    document.querySelectorAll('.editor-tabs .tab').forEach(t => {
        if (t.dataset.filepath === filePath) {
            t.classList.add('active');
        } else {
            t.classList.remove('active');
        }
    });

    // リアルタイム Markdown レンダリング
    renderMarkdownLive();

    // PDFプレビューを更新
    if (isPdfPreviewVisible) {
        generatePdfPreview();
    }

    // タイトルを更新
    if (fileData) {
        document.title = `${fileData.fileName} - Markdown IDE`;
    }

    // ★追加: ファイル統計情報の更新
    updateFileStats();

}

// ファイルを閉じる
function closeFile(filePath, tabElement) {
    try {
        // ★追加: README.md はここからは閉じられないようにガード（念のため）
        if (filePath === 'README.md') return;

        // タブ要素を削除
        if (tabElement && tabElement.parentNode) {
            tabElement.remove();
        }

        openedFiles.delete(filePath);
        fileModificationState.delete(filePath);

        // 現在開いているファイルを閉じた場合の処理
        if (currentFilePath === filePath) {
            currentFilePath = null;
            editor.value = '';

            // プレビューをクリア
            const previewPane = document.getElementById('preview');
            if (previewPane) {
                previewPane.innerHTML = '';
            }

            // 別のタブがあればそれをアクティブにする
            const remainingTabs = document.querySelectorAll('.editor-tabs .tab');
            if (remainingTabs.length > 0) {
                const nextTab = remainingTabs[remainingTabs.length - 1];
                if (nextTab.dataset.filepath) {
                    switchToFile(nextTab.dataset.filepath);
                }
            } else {
                // ★追加: タブが空になったら README.md を表示
                showWelcomeReadme();
            }
        }
    } catch (error) {
        console.error('Error closing file:', error);
    }
}

// ファイルを保存
async function saveCurrentFile() {
    if (!currentFilePath) {
        alert('ファイルを選択してください');
        return;
    }

    // ★追加: README.md は保存不可にする
    if (currentFilePath === 'README.md') {
        // 何もせずリターン（エラーメッセージを出しても良いですが、編集可能・保存不可という仕様ならスルーでOK）
        return;
    }

    try {
        // textarea の場合
        const content = editor.value || '';

        if (typeof window.electronAPI?.saveFile === 'function') {
            await window.electronAPI.saveFile(currentFilePath, content);

            // メモリ内の内容を更新
            const fileData = openedFiles.get(currentFilePath);
            if (fileData) {
                fileData.content = content;
            }

            // 修正状態をクリア
            fileModificationState.delete(currentFilePath);

            // タブから修正マークを削除（シンプルに再作成）
            const tab = document.querySelector(`[data-filepath="${CSS.escape(currentFilePath)}"]`);
            if (tab) {
                const fileName = currentFilePath.split(/[\/\\]/).pop();
                // タブを完全に再構築（安全）
                tab.innerHTML = `${fileName} <span class="close-tab" data-filepath="${currentFilePath}">×</span>`;
            }

            console.log(`✅ ファイルを保存しました: ${currentFilePath}`);
        } else {
            alert('ファイルシステムにアクセスできません');
        }
    } catch (error) {
        console.error('Failed to save file:', error);
        alert(`保存に失敗しました: ${error.message}`);
    }
}

// ========== 新規作成機能 (VS Code風インライン入力) ==========

// 入力ボックスを表示して作成処理を行う共通関数 (修正版)
async function showCreationInput(isFolder) {
    const fileTree = document.querySelector('.file-tree');
    let targetContainer = null;
    let targetPath = currentDirectoryPath;

    // 1. 挿入位置を決定
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

    if (!targetContainer) {
        alert('作成場所を特定できませんでした。');
        return;
    }

    // 2. 入力用要素を作成
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

    // リストの先頭に挿入
    if (targetContainer.firstChild) {
        targetContainer.insertBefore(inputDiv, targetContainer.firstChild);
    } else {
        targetContainer.appendChild(inputDiv);
    }

    inputField.focus();

    // ★修正ポイント: 処理中フラグと安全な削除関数を追加
    let isCreating = false;

    const safeRemove = () => {
        // 親が存在する場合のみ削除を実行（エラー回避）
        if (inputDiv && inputDiv.parentNode) {
            inputDiv.remove();
        }
    };

    // 3. 確定処理
    const finishCreation = async () => {
        if (isCreating) return; // 二重実行防止
        isCreating = true;      // フラグを立てる

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

            // 成功時
            safeRemove();
            await reloadContainer(targetContainer, targetPath);

            if (!isFolder) {
                openFile(newPath, name);
            }

        } catch (e) {
            console.error(e);
            alert('作成に失敗しました: ' + e.message);
            safeRemove();
        } finally {
            isCreating = false; // フラグ解除
        }
    };

    // イベントリスナー
    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            finishCreation();
        } else if (e.key === 'Escape') {
            if (!isCreating) safeRemove();
        }
    });

    inputField.addEventListener('blur', () => {
        // 処理中（API実行中やアラート表示中）は勝手に消さない
        if (!isCreating) {
            safeRemove();
        }
    });
}

// 既存の関数を置き換え
async function createNewFile() {
    showCreationInput(false); // ファイル作成モード
}

async function createNewFolder() {
    showCreationInput(true);  // フォルダ作成モード
}

// フォルダを開く
async function openFolder() {
    try {
        if (typeof window.electronAPI?.selectFolder !== 'function') {
            alert('フォルダ選択APIが利用できません');
            return;
        }

        const result = await window.electronAPI.selectFolder();

        if (result.success && result.path) {
            console.log(`フォルダを選択しました: ${result.path}`);

            // ★修正: 手動で更新するのではなく、初期化関数を呼ぶだけでOK
            // (メインプロセス側でパスは更新済みなので、initializeFileTreeが正しいパスを取得して再描画してくれます)
            await initializeFileTree();
        }
    } catch (error) {
        console.error('Failed to open folder:', error);
        alert(`フォルダを開くのに失敗しました: ${error.message}`);
    }
}

// ファイルエクスプローラーボタンのイベントを更新
const btnOpenFolder = document.getElementById('btn-open-folder');
if (btnOpenFolder) {
    btnOpenFolder.addEventListener('click', openFolder);
}

if (btnNewFile) {
    btnNewFile.addEventListener('click', createNewFile);
}

if (btnNewFolder) {
    btnNewFolder.addEventListener('click', createNewFolder);
}

// ショートカットキー設定
document.addEventListener('keydown', (e) => {
    // 保存 (Ctrl+S)
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveCurrentFile();
    }

    // タブを閉じる (Ctrl+W)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const activeTab = document.querySelector('.editor-tabs .tab.active');
        if (activeTab) {
            // 設定タブの場合
            if (activeTab.id === 'tab-settings') {
                const closeBtn = document.getElementById('close-settings-tab');
                if (closeBtn) closeBtn.click();
            }
            // 通常のファイルタブの場合
            else if (activeTab.dataset.filepath) {
                // ★追加: README.md なら閉じない
                if (activeTab.dataset.filepath === 'README.md') {
                    return;
                }
                closeFile(activeTab.dataset.filepath, activeTab);
            }
        }
    }
    // タブ移動 (Ctrl+Tab: 次へ, Ctrl+Shift+Tab: 前へ)
    if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        e.preventDefault(); // フォーカス移動などを防ぐ

        // 現在表示されているすべてのタブを取得
        const tabs = Array.from(document.querySelectorAll('.editor-tabs .tab'));
        if (tabs.length <= 1) return; // タブが1つ以下の場合は何もしない

        // 現在のアクティブなタブのインデックスを探す
        const activeIndex = tabs.findIndex(tab => tab.classList.contains('active'));
        if (activeIndex === -1) return;

        let nextIndex;
        if (e.shiftKey) {
            // 前へ (Ctrl+Shift+Tab) - ループするように計算
            nextIndex = (activeIndex - 1 + tabs.length) % tabs.length;
        } else {
            // 次へ (Ctrl+Tab) - ループするように計算
            nextIndex = (activeIndex + 1) % tabs.length;
        }

        // 対象のタブをクリックして切り替え処理を実行
        // (clickイベントを発火させることで、既存のswitchToFile/switchTabロジックを再利用)
        tabs[nextIndex].click();
    }

    // ★追加: Deleteキーで選択中のアイテムを削除
    if (e.key === 'Delete') {
        // 入力フォーム(input/textarea)にフォーカスがある場合は何もしない（文字削除を優先）
        const activeTag = document.activeElement.tagName.toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea') return;

        const selectedItem = document.querySelector('.file-tree .tree-item.selected');
        if (selectedItem) {
            // creation-mode（新規作成中）の要素は対象外
            if (selectedItem.classList.contains('creation-mode')) return;

            const path = selectedItem.dataset.path;
            const name = selectedItem.dataset.name;
            if (path && name) {
                confirmAndDelete(path, name);
            }
        }
    }

});

// エディタ変更時の追跡と リアルタイム Markdown レンダリング
if (editor) {
    editor.addEventListener('input', () => {
        if (currentFilePath) {
            fileModificationState.set(currentFilePath, true);
            // オプション: タブに修正フラグを表示（イベント委譲で処理）
            const tab = document.querySelector(`[data-filepath="${CSS.escape(currentFilePath)}"]`);
            if (tab) {
                const currentHTML = tab.innerHTML;
                // 既に修正マークがなければ追加
                if (!currentHTML.includes('●')) {
                    const closeBtnIndex = currentHTML.lastIndexOf('<span class="close-tab"');
                    if (closeBtnIndex > -1) {
                        // 修正マークをクローズボタンの前に挿入
                        const beforeClose = currentHTML.substring(0, closeBtnIndex).trim();
                        const closeBtn = currentHTML.substring(closeBtnIndex);
                        tab.innerHTML = `${beforeClose} ● ${closeBtn}`;
                    }
                }
            }
        }

        // リアルタイム Markdown レンダリング
        renderMarkdownLive();

        // リアルタイム PDF プレビュー更新
        if (isPdfPreviewVisible) {
            // デバウンスしてパフォーマンスを向上
            if (window.pdfUpdateTimeout) {
                clearTimeout(window.pdfUpdateTimeout);
            }
            window.pdfUpdateTimeout = setTimeout(() => {
                generatePdfPreview();
            }, 1000); // 1秒後に更新
        }
        // ★追加: ファイル統計情報の更新
        updateFileStats();
    });
}

// リアルタイム Markdown レンダリング
function renderMarkdownLive() {
    const plainText = editor.value || '';
    const previewPane = document.getElementById('preview');

    if (!previewPane) {
        console.warn('Preview pane not found');
        return;
    }

    // marked.js が利用可能か確認
    if (typeof marked === 'undefined') {
        console.warn('marked.js is not loaded');
        previewPane.innerHTML = '<p>Markdownプレビューが利用できません。</p>';
        return;
    }

    try {
        // marked の デフォルト設定
        if (typeof marked.setOptions === 'function') {
            marked.setOptions({
                breaks: true,
                gfm: true
            });
        }

        // Markdown を HTML に変換
        const htmlContent = marked.parse(plainText);

        // プレビューペインに HTML をセット
        previewPane.innerHTML = htmlContent;

        // Prism.js でシンタックスハイライト
        if (typeof Prism !== 'undefined') {
            Prism.highlightAllUnder(previewPane);
        }
    } catch (error) {
        console.error('Error rendering Markdown:', error);
        previewPane.innerHTML = `<p style="color: red;">エラー: ${error.message}</p>`;
    }
}

// Markdown を表示用に処理（HTML タグのエスケープとシンタックスハイライト準備）
function processMarkdownForDisplay(markdownText) {
    let html = marked.parse(markdownText);

    // Prism.js でシンタックスハイライト
    if (typeof Prism !== 'undefined') {
        html = html.replace(/<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g, (match, lang, code) => {
            try {
                const highlighted = Prism.highlight(code, Prism.languages[lang] || Prism.languages.plaintext, lang);
                return `<pre><code class="language-${lang}">${highlighted}</code></pre>`;
            } catch (e) {
                return match;
            }
        });
    }

    return html;
}

// ========== コンテキストメニューと削除機能 ==========

// 削除の確認と実行
async function confirmAndDelete(path, name) {
    if (!confirm(`「${name}」を本当に削除しますか？\n（フォルダの場合は中身も削除されます）`)) {
        return;
    }

    try {
        if (typeof window.electronAPI?.deleteFile === 'function') {
            await window.electronAPI.deleteFile(path);

            // 削除されたアイテムの親フォルダを探して再読み込み
            // DOMから削除対象を探す
            const deletedItem = document.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`);
            if (deletedItem) {
                const parentContainer = deletedItem.parentElement;
                // 親が .tree-children なら、その前の要素が親フォルダ
                if (parentContainer && parentContainer.classList.contains('tree-children')) {
                    const parentFolder = parentContainer.previousElementSibling;
                    if (parentFolder && parentFolder.dataset.path) {
                        // 親フォルダを再読み込み
                        await reloadContainer(parentContainer, parentFolder.dataset.path);
                    } else {
                        // ルート直下だった場合は全体を初期化
                        initializeFileTree();
                    }
                } else {
                    initializeFileTree();
                }
            }
        }
    } catch (error) {
        console.error('Delete failed:', error);
        alert('削除に失敗しました: ' + error.message);
    }
}

// コンテキストメニューを表示
let activeContextMenu = null;

function showContextMenu(x, y, path, name) {
    // 既存のメニューがあれば消す
    if (activeContextMenu) activeContextMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    // 削除ボタン
    const deleteOption = document.createElement('div');
    deleteOption.className = 'context-menu-item';
    deleteOption.textContent = '削除';
    deleteOption.addEventListener('click', () => {
        confirmAndDelete(path, name);
        menu.remove();
        activeContextMenu = null;
    });

    menu.appendChild(deleteOption);
    document.body.appendChild(menu);
    activeContextMenu = menu;
}

// 別の場所をクリックしたらメニューを閉じる
document.addEventListener('click', () => {
    if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
    }
});