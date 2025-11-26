/* livePreviewPlugin.js */
const { ViewPlugin, Decoration, WidgetType, keymap } = require("@codemirror/view");
const { syntaxTree } = require("@codemirror/language");
const { RangeSetBuilder } = require("@codemirror/state");

/* ========== Helper Functions & Widgets ========== */

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
    if (!lang) return "";
    const l = lang.toLowerCase();
    const map = {
        "js": "JavaScript", "javascript": "JavaScript", "node": "Node.js",
        "ts": "TypeScript", "typescript": "TypeScript",
        "py": "Python", "python": "Python",
        "md": "Markdown", "markdown": "Markdown",
        "html": "HTML", "htm": "HTML",
        "css": "CSS",
        "java": "Java",
        "cpp": "C++", "c++": "C++", "c": "C",
        "cs": "C#", "csharp": "C#",
        "go": "Go",
        "rs": "Rust", "rust": "Rust",
        "sql": "SQL",
        "json": "JSON",
        "xml": "XML",
        "sh": "Shell", "bash": "Bash", "zsh": "Zsh",
        "yaml": "YAML", "yml": "YAML",
        "rb": "Ruby", "ruby": "Ruby",
        "php": "PHP"
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

class ImageWidget extends WidgetType {
    constructor(alt, src) { super(); this.alt = alt; this.src = src; }
    toDOM() {
        const img = document.createElement("img");
        img.className = "cm-live-widget-image";
        img.src = this.src;
        img.alt = this.alt;
        return img;
    }
    ignoreEvent() { return false; }
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

/* --- Code Block Language Label Widget --- */
class CodeBlockLanguageWidget extends WidgetType {
    constructor(lang) { super(); this.lang = lang; }
    eq(other) { return other.lang === this.lang; }
    toDOM() {
        const container = document.createElement("span");
        container.className = "cm-language-widget";

        if (this.lang) {
            const btn = document.createElement("button");
            btn.className = "cm-code-copy-btn";
            btn.textContent = formatLanguageName(this.lang);
            btn.title = "コードをコピー";
            container.appendChild(btn);
        }
        return container;
    }
    ignoreEvent() { return false; }
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

/* --- ★追加: Bookmark (Link Card) Widget --- */
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

            // ★追加: ハイライト (==text==) の検出
            // 既存の処理済行でない場合のみ実行
            // コードブロック内などの判定は processedLines に依存（構文木処理で後から追加される）
            // ここでは簡易的に「行全体が特定のウィジェットでない場合」に処理する

            const highlightRegex = /==([^=]+)==/g;
            let match;
            while ((match = highlightRegex.exec(lineText)) !== null) {
                const start = line.from + match.index;
                const end = start + match[0].length;
                const textLen = match[1].length;

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
                                const match = lineObj.text.match(/^(\s*`{3,})(\w+)?/);
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
                    const alt = findLinkText(node, state);
                    const urlNode = (typeof n.getChild === "function") ? n.getChild("URL") : null;
                    const src = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : "";
                    collectedDecos.push({ from: line.from, to: line.to, side: -1, deco: Decoration.replace({ widget: new ImageWidget(alt, src) }) });
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
                if (target.classList.contains("cm-code-copy-btn")) {
                    e.preventDefault();
                    const pos = view.posAtDOM(target);
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
                                    const originalText = target.textContent;
                                    target.textContent = "Copied!";
                                    target.classList.add("copied");
                                    setTimeout(() => {
                                        target.textContent = originalText;
                                        target.classList.remove("copied");
                                    }, 2000);
                                }).catch(err => console.error(err));
                            }
                        }
                    }
                    return true;
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
                    // デフォルトのリンク動作（target="_blank"）をElectronで正しく開くため
                    // 内部ブラウザ遷移を防ぎ、外部ブラウザで開く
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