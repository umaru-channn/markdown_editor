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

        // 他のコンテンツを隠す
        leftPaneContents.forEach(content => content.classList.add('content-hidden'));

        // ファイルツリーの表示制御
        const fileTree = document.querySelector('.file-tree');
        if (fileTree) {
            if (targetId === 'files') {
                fileTree.classList.remove('content-hidden');
            } else {
                fileTree.classList.add('content-hidden');
            }
        }

        // GitやOutlineの場合はそれぞれのコンテンツを表示
        const targetContent = document.getElementById('content-' + targetId);
        if (targetContent) {
            targetContent.classList.remove('content-hidden');
            // アウトラインの場合、表示時に最新化
            if (targetId === 'outline') {
                updateOutline();
                syncOutlineWithCursor(); // 表示時に即座に同期
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

        // Render HTML to PDF using Electron's API or fallback
        if (typeof window.electronAPI?.generatePdf === 'function') {
            // Use Electron API
            await renderHtmlToPdf(htmlContent);
        } else {
            // Fallback for browser environment (just render HTML in preview container basically)
            console.warn('PDF generation API not available, using fallback');
            // 簡易プレビュー用の仮要素を作成して描画
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = htmlContent;
            await createCanvasBasedPreview(tempDiv);
        }
    } catch (error) {
        console.error('Failed to generate PDF preview:', error);
    }
}

// Render HTML content to PDF (implementation wrapper)
async function renderHtmlToPdf(htmlContent) {
    try {
        // Electron API call
        const pdfData = await window.electronAPI.generatePdf(htmlContent);
        if (pdfData) {
            await displayPdfFromData(pdfData);
        }
    } catch (error) {
        console.error('Error rendering HTML to PDF:', error);
        // エラー時はフォールバック
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlContent;
        await createCanvasBasedPreview(tempDiv);
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

// Render page to container
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
const btnNewFile = document.getElementById('btn-new-file');
const btnNewFolder = document.getElementById('btn-new-folder');
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

// ========== Git用ボタン処理 ==========
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

// アウトライン更新関数
function updateOutline() {
    if (!outlineTree || !editor) return;

    const content = editor.value;
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
        
        // data-level属性を追加して、折りたたみ制御に使用
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
            
            // アクティブ状態の更新（手動クリック時）
            items.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
        });
    });
}

// カーソル位置に連動してアウトラインをハイライトする関数
function syncOutlineWithCursor() {
    if (!editor || !outlineTree) return;
    
    // アウトラインが表示されていない場合は処理しない
    const outlineContent = document.getElementById('content-outline');
    if (!outlineContent || outlineContent.classList.contains('content-hidden')) return;

    // カーソル位置（文字インデックス）を取得
    const cursorPos = editor.selectionStart;
    const content = editor.value;
    
    // カーソル位置までの行数を計算
    const textBeforeCursor = content.substring(0, cursorPos);
    const currentLine = textBeforeCursor.split('\n').length - 1;

    // 現在行またはそれより前にある最後の見出しを探す
    const items = Array.from(outlineTree.querySelectorAll('.outline-item'));
    let activeItem = null;

    for (let i = 0; i < items.length; i++) {
        const itemLine = parseInt(items[i].dataset.line);
        // 現在行より後ろの見出しが出てきたら、その一つ前が対象
        if (itemLine > currentLine) {
            break;
        }
        activeItem = items[i];
    }

    // ハイライト更新
    items.forEach(i => i.classList.remove('active'));
    if (activeItem) {
        activeItem.classList.add('active');
        // 必要に応じてアウトラインをスクロール（アイテムが見えるように）
        // activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); 
        // ↑頻繁に動くと見づらい場合があるので一旦コメントアウト、必要なら有効化
    }
}

// 指定行へスクロールし、カーソルを移動する関数 (改良版: 正確な位置計算)
function scrollToLine(lineNumber) {
    if (!editor) return;

    const lines = editor.value.split('\n');
    let charIndex = 0;
    // 行番号が範囲外でないかチェック
    if (lineNumber >= lines.length) lineNumber = lines.length - 1;
    
    for (let i = 0; i < lineNumber; i++) {
        charIndex += lines[i].length + 1; // +1 for newline
    }

    editor.focus();
    // カーソル位置をセット
    editor.setSelectionRange(charIndex, charIndex);
    
    // --- 正確なスクロール位置の計算 (ダミー要素を使用) ---
    const div = document.createElement('div');
    const style = window.getComputedStyle(editor);
    
    // エディタと同じスタイルをコピーして、テキストの折り返し状態を再現する
    const copyStyles = [
        'font-family', 'font-size', 'font-weight', 'line-height', 
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'border-width', 'box-sizing', 'width', 'white-space', 'word-wrap', 'word-break'
    ];
    
    copyStyles.forEach(prop => {
        div.style[prop] = style.getPropertyValue(prop);
    });

    // 画面外に配置
    div.style.position = 'absolute';
    div.style.visibility = 'hidden';
    div.style.top = '-9999px';
    div.style.left = '-9999px';
    // エディタの実際の幅をセット
    div.style.width = editor.clientWidth + 'px'; 

    // カーソル位置までのテキストをセット
    // 末尾が改行だと高さが反映されないことがあるので、ゼロ幅スペースなどを足す等の工夫が必要だが、
    // 今回は見出し行（文字がある）へのジャンプなので、その行のテキストまでを含める。
    div.textContent = editor.value.substring(0, charIndex);
    
    // マーカー要素を追加して、その位置を取得する
    const span = document.createElement('span');
    span.textContent = 'I'; // 高さ確保用
    div.appendChild(span);

    document.body.appendChild(div);
    
    // スクロール位置を計算 (マーカーの位置 - エディタの高さの半分 = 画面中央)
    const targetTop = span.offsetTop;
    const editorHeight = editor.clientHeight;
    
    document.body.removeChild(div);
    
    // スムーズにスクロール
    editor.scrollTo({
        top: Math.max(0, targetTop - (editorHeight / 3)), // 中央より少し上に見出しが来るように /3 くらいが見やすい
        behavior: 'smooth'
    });
}

// 折りたたみボタン（マイナス）：H1以外を隠す
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

// 展開ボタン（プラス）：すべて表示
if (btnOutlineExpand) {
    btnOutlineExpand.addEventListener('click', () => {
        const items = outlineTree.querySelectorAll('.outline-item');
        items.forEach(item => {
            item.classList.remove('hidden-outline-item');
        });
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
    const charCount = text.length;
    const lineCount = text.split('\n').length;

    fileStatsElement.textContent = `文字数: ${charCount} | 行数: ${lineCount}`;
}

// ========== 初期化 ==========
updateTerminalVisibility();
if (document.querySelector('.side-switch.active')) {
    switchHeaderButtons(document.querySelector('.side-switch.active').dataset.target);
}

// ========== タブ管理：イベント委譲 ==========
if (editorTabsContainer) {
    editorTabsContainer.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('.close-tab');
        const tabElement = e.target.closest('.tab');

        if (closeBtn && tabElement) {
            e.stopPropagation();
            const filePath = closeBtn.dataset.filepath;
            if (filePath) {
                closeFile(filePath, tabElement);
            } else if (tabElement.id === 'tab-settings') {
                tabElement.remove();
                const contentSettings = document.getElementById('content-settings');
                if (contentSettings) contentSettings.classList.add('content-hidden');
                const firstTab = document.querySelector('.editor-tabs .tab');
                if (firstTab) firstTab.click();
            }
        } else if (tabElement && !e.target.classList.contains('close-tab')) {
            const filePath = tabElement.dataset.filepath;

            if (filePath) {
                switchToFile(filePath);
            } else if (tabElement.dataset.target) {
                switchTab(tabElement);
            }
        }
    });
}

// ========== ページ初期化 ==========
window.addEventListener('load', () => {
    console.log('Markdown IDE loaded');
    if (editor) {
        editor.focus();
    }
    showWelcomeReadme();
    initializeFileTree();
    updateOutline(); // 初期ロード時にもアウトライン更新
});

// ========== ファイルシステム操作 ==========
let currentFilePath = null;
let currentDirectoryPath = null;
let openedFiles = new Map();
let fileModificationState = new Map();

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

        const newFileTree = fileTree.cloneNode(true);
        fileTree.parentNode.replaceChild(newFileTree, fileTree);

        const rootItem = newFileTree.querySelector('.tree-item.expanded');

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
        }

        // 1. クリック (選択 & フォルダ開閉 & ファイルオープン)
        newFileTree.addEventListener('click', (e) => {
            const item = e.target.closest('.tree-item');
            if (!item) return;

            // 入力モード中は無視
            if (item.classList.contains('creation-mode')) return;

            e.stopPropagation();

            // 選択状態の更新
            newFileTree.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');

            // フォルダなら開閉、ファイルなら開く
            if (item.classList.contains('file')) {
                // ★ワンクリックで開く
                openFile(item.dataset.path, item.dataset.name);
            } else {
                toggleFolder(item);
            }
        });

        newFileTree.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.tree-item');
            if (!item) return;
            if (item.classList.contains('creation-mode')) return;

            e.preventDefault();
            e.stopPropagation();

            newFileTree.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
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

async function loadDirectoryTree(dirPath) {
    const rootItem = document.querySelector('.tree-item.expanded');
    if (rootItem && rootItem.dataset.path === dirPath) {
        await loadDirectoryTreeContents(rootItem, dirPath);
    }
}

// フォルダを展開/折りたたみ
async function toggleFolder(folderElement) {
    const toggle = folderElement.querySelector('.tree-toggle');
    if (!toggle) return;

    const folderPath = folderElement.dataset.path;
    // 回転判定ではなく文字判定にする
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

        childrenContainer.style.display = 'block';

        if (childrenContainer.children.length === 0) {
            await loadDirectoryTreeContents(folderElement, folderPath);
        }
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

// ========== ソート設定とヘルパー ==========
let currentSortOrder = 'asc';

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
            console.warn('readDirectory API not available');
            return [];
        }
    } catch (error) {
        console.error('Failed to read directory:', error);
        return [];
    }
}

// ========== アイコン定義とツリー要素作成 ==========
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

function createTreeElement(item, parentPath) {
    const itemPath = `${parentPath}/${item.name}`;
    const container = document.createElement('div');
    container.className = 'tree-item' + (item.isDirectory ? '' : ' file');
    container.dataset.path = itemPath;
    container.dataset.name = item.name;

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

// ファイルを開く
async function openFile(filePath, fileName) {
    try {
        if (openedFiles.has('README.md')) {
            closeWelcomeReadme();
        }

        currentFilePath = filePath;

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
            tab.className = 'tab active';
            tab.dataset.filepath = filePath;
            tab.innerHTML = `${fileName} <span class="close-tab" data-filepath="${filePath}">×</span>`;

            editorTabsContainer.appendChild(tab);
            openedFiles.set(filePath, { content: fileContent, fileName: fileName });
        } else {
            document.querySelectorAll('.editor-tabs .tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
        }

        switchToFile(filePath);
    } catch (error) {
        console.error('Failed to open file:', error);
        // アラートによるフォーカスロストを防ぐため、consoleのみにするか、控えめな通知にする
    }
}

function showWelcomeReadme() {
    const readmePath = 'README.md';
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

    openedFiles.set(readmePath, {
        content: initialMarkdown,
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
    const editorArea = document.getElementById('content-readme');
    const settingsArea = document.getElementById('content-settings');

    if (editorArea) editorArea.classList.remove('content-hidden');
    if (settingsArea) settingsArea.classList.add('content-hidden');

    currentFilePath = filePath;

    const fileData = openedFiles.get(filePath);
    const fileContent = fileData ? fileData.content : '';

    editor.value = fileContent;

    document.querySelectorAll('.editor-tabs .tab').forEach(t => {
        if (t.dataset.filepath === filePath) {
            t.classList.add('active');
        } else {
            t.classList.remove('active');
        }
    });

    renderMarkdownLive();
    // アウトラインも更新
    updateOutline();

    if (isPdfPreviewVisible) {
        generatePdfPreview();
    }

    if (fileData) {
        document.title = `${fileData.fileName} - Markdown IDE`;
    }

    updateFileStats();
    
    // ファイル切り替え後にエディタにフォーカス
    // editor.focus();
}

function closeFile(filePath, tabElement) {
    try {
        if (filePath === 'README.md') return;

        if (tabElement && tabElement.parentNode) {
            tabElement.remove();
        }

        openedFiles.delete(filePath);
        fileModificationState.delete(filePath);

        if (currentFilePath === filePath) {
            currentFilePath = null;
            editor.value = '';

            const previewPane = document.getElementById('preview');
            if (previewPane) {
                previewPane.innerHTML = '';
            }

            const remainingTabs = document.querySelectorAll('.editor-tabs .tab');
            if (remainingTabs.length > 0) {
                const nextTab = remainingTabs[remainingTabs.length - 1];
                if (nextTab.dataset.filepath) {
                    switchToFile(nextTab.dataset.filepath);
                }
            } else {
                showWelcomeReadme();
            }
        }
    } catch (error) {
        console.error('Error closing file:', error);
    }
}

async function saveCurrentFile() {
    if (!currentFilePath) {
        console.warn('ファイルが選択されていません');
        return;
    }

    if (currentFilePath === 'README.md') return;

    try {
        const content = editor.value || '';

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

// ========== 新規作成機能 (VS Code風インライン入力) ==========
async function showCreationInput(isFolder) {
    const fileTree = document.querySelector('.file-tree');
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
        // 入力終了後にエディタにフォーカスを戻す
        if (editor) editor.focus();
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

    // blurイベントでの削除を少し遅延させて、他の操作との競合を防ぐ
    inputField.addEventListener('blur', () => {
        if (!isCreating) {
            setTimeout(safeRemove, 100); 
        }
    });
}

async function createNewFile() {
    showCreationInput(false); 
}

async function createNewFolder() {
    showCreationInput(true);  
}

async function openFolder() {
    try {
        if (typeof window.electronAPI?.selectFolder !== 'function') {
            return;
        }

        const result = await window.electronAPI.selectFolder();

        if (result.success && result.path) {
            await initializeFileTree();
        }
    } catch (error) {
        console.error('Failed to open folder:', error);
    }
}

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

// ========== ショートカットキー ==========
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
                const closeBtn = document.getElementById('close-settings-tab');
                if (closeBtn) closeBtn.click();
            }
            else if (activeTab.dataset.filepath) {
                if (activeTab.dataset.filepath === 'README.md') {
                    return;
                }
                closeFile(activeTab.dataset.filepath, activeTab);
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

    // Deleteキーの処理を修正
    if (e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) {
        const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        
        // 入力フォームにフォーカスがある場合は削除処理を実行しない
        if (activeTag === 'input' || activeTag === 'textarea') return;

        const selectedItem = document.querySelector('.file-tree .tree-item.selected');
        if (selectedItem) {
            // 新規作成中のアイテムは無視
            if (selectedItem.classList.contains('creation-mode')) return;

            const path = selectedItem.dataset.path;
            const name = selectedItem.dataset.name;
            if (path && name) {
                // モーダル確認ダイアログを表示
                showModalConfirm(name, () => {
                    confirmAndDelete(path);
                });
            }
        }
    }
});

if (editor) {
    // 入力時のイベントリスナー
    editor.addEventListener('input', () => {
        if (currentFilePath) {
            fileModificationState.set(currentFilePath, true);
            const tab = document.querySelector(`[data-filepath="${CSS.escape(currentFilePath)}"]`);
            if (tab) {
                const currentHTML = tab.innerHTML;
                if (!currentHTML.includes('●')) {
                    const closeBtnIndex = currentHTML.lastIndexOf('<span class="close-tab"');
                    if (closeBtnIndex > -1) {
                        const beforeClose = currentHTML.substring(0, closeBtnIndex).trim();
                        const closeBtn = currentHTML.substring(closeBtnIndex);
                        tab.innerHTML = `${beforeClose} ● ${closeBtn}`;
                    }
                }
            }
        }

        renderMarkdownLive();
        
        // エディタの内容が変わったらアウトラインも更新
        if (window.outlineUpdateTimeout) clearTimeout(window.outlineUpdateTimeout);
        window.outlineUpdateTimeout = setTimeout(() => {
            updateOutline();
            syncOutlineWithCursor(); // 更新後に同期
        }, 500);

        if (isPdfPreviewVisible) {
            if (window.pdfUpdateTimeout) {
                clearTimeout(window.pdfUpdateTimeout);
            }
            window.pdfUpdateTimeout = setTimeout(() => {
                generatePdfPreview();
            }, 1000);
        }
        updateFileStats();
    });

    // カーソル移動やクリック時のイベントリスナー（アウトライン同期用）
    // 頻繁に発火するためデバウンス処理を入れる
    const syncHandler = () => {
        if (window.cursorSyncTimeout) clearTimeout(window.cursorSyncTimeout);
        window.cursorSyncTimeout = setTimeout(syncOutlineWithCursor, 100);
    };

    editor.addEventListener('keyup', syncHandler);
    editor.addEventListener('mouseup', syncHandler);
    editor.addEventListener('click', syncHandler);
    editor.addEventListener('scroll', syncHandler);
}

function renderMarkdownLive() {
    const plainText = editor.value || '';
    const previewPane = document.getElementById('preview');

    if (!previewPane) {
        console.warn('Preview pane not found');
        return;
    }

    if (typeof marked === 'undefined') {
        console.warn('marked.js is not loaded');
        previewPane.innerHTML = '<p>Markdownプレビューが利用できません。</p>';
        return;
    }

    try {
        if (typeof marked.setOptions === 'function') {
            marked.setOptions({
                breaks: true,
                gfm: true
            });
        }

        const htmlContent = marked.parse(plainText);
        previewPane.innerHTML = htmlContent;

        if (typeof Prism !== 'undefined') {
            Prism.highlightAllUnder(previewPane);
        }
    } catch (error) {
        console.error('Error rendering Markdown:', error);
        previewPane.innerHTML = `<p style="color: red;">エラー: ${error.message}</p>`;
    }
}

function processMarkdownForDisplay(markdownText) {
    let html = marked.parse(markdownText);

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

// カスタム確認モーダルを表示する関数
function showModalConfirm(itemName, onConfirm) {
    // 既存のモーダルがあれば削除
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

    // ボタンイベント
    const closeModal = () => {
        overlay.remove();
        // モーダルを閉じた後にエディタへフォーカスを戻す
        if (editor) editor.focus();
    };

    cancelBtn.addEventListener('click', closeModal);

    deleteBtn.addEventListener('click', () => {
        onConfirm();
        closeModal();
    });

    // オーバーレイクリックで閉じる
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });
}

// 削除の実行（確認なし）
async function confirmAndDelete(path) {
    try {
        if (typeof window.electronAPI?.deleteFile === 'function') {
            await window.electronAPI.deleteFile(path);

            const deletedItem = document.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`);
            if (deletedItem) {
                const parentContainer = deletedItem.parentElement;
                if (parentContainer && parentContainer.classList.contains('tree-children')) {
                    const parentFolder = parentContainer.previousElementSibling;
                    if (parentFolder && parentFolder.dataset.path) {
                        await reloadContainer(parentContainer, parentFolder.dataset.path);
                    } else {
                        initializeFileTree();
                    }
                } else {
                    initializeFileTree();
                }
            }
        }
    } catch (error) {
        console.error('Delete failed:', error);
    }
}

let activeContextMenu = null;

function showContextMenu(x, y, path, name) {
    if (activeContextMenu) activeContextMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const deleteOption = document.createElement('div');
    deleteOption.className = 'context-menu-item';
    deleteOption.textContent = '削除';
    deleteOption.addEventListener('click', () => {
        // コンテキストメニューからの削除でもモーダルを表示
        menu.remove();
        activeContextMenu = null;
        
        showModalConfirm(name, () => {
            confirmAndDelete(path);
        });
    });

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