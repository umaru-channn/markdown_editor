/* livePreviewPlugin.js */
const path = require('path');
const { ViewPlugin, Decoration, WidgetType, keymap } = require("@codemirror/view");
const { syntaxTree } = require("@codemirror/language");
const { RangeSetBuilder } = require("@codemirror/state");

/* ========== Helper Functions & Widgets ========== */

// 言語リスト
const LANGUAGE_LIST = [
    { label: "Plain Text", value: "" },
    { label: "JavaScript", value: "javascript" },
    { label: "TypeScript", value: "typescript" },
    { label: "HTML", value: "html" },
    { label: "CSS", value: "css" },
    { label: "Python", value: "python" },
    { label: "Java", value: "java" },
    { label: "C", value: "c" },
    { label: "C++", value: "cpp" },
    { label: "C#", value: "csharp" },
    { label: "Go", value: "go" },
    { label: "Rust", value: "rust" },
    { label: "PHP", value: "php" },
    { label: "Ruby", value: "ruby" },
    { label: "Swift", value: "swift" },
    { label: "Kotlin", value: "kotlin" },
    { label: "SQL", value: "sql" },
    { label: "JSON", value: "json" },
    { label: "XML", value: "xml" },
    { label: "YAML", value: "yaml" },
    { label: "Markdown", value: "markdown" },
    { label: "Bash / Shell", value: "bash" },
    { label: "PowerShell", value: "powershell" },
    { label: "Dockerfile", value: "dockerfile" },
    { label: "Diff", value: "diff" },
    { label: "Lua", value: "lua" },
    { label: "Perl", value: "perl" },
    { label: "R", value: "r" },
    { label: "Dart", value: "dart" },
    { label: "Scala", value: "scala" }
];

// Altテキストからサイズを解析するヘルパー関数
function parseAltText(rawAlt) {
    if (!rawAlt) return { alt: "", width: null };

    // パイプ(|)を探す
    const pipeIndex = rawAlt.lastIndexOf('|');
    if (pipeIndex === -1) return { alt: rawAlt, width: null };

    // パイプの後ろが数字(または数字x数字)かチェック
    const sizePart = rawAlt.substring(pipeIndex + 1);
    const content = rawAlt.substring(0, pipeIndex);

    // "100" または "100x200" の形式にマッチ (今回は幅だけを使用)
    const match = sizePart.match(/^(\d+)(?:x(\d+))?$/);
    if (match) {
        return {
            alt: content,
            width: match[1]
        };
    }

    // サイズ指定でない場合はそのままAltテキストとして扱う
    return { alt: rawAlt, width: null };
}

function findLinkText(node, state) {
    let textStart = 0;
    let textEnd = 0;
    const n = node.node || node;
    let child = n.firstChild;
    while (child) {
        if (child.name === "LinkMark") {
            const mark = state.doc.sliceString(child.from, child.to);
            if (mark === "[" || mark === "![") { textStart = child.to; }
            if (mark === "]") { textEnd = child.from; break; }
        }
        child = child.nextSibling;
    }
    if (textStart > 0 && textEnd > 0) {
        return state.doc.sliceString(textStart, textEnd);
    }
    return "";
}

// 言語名を適切にフォーマットする関数
function formatLanguageName(lang) {
    if (!lang) return "Plain Text";
    const l = lang.toLowerCase();

    // LANGUAGE_LISTから検索
    const found = LANGUAGE_LIST.find(item => item.value === l);
    if (found) return found.label;

    // マップにない場合のフォールバック（一般的な別名対応）
    const map = {
        "js": "JavaScript", "node": "JavaScript", "jsx": "JavaScript",
        "ts": "TypeScript", "tsx": "TypeScript",
        "py": "Python",
        "md": "Markdown",
        "htm": "HTML",
        "cs": "C#",
        "rs": "Rust",
        "sh": "Bash / Shell", "zsh": "Bash / Shell",
        "yml": "YAML",
        "rb": "Ruby",
        "go": "Go",
        "ps1": "PowerShell",
        "docker": "Dockerfile"
    };
    return map[l] || (l.charAt(0).toUpperCase() + l.slice(1));
}

// インデントレベルを計算するヘルパー関数
function calculateIndentLevel(text) {
    let spaceCount = 0;
    for (const char of text) {
        if (char === ' ') spaceCount += 1;
        else if (char === '\t') spaceCount += 4; // タブは4スペース相当とみなす
        else break;
    }
    // タブ幅(4スペース)につき1レベルとする
    return Math.floor(spaceCount / 4);
}

/* --- Simple Widgets --- */
class HRWidget extends WidgetType {
    toDOM() {
        const hr = document.createElement("hr");
        hr.className = "cm-live-widget-hr";
        return hr;
    }
    ignoreEvent() { return false; }
}

/* ImageWidget */
class ImageWidget extends WidgetType {
    constructor(alt, src, width) {
        super();
        this.alt = alt;
        this.src = src;
        this.width = width; // 幅情報を保持
    }

    eq(other) {
        return this.src === other.src &&
            this.alt === other.alt &&
            this.width === other.width;
    }

    toDOM(view) {
        const wrapper = document.createElement("div");
        wrapper.className = "cm-image-wrapper";

        // Markdownから指定された幅があれば適用
        if (this.width) {
            wrapper.style.width = this.width + "px";
        }

        const img = document.createElement("img");
        img.className = "cm-live-widget-image";
        
        // パス解決ロジック (ローカルファイル対応)
        let imageSrc = this.src;
        
        // URLが http/https で始まらず、かつデータURIでもない場合
        if (!/^https?:\/\//i.test(imageSrc) && !/^data:/i.test(imageSrc)) {
            // renderer.js で設定した現在のディレクトリパスを取得
            const currentDir = document.body.dataset.currentDir;
            
            if (currentDir) {
                // 絶対パスでない場合は結合して絶対パス化
                if (!path.isAbsolute(imageSrc)) {
                    // path.joinで結合し、fileプロトコルを付与
                    // Windowsパスのバックスラッシュも考慮してスラッシュに統一
                    const absPath = path.join(currentDir, imageSrc);
                    imageSrc = `file://${absPath.replace(/\\/g, '/')}`;
                } else {
                    // すでに絶対パスなら file:// をつけるだけ
                    imageSrc = `file://${imageSrc.replace(/\\/g, '/')}`;
                }
            }
        }
        img.src = imageSrc;
        img.alt = this.alt;

        // 読み込み失敗時の表示崩れ防止
        img.onerror = () => {
            img.style.minWidth = "50px";
            img.style.minHeight = "50px";
            img.style.backgroundColor = "rgba(0,0,0,0.05)";
        };

        const handle = document.createElement("div");
        handle.className = "cm-image-resize-handle";

        wrapper.appendChild(img);
        wrapper.appendChild(handle);

        // リサイズ処理
        handle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startRect = wrapper.getBoundingClientRect();
            const startWidth = startRect.width;
            let currentWidth = startWidth;

            const onMouseMove = (moveEvent) => {
                const diff = moveEvent.clientX - startX;
                currentWidth = Math.max(50, startWidth + diff);
                wrapper.style.width = `${currentWidth}px`;
            };

            const onMouseUp = () => {
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);

                // リサイズ終了後にMarkdownテキストを更新
                this.updateSizeInMarkdown(view, wrapper, Math.round(currentWidth));
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });

        return wrapper;
    }

    // Markdown内の `![alt|size](url)` を書き換えるメソッド
    updateSizeInMarkdown(view, wrapperDom, newWidth) {
        const pos = view.posAtDOM(wrapperDom);
        if (pos === null) return;

        const tree = syntaxTree(view.state);
        let node = tree.resolveInner(pos, 1);

        // Imageノードを探す
        while (node && node.name !== "Image" && node.name !== "Document") {
            node = node.parent;
        }

        if (node && node.name === "Image") {
            // 新しいテキストを構築: ![alt|newWidth](src)
            const newAltText = `${this.alt}|${newWidth}`;
            const newText = `![${newAltText}](${this.src})`;

            view.dispatch({
                changes: { from: node.from, to: node.to, insert: newText }
            });
        }
    }

    ignoreEvent() { return true; }
}

class CheckboxWidget extends WidgetType {
    constructor(checked) { super(); this.checked = checked; }
    eq(other) { return other.checked === this.checked; }
    toDOM() {
        const wrapper = document.createElement("span");
        wrapper.className = "cm-live-checkbox-wrapper";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "cm-live-checkbox-input";
        input.checked = this.checked;
        wrapper.appendChild(input);
        return wrapper;
    }
    ignoreEvent() { return true; }
}

/* --- Code Block Language Label Widget (Dropdown) --- */
class CodeBlockLanguageWidget extends WidgetType {
    constructor(lang) { super(); this.lang = lang; }
    eq(other) { return other.lang === this.lang; }

    toDOM(view) {
        const container = document.createElement("div");
        container.className = "cm-language-widget-container";

        // 言語選択ボタン（ドロップダウンのトリガー）
        const selectBtn = document.createElement("button");
        selectBtn.className = "cm-language-select-btn";
        selectBtn.innerHTML = `<span>${formatLanguageName(this.lang)}</span> <span class="arrow">▼</span>`;
        selectBtn.title = "言語を選択";

        selectBtn.addEventListener("mousedown", (e) => {
            e.preventDefault(); // エディタのフォーカス喪失を防ぐ
            this.showDropdown(view, selectBtn);
        });

        // コピーボタン
        const copyBtn = document.createElement("button");
        copyBtn.className = "cm-code-copy-btn";
        copyBtn.textContent = "コピー";
        copyBtn.title = "コードをクリップボードにコピー";

        // Widget内での直接イベントハンドリングに変更
        copyBtn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.copyCode(view, container, copyBtn);
        });

        container.appendChild(selectBtn);
        container.appendChild(copyBtn);
        return container;
    }

    // コピー処理の実装
    copyCode(view, container, btn) {
        const pos = view.posAtDOM(container);
        if (pos === null) return;

        let node = syntaxTree(view.state).resolveInner(pos, 1);
        while (node && node.name !== "FencedCode") {
            node = node.parent;
        }

        if (node && node.name === "FencedCode") {
            const startLine = view.state.doc.lineAt(node.from);
            const endLine = view.state.doc.lineAt(node.to);
            const codeStart = startLine.to + 1;
            const codeEnd = endLine.from;

            if (codeStart < codeEnd) {
                const codeText = view.state.sliceDoc(codeStart, codeEnd);
                if (navigator.clipboard) {
                    navigator.clipboard.writeText(codeText).then(() => {
                        const originalText = btn.textContent;
                        btn.textContent = "Copied!";
                        btn.classList.add("copied");
                        setTimeout(() => {
                            btn.textContent = originalText;
                            btn.classList.remove("copied");
                        }, 2000);
                    }).catch(err => console.error(err));
                }
            }
        }
    }

    showDropdown(view, targetBtn) {
        // 既存のドロップダウンがあれば閉じる
        const existingDropdown = document.querySelector(".cm-language-dropdown-portal");
        if (existingDropdown) existingDropdown.remove();

        const dropdown = document.createElement("div");
        dropdown.className = "cm-language-dropdown-portal";

        const searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.className = "cm-language-search";
        searchInput.placeholder = "言語を検索...";
        searchInput.spellcheck = false;

        const listContainer = document.createElement("div");
        listContainer.className = "cm-language-list";

        const performChange = (newLang) => {
            const pos = view.posAtDOM(targetBtn);
            if (pos === null) return;

            // 構文木から FencedCode ノードを探す
            let node = syntaxTree(view.state).resolveInner(pos, 1);
            while (node && node.name !== "FencedCode") {
                node = node.parent;
            }

            if (node && node.name === "FencedCode") {
                // コードブロックの先頭行を取得
                const line = view.state.doc.lineAt(node.from);
                const lineText = line.text;

                // 正規表現で ```lang の部分を特定して置換
                const match = lineText.match(/^(\s*`{3,})([\w-]*)/);
                if (match) {
                    const prefix = match[1]; // "```"
                    const currentLang = match[2]; // "javascript"

                    // 言語指定部分の開始位置と終了位置
                    const start = line.from + prefix.length;
                    const end = start + currentLang.length;

                    view.dispatch({
                        changes: { from: start, to: end, insert: newLang }
                    });
                }
            }
        };

        const renderList = (filterText = "") => {
            listContainer.innerHTML = "";
            const lowerFilter = filterText.toLowerCase();

            LANGUAGE_LIST.forEach(item => {
                if (filterText && !item.label.toLowerCase().includes(lowerFilter) && !item.value.toLowerCase().includes(lowerFilter)) {
                    return;
                }

                const listItem = document.createElement("div");
                listItem.className = "cm-language-item";
                const isSelected = (this.lang || "").toLowerCase() === item.value;
                if (isSelected) listItem.classList.add("selected");

                listItem.innerHTML = `
                    <span class="label">${item.label}</span>
                    ${isSelected ? '<span class="check">✓</span>' : ''}
                `;

                listItem.addEventListener("mousedown", (e) => { // clickだとblurが先に走る可能性があるためmousedown
                    e.preventDefault();
                    performChange(item.value);
                    dropdown.remove();
                    document.removeEventListener("mousedown", outsideClickListener);
                });

                listContainer.appendChild(listItem);
            });

            if (listContainer.children.length === 0) {
                const emptyItem = document.createElement("div");
                emptyItem.className = "cm-language-item empty";
                emptyItem.textContent = "見つかりません";
                listContainer.appendChild(emptyItem);
            }
        };

        renderList();

        searchInput.addEventListener("input", (e) => {
            renderList(e.target.value);
        });

        // 検索ボックスでのEnterキー対応
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                // 最初の候補を選択
                const firstItem = listContainer.querySelector(".cm-language-item:not(.empty)");
                if (firstItem) {
                    const evt = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
                    firstItem.dispatchEvent(evt);
                }
            }
        });

        dropdown.appendChild(searchInput);
        dropdown.appendChild(listContainer);
        document.body.appendChild(dropdown);

        const rect = targetBtn.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 4}px`;

        // 右端揃えにするか左揃えにするか（画面からはみ出さないように）
        const dropdownWidth = 220; // CSSと合わせる
        if (rect.left + dropdownWidth > window.innerWidth - 20) {
            dropdown.style.left = `${rect.right - dropdownWidth}px`;
        } else {
            dropdown.style.left = `${rect.left}px`;
        }

        searchInput.focus();

        const outsideClickListener = (e) => {
            if (!dropdown.contains(e.target) && e.target !== targetBtn && !targetBtn.contains(e.target)) {
                dropdown.remove();
                document.removeEventListener("mousedown", outsideClickListener);
            }
        };

        setTimeout(() => {
            document.addEventListener("mousedown", outsideClickListener);
        }, 0);
    }

    ignoreEvent() { return true; }
}

/* --- 改ページ (Page Break) Widget --- */
class PageBreakWidget extends WidgetType {
    toDOM() {
        const div = document.createElement("div");
        div.className = "cm-page-break-widget";
        div.textContent = "改ページ";
        return div;
    }
    ignoreEvent() { return true; }
}

/* --- Bookmark (Link Card) Widget --- */
// キャッシュ用マップ（同じURLの再フェッチを防ぐ）
const bookmarkCache = new Map();

class BookmarkWidget extends WidgetType {
    constructor(url) {
        super();
        this.url = url;
    }

    eq(other) {
        return other.url === this.url;
    }

    toDOM() {
        const container = document.createElement("a");
        container.className = "cm-bookmark-widget cm-bookmark-loading";
        container.href = this.url;
        container.target = "_blank";
        container.rel = "noopener noreferrer";
        container.contentEditable = "false"; // 編集不可にする

        // スケルトンUI (ローディング中)
        const content = document.createElement("div");
        content.className = "cm-bookmark-content";

        const titleSkeleton = document.createElement("div");
        titleSkeleton.className = "skeleton-box";
        titleSkeleton.style.width = "70%";
        titleSkeleton.style.height = "1.2em";
        titleSkeleton.style.marginBottom = "8px";

        const descSkeleton = document.createElement("div");
        descSkeleton.className = "skeleton-box";
        descSkeleton.style.width = "90%";
        descSkeleton.style.height = "2.4em";

        content.appendChild(titleSkeleton);
        content.appendChild(descSkeleton);
        container.appendChild(content);

        const coverSkeleton = document.createElement("div");
        coverSkeleton.className = "cm-bookmark-cover skeleton-box";
        container.appendChild(coverSkeleton);

        // データ取得ロジック
        this.loadData(container);

        return container;
    }

    async loadData(container) {
        try {
            let data = bookmarkCache.get(this.url);

            if (!data) {
                if (window.electronAPI && window.electronAPI.fetchUrlMetadata) {
                    const result = await window.electronAPI.fetchUrlMetadata(this.url);
                    if (result.success) {
                        data = result.data;
                        bookmarkCache.set(this.url, data);
                    }
                }
            }

            if (data) {
                this.renderData(container, data);
            } else {
                // 取得失敗時のフォールバック（単純なリンク表示など）
                // ここではとりあえずスケルトンを消してURLを表示
                container.classList.remove("cm-bookmark-loading");
                container.innerHTML = `
                        <div class="cm-bookmark-content">
                            <div class="cm-bookmark-title">${this.url}</div>
                            <div class="cm-bookmark-desc">No preview available</div>
                        </div>
                    `;
            }
        } catch (e) {
            console.error("Failed to load bookmark data", e);
        }
    }

    renderData(container, data) {
        container.classList.remove("cm-bookmark-loading");
        container.innerHTML = ""; // スケルトンをクリア

        // 左側コンテンツ
        const contentDiv = document.createElement("div");
        contentDiv.className = "cm-bookmark-content";

        const titleDiv = document.createElement("div");
        titleDiv.className = "cm-bookmark-title";
        titleDiv.textContent = data.title || this.url;

        const descDiv = document.createElement("div");
        descDiv.className = "cm-bookmark-desc";
        descDiv.textContent = data.description || "No description provided.";

        const metaDiv = document.createElement("div");
        metaDiv.className = "cm-bookmark-meta";

        // ファビコン (Googleのサービスを利用)
        const faviconUrl = `https://www.google.com/s2/favicons?domain=${data.domain}&sz=32`;
        const favicon = document.createElement("img");
        favicon.src = faviconUrl;
        favicon.className = "cm-bookmark-favicon";
        favicon.alt = "";

        const domainSpan = document.createElement("span");
        domainSpan.className = "cm-bookmark-domain";
        domainSpan.textContent = data.domain;

        metaDiv.appendChild(favicon);
        metaDiv.appendChild(domainSpan);

        contentDiv.appendChild(titleDiv);
        contentDiv.appendChild(descDiv);
        contentDiv.appendChild(metaDiv);

        container.appendChild(contentDiv);

        // 右側画像
        if (data.image) {
            const coverDiv = document.createElement("div");
            coverDiv.className = "cm-bookmark-cover";

            const img = document.createElement("img");
            img.className = "cm-bookmark-image";
            img.src = data.image;
            img.alt = "Cover";

            // 画像読み込みエラー時の処理
            img.onerror = () => {
                coverDiv.style.display = "none";
            };

            coverDiv.appendChild(img);
            container.appendChild(coverDiv);
        }
    }

    ignoreEvent() { return false; } // リンククリックを有効にするためfalse
}

/* ========== Decoration Logic ========== */

function buildDecorations(view) {
    const { state } = view;
    const cursor = state.selection.main.head;
    const processedLines = new Set();
    const collectedDecos = [];

    for (const { from, to } of view.visibleRanges) {
        // 1. まず各行のテキストベースでのチェック（改ページ検出、ブックマーク検出など）
        for (let pos = from; pos < to;) {
            const line = state.doc.lineAt(pos);

            // 既に処理済みの行はスキップ
            if (processedLines.has(line.from)) {
                pos = line.to + 1;
                continue;
            }

            const isCursorOnLine = (cursor >= line.from && cursor <= line.to);
            const lineText = line.text;

            // 改ページタグの検出
            const pageBreakRegex = /^\s*<div\s+class=["']page-break["']>\s*<\/div>\s*$/i;
            if (pageBreakRegex.test(lineText)) {
                if (!isCursorOnLine) {
                    collectedDecos.push({
                        from: line.from,
                        to: line.to,
                        side: -1,
                        deco: Decoration.replace({ widget: new PageBreakWidget() })
                    });
                    processedLines.add(line.from);
                    pos = line.to + 1;
                    continue;
                }
            }

            // "@card URL" の形式の行をブックマークカード化する
            const bookmarkRegex = /^@card\s+(https?:\/\/[^\s]+)$/;
            const bookmarkMatch = lineText.trim().match(bookmarkRegex);

            if (bookmarkMatch) {
                if (!isCursorOnLine) {
                    collectedDecos.push({
                        from: line.from,
                        to: line.to,
                        side: -1,
                        deco: Decoration.replace({ widget: new BookmarkWidget(bookmarkMatch[1]) })
                    });
                    processedLines.add(line.from);
                    pos = line.to + 1;
                    continue;
                }
            }

            // ハイライト (==text==) の検出
            const highlightRegex = /==([^=]+)==/g;
            let match;
            while ((match = highlightRegex.exec(lineText)) !== null) {
                const start = line.from + match.index;
                const end = start + match[0].length;

                // カーソルがハイライト内にあるか
                const isCursorIn = (cursor >= start && cursor <= end);

                if (!isCursorIn) {
                    // マーカー (==) を隠す (開始)
                    collectedDecos.push({
                        from: start,
                        to: start + 2,
                        side: 0,
                        deco: Decoration.mark({ class: "cm-hide-marker" })
                    });
                    // テキスト部分を光らせる
                    collectedDecos.push({
                        from: start + 2,
                        to: end - 2,
                        side: 1,
                        deco: Decoration.mark({ class: "cm-live-highlight" })
                    });
                    // マーカー (==) を隠す (終了)
                    collectedDecos.push({
                        from: end - 2,
                        to: end,
                        side: 0,
                        deco: Decoration.mark({ class: "cm-hide-marker" })
                    });
                }
            }

            pos = line.to + 1;
        }

        // 2. 構文木ベースのチェック
        syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
                const n = node.node || node;
                const line = state.doc.lineAt(node.from);

                const isCursorOnLine = (cursor >= line.from && cursor <= line.to);
                const isCursorInNode = (cursor >= node.from && cursor <= node.to);

                if (processedLines.has(line.from) &&
                    !["StrongEmphasis", "Emphasis", "Strikethrough", "InlineCode", "Link", "TaskMarker", "FencedCode"].includes(node.name)) {
                    return;
                }

                if (node.name === "HorizontalRule") {
                    if (isCursorOnLine) return false;
                    collectedDecos.push({ from: line.from, to: line.to, side: -1, deco: Decoration.replace({ widget: new HRWidget() }) });
                    processedLines.add(line.from); return false;
                }
                else if (node.name === "Blockquote") {
                    const lineStart = state.doc.lineAt(node.from);
                    const lineEnd = state.doc.lineAt(node.to);
                    for (let l = lineStart.number; l <= lineEnd.number; l++) {
                        const lineObj = state.doc.line(l);
                        if (processedLines.has(lineObj.from)) continue;
                        if (cursor >= lineObj.from && cursor <= lineObj.to) {
                            processedLines.add(lineObj.from);
                            continue;
                        }
                        collectedDecos.push({ from: lineObj.from, to: lineObj.from, side: -1, deco: Decoration.line({ class: "cm-live-quote" }) });
                        const lineText = state.doc.sliceString(lineObj.from, lineObj.to);
                        const markerMatch = lineText.match(/^\s*>\s?/);
                        if (markerMatch) {
                            collectedDecos.push({ from: lineObj.from, to: lineObj.from + markerMatch[0].length, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                        }
                        processedLines.add(lineObj.from);
                    }
                    return true;
                }
                else if (/^ATXHeading[1-6]$/.test(node.name)) {
                    const level = parseInt(node.name.replace("ATXHeading", ""), 10);
                    const headingText = state.doc.sliceString(node.from, node.to);
                    const validHeadingRegex = new RegExp(`^#{${level}}\\s`);
                    if (!validHeadingRegex.test(headingText)) { return false; }
                    const markerLength = level + 1;
                    const textStart = node.from + markerLength;
                    const textEnd = node.to;
                    collectedDecos.push({ from: line.from, to: line.from, side: -1, deco: Decoration.line({ class: "cm-live-h" + level }) });
                    if (!isCursorOnLine) {
                        collectedDecos.push({ from: line.from, to: textStart, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    }
                    collectedDecos.push({ from: textStart, to: textEnd, side: 1, deco: Decoration.mark({ class: "cm-live-h-text" + level }) });
                    processedLines.add(line.from);
                    return true;
                }
                else if (node.name === "ListItem") {
                    const lineText = state.doc.sliceString(line.from, line.to);
                    const validListRegex = /^\s*([-*+]|\d+\.)\s/;
                    if (!validListRegex.test(lineText)) { return false; }

                    const listMark = n.firstChild;
                    if (!listMark) return true;

                    // インデントレベルの計算
                    const indentLevel = calculateIndentLevel(lineText);
                    const indentStyle = `--indent-level: ${indentLevel};`;

                    const taskMarker = n.getChild("TaskMarker");
                    const parent = n.parent;
                    const isOrdered = parent && parent.name === "OrderedList";

                    if (taskMarker) {
                        collectedDecos.push({ from: line.from, to: line.from, side: -1, deco: Decoration.line({ class: "cm-live-task", attributes: { style: indentStyle } }) });
                        if (listMark.name === "ListMark") {
                            // 行頭からマークまで隠す
                            collectedDecos.push({ from: line.from, to: listMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                        }
                    } else if (isOrdered) {
                        collectedDecos.push({ from: line.from, to: line.from, side: -1, deco: Decoration.line({ class: "cm-live-ol", attributes: { style: indentStyle } }) });
                        collectedDecos.push({ from: listMark.from, to: listMark.to, side: 0, deco: Decoration.mark({ class: "cm-live-ol-marker" }) });

                        // 行頭の空白だけ隠す
                        const indentMatch = lineText.match(/^\s*/);
                        if (indentMatch && indentMatch[0].length > 0) {
                            collectedDecos.push({ from: line.from, to: line.from + indentMatch[0].length, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                        }

                    } else {
                        collectedDecos.push({ from: line.from, to: line.from, side: -1, deco: Decoration.line({ class: "cm-live-li", attributes: { style: indentStyle } }) });
                        // 行頭からマークまで隠す
                        collectedDecos.push({ from: line.from, to: listMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    }
                    processedLines.add(line.from);
                    return true;
                }
                else if (node.name === "TaskMarker") {
                    const isChecked = state.doc.sliceString(node.from, node.to).toLowerCase().includes("x");
                    collectedDecos.push({ from: node.from, to: node.to, side: 1, deco: Decoration.replace({ widget: new CheckboxWidget(isChecked) }) });
                    return false;
                }
                else if (node.name === "FencedCode") {
                    const startLine = state.doc.lineAt(node.from);
                    const endLine = state.doc.lineAt(node.to);
                    let relativeLine = 1;

                    for (let l = startLine.number; l <= endLine.number; l++) {
                        const lineObj = state.doc.line(l);
                        if (processedLines.has(lineObj.from)) continue;

                        const isHeader = (l === startLine.number);
                        const isFooter = (l === endLine.number);

                        let className = "cm-code-block";
                        let attrs = {};

                        if (!isHeader && !isFooter) {
                            attrs = { "data-code-line": String(relativeLine++) };
                            className += " cm-code-with-linenum";
                        }

                        if (isCursorInNode) {
                            if (isHeader) className += " cm-code-block-first-active";
                            if (isFooter) className += " cm-code-block-last-active";

                            collectedDecos.push({
                                from: lineObj.from,
                                to: lineObj.from,
                                side: -1,
                                deco: Decoration.line({ class: className, attributes: attrs })
                            });
                        }
                        else {
                            if (isHeader) {
                                collectedDecos.push({
                                    from: lineObj.from,
                                    to: lineObj.from,
                                    side: -1,
                                    deco: Decoration.line({ class: "cm-code-header" })
                                });
                                collectedDecos.push({
                                    from: lineObj.from,
                                    to: lineObj.to,
                                    side: 0,
                                    deco: Decoration.mark({ class: "cm-transparent-text" })
                                });
                                const match = lineObj.text.match(/^(\s*`{3,})([\w-]+)?/);
                                const lang = match && match[2] ? match[2] : "";
                                collectedDecos.push({
                                    from: lineObj.to,
                                    to: lineObj.to,
                                    side: 1,
                                    deco: Decoration.widget({ widget: new CodeBlockLanguageWidget(lang), side: 1 })
                                });
                            }
                            else if (isFooter) {
                                collectedDecos.push({
                                    from: lineObj.from,
                                    to: lineObj.from,
                                    side: -1,
                                    deco: Decoration.line({ class: "cm-code-footer" })
                                });
                                collectedDecos.push({
                                    from: lineObj.from,
                                    to: lineObj.to,
                                    side: 0,
                                    deco: Decoration.mark({ class: "cm-transparent-text" })
                                });
                            }
                            else {
                                collectedDecos.push({
                                    from: lineObj.from,
                                    to: lineObj.from,
                                    side: -1,
                                    deco: Decoration.line({ class: className, attributes: attrs })
                                });
                            }
                        }
                        processedLines.add(lineObj.from);
                    }
                    return false;
                }
                else if (node.name === "Image") {
                    if (isCursorInNode) return false;

                    // サイズ解析を行いWidgetに渡す
                    const rawAlt = findLinkText(node, state);
                    const { alt, width } = parseAltText(rawAlt); // 分割

                    const urlNode = (typeof n.getChild === "function") ? n.getChild("URL") : null;
                    const src = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : "";

                    collectedDecos.push({
                        from: line.from,
                        to: line.to,
                        side: -1,
                        deco: Decoration.replace({ widget: new ImageWidget(alt, src, width) })
                    });
                    processedLines.add(line.from);
                    return false;
                }
                else if (node.name === "Link") {
                    if (isCursorInNode) return false;
                    const text = findLinkText(node, state);
                    const urlNode = (typeof n.getChild === "function") ? n.getChild("URL") : null;
                    if (!urlNode) return true;
                    const url = state.doc.sliceString(urlNode.from, urlNode.to);
                    collectedDecos.push({ from: node.from, to: node.to, side: 1, deco: Decoration.mark({ tagName: "span", class: "cm-live-link", attributes: { "data-href": url, title: "Ctrl (or Cmd) + Click to open link" } }) });
                    let child = n.firstChild;
                    while (child) {
                        if (child.name === "LinkMark" || child.name === "URL") {
                            collectedDecos.push({ from: child.from, to: child.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                        }
                        child = child.nextSibling;
                    }
                    return false;
                }
                else if (node.name === "InlineCode") {
                    if (isCursorInNode) return false;
                    let startMark = (typeof n.getChild === "function") ? n.getChild("CodeMark") : null;
                    let endMark = n.lastChild;
                    if (!startMark || !endMark) return true;
                    collectedDecos.push({ from: startMark.from, to: startMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    collectedDecos.push({ from: startMark.to, to: endMark.from, side: 1, deco: Decoration.mark({ class: "cm-live-code" }) });
                    collectedDecos.push({ from: endMark.from, to: endMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    return false;
                }
            },
            leave: (node) => {
                if (cursor >= node.from && cursor <= node.to) { return; }
                const n = node.node || node;
                let startMark, endMark;

                if (node.name === "Strikethrough") {
                    startMark = (typeof n.getChild === "function") ? n.getChild("StrikethroughMark") : null;
                    endMark = n.lastChild;
                    if (!startMark || !endMark) return;
                    collectedDecos.push({ from: startMark.from, to: startMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    collectedDecos.push({ from: startMark.to, to: endMark.from, side: 1, deco: Decoration.mark({ class: "cm-live-s" }) });
                    collectedDecos.push({ from: endMark.from, to: endMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                }
                else if (node.name === "StrongEmphasis") {
                    startMark = (typeof n.getChild === "function") ? n.getChild("EmphasisMark") : null;
                    endMark = n.lastChild;
                    if (!startMark || !endMark) return;
                    collectedDecos.push({ from: startMark.from, to: startMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    collectedDecos.push({ from: startMark.to, to: endMark.from, side: 1, deco: Decoration.mark({ class: "cm-live-bold" }) });
                    collectedDecos.push({ from: endMark.from, to: endMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                }
                else if (node.name === "Emphasis") {
                    startMark = (typeof n.getChild === "function") ? n.getChild("EmphasisMark") : null;
                    endMark = n.lastChild;
                    if (!startMark || !endMark) return;
                    collectedDecos.push({ from: startMark.from, to: startMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    collectedDecos.push({ from: startMark.to, to: endMark.from, side: 1, deco: Decoration.mark({ class: "cm-live-em" }) });
                    collectedDecos.push({ from: endMark.from, to: endMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                }
            }
        });
    }
    collectedDecos.sort((a, b) => a.from - b.from || a.side - b.side || b.to - a.to);
    const builder = new RangeSetBuilder();
    for (const { from, to, deco } of collectedDecos) {
        builder.add(from, to, deco);
    }
    return builder.finish();
}

const codeBlockAutoClose = keymap.of([{
    key: "`",
    run: (view) => {
        const { state } = view;
        const { from, to } = state.selection.main;
        if (from !== to) return false;
        if (from < 2) return false;
        const before = state.doc.sliceString(from - 2, from);
        if (before === "``") {
            const changes = { from: from, insert: "`\n```" };
            view.dispatch({ changes, selection: { anchor: from + 1 }, scrollIntoView: true });
            return true;
        }
        return false;
    }
}]);

const plugin = ViewPlugin.define(
    (view) => ({
        decorations: buildDecorations(view),
        update(update) {
            if (update.docChanged || update.viewportChanged || update.selectionSet) {
                this.decorations = buildDecorations(update.view);
            }
        },
    }),
    {
        decorations: v => v.decorations,
        eventHandlers: {
            mousedown: (e, view) => {
                const target = e.target;
                if (target.classList.contains("cm-live-checkbox-input")) {
                    e.preventDefault();
                    const pos = view.posAtDOM(target);
                    const line = view.state.doc.lineAt(pos);
                    const lineText = line.text;
                    const match = lineText.match(/^(\s*[-*+]\s+)(\[[ xX]\])/);
                    if (match) {
                        const prefixLen = match[1].length;
                        const markerStart = line.from + prefixLen;
                        const markerEnd = markerStart + 3;
                        const currentMarker = match[2];
                        const isChecked = currentMarker.toLowerCase().includes("x");
                        const newText = isChecked ? "[ ]" : "[x]";
                        view.dispatch({ changes: { from: markerStart, to: markerEnd, insert: newText } });
                        return true;
                    }
                }
                const linkElement = target.closest(".cm-live-link");
                if (linkElement) {
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        const url = linkElement.getAttribute("data-href");
                        if (url && window.electronAPI && window.electronAPI.openExternal) {
                            window.electronAPI.openExternal(url);
                        }
                    }
                }
                // ブックマークカードのクリック処理
                const bookmarkElement = target.closest(".cm-bookmark-widget");
                if (bookmarkElement) {
                    e.preventDefault();
                    const url = bookmarkElement.getAttribute("href");
                    if (url && window.electronAPI && window.electronAPI.openExternal) {
                        window.electronAPI.openExternal(url);
                    }
                }
            }
        }
    }
);

exports.livePreviewPlugin = [plugin, codeBlockAutoClose];