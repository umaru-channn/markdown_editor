/* livePreviewPlugin.js */
const path = require('path');
const { ViewPlugin, Decoration, WidgetType, keymap } = require("@codemirror/view");
const { syntaxTree } = require("@codemirror/language");
const { RangeSetBuilder, StateField, StateEffect, Prec } = require("@codemirror/state");
const katex = require('katex');

// --- Mermaid Mode State Management ---
// モード変更用のアクションと状態管理
const setMermaidMode = StateEffect.define();
const mermaidModeField = StateField.define({
    create() { return new Map(); },
    update(value, tr) {
        // ドキュメント変更に合わせて位置(pos)をマッピングし直す
        let newValue = new Map();
        for (const [pos, mode] of value) {
            newValue.set(tr.changes.mapPos(pos), mode);
        }
        // モード変更アクションがあれば適用
        for (const effect of tr.effects) {
            if (effect.is(setMermaidMode)) {
                newValue.set(effect.value.pos, effect.value.mode);
            }
        }
        return newValue;
    }
});

// Mermaidのプレビュー表示とコード隠蔽を管理するStateField
const mermaidPreviewField = StateField.define({
    create() { return Decoration.none; },
    update(decorations, tr) {
        const builder = new RangeSetBuilder();
        const state = tr.state;
        const modes = state.field(mermaidModeField);

        syntaxTree(state).iterate({
            enter: (node) => {
                if (node.name === "FencedCode") {
                    const startLine = state.doc.lineAt(node.from);
                    const text = state.sliceDoc(node.from, node.to);
                    const match = text.match(/^`{3,}([\w-]+)?/);
                    const lang = match && match[1] ? match[1].toLowerCase() : "";

                    if (lang === 'mermaid') {
                        const mode = modes.get(node.from) || 'code';
                        if (mode === 'preview') {
                            const endLine = state.doc.lineAt(node.to);

                            // 修正: ヘッダー行の直後から「フッター行の末尾(endLine.to)」までを置換範囲にする
                            // これで閉じバッククォート(```)も非表示になります
                            if (startLine.to + 1 < endLine.to) {
                                builder.add(startLine.to + 1, endLine.to, Decoration.replace({
                                    // ウィジェットに渡すコードはフッターの手前まで（中身だけ抽出）
                                    widget: new MermaidWidget(state.sliceDoc(startLine.to + 1, endLine.from)),
                                    block: true
                                }));
                            }
                        }
                    }
                }
            }
        });
        return builder.finish();
    },
    provide: f => EditorView.decorations.from(f)
});

// LaTeX Block ($$...$$) を管理する StateField (新規追加)
// ブロックレベルの置換は ViewPlugin ではなく StateField で行う必要があるため
const latexPreviewField = StateField.define({
    create(state) {
        return buildLatexBlockDecorations(state);
    },
    update(decorations, tr) {
        // ドキュメントが変更されたか、選択範囲が変わった場合（カーソル位置で表示切替するため）に再計算
        if (tr.docChanged || tr.selection) {
            return buildLatexBlockDecorations(tr.state);
        }
        return decorations;
    },
    provide: f => EditorView.decorations.from(f)
});

// LaTeXブロック装飾の構築ロジック
function buildLatexBlockDecorations(state) {
    const builder = new RangeSetBuilder();
    const selection = state.selection.main;
    const doc = state.doc;

    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        // 「$$」のみの行を開始とみなす
        if (/^\s*\$\$\s*$/.test(line.text)) {
            let endLine = null;
            // 終了の「$$」を探す
            for (let j = i + 1; j <= doc.lines; j++) {
                const next = doc.line(j);
                if (/^\s*\$\$\s*$/.test(next.text)) {
                    endLine = next;
                    break;
                }
                // 探索制限（パフォーマンス対策）
                if (j - i > 500) break;
            }

            if (endLine) {
                const from = line.from;
                const to = endLine.to;

                // カーソルがブロック内にあるかチェック
                const isCursorInside = selection.from <= to && selection.to >= from;

                if (!isCursorInside) {
                    const contentStart = line.to + 1;
                    const contentEnd = endLine.from;

                    // 中身がある場合のみウィジェット化
                    if (contentStart < contentEnd) {
                        const latexCode = doc.sliceString(contentStart, contentEnd);
                        builder.add(from, to, Decoration.replace({
                            widget: new LatexWidget(latexCode, true), // true = Block mode
                            block: false // ★修正: ここを false にする（または削除）ことでカーソルが止まるようになります
                        }));
                    }
                }

                // 処理した範囲をスキップ
                i = endLine.number;
            }
        }
    }
    return builder.finish();
}

// ★追加: LaTeXブロックのカーソル移動を制御するキーマップ
const latexKeymap = keymap.of([
    {
        key: "ArrowUp",
        run: (view) => {
            const state = view.state;
            const selection = state.selection.main;
            if (!selection.empty) return false;

            const head = selection.head;
            const line = state.doc.lineAt(head);

            // 1行目の場合は無視
            if (line.number === 1) return false;

            // 1つ上の行を取得
            const prevLine = state.doc.line(line.number - 1);

            // 上の行がLaTeXプレビュー（Decoration）に含まれているかチェック
            const decos = state.field(latexPreviewField);
            let handled = false;

            // prevLineの範囲に重なるDecorationを探す
            decos.between(prevLine.from, prevLine.to, (from, to, value) => {
                // ブロック置換のDecorationが見つかった場合
                // (fromとtoがprevLineを含んでいる、あるいは一致している)
                if (to >= prevLine.to && from <= prevLine.from) {
                    // カーソルをブロックの末尾(to)に移動させる
                    view.dispatch({
                        selection: { anchor: to, head: to },
                        scrollIntoView: true
                    });
                    handled = true;
                    return false; // ループ終了
                }
            });

            return handled;
        }
    },
    {
        key: "ArrowDown",
        run: (view) => {
            const state = view.state;
            const selection = state.selection.main;
            if (!selection.empty) return false;

            const head = selection.head;
            const line = state.doc.lineAt(head);

            // 最終行の場合は無視
            if (line.number === state.doc.lines) return false;

            // 1つ下の行を取得
            const nextLine = state.doc.line(line.number + 1);
            const decos = state.field(latexPreviewField);
            let handled = false;

            decos.between(nextLine.from, nextLine.to, (from, to, value) => {
                if (from <= nextLine.from && to >= nextLine.to) {
                    // 下の行がブロックなら、ブロックの先頭(from)に移動させる
                    view.dispatch({
                        selection: { anchor: from, head: from },
                        scrollIntoView: true
                    });
                    handled = true;
                    return false;
                }
            });

            return handled;
        }
    }
]);

/* ========== Helper Functions & Widgets ========== */

// 言語リスト
const EXISTING_LANGUAGES = [
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
    { label: "Bash", value: "bash" },
    { label: "PowerShell", value: "powershell" },
    { label: "Dockerfile", value: "dockerfile" },
    { label: "Diff", value: "diff" },
    { label: "Lua", value: "lua" },
    { label: "Perl", value: "perl" },
    { label: "R", value: "r" },
    { label: "Dart", value: "dart" },
    { label: "Scala", value: "scala" },
    { label: "Whitespace", value: "whitespace" }
];

// --- 追加言語リスト (A-Z順) ---
const ADDITIONAL_LANGUAGES = [
    { label: "ABAP", value: "abap" },
    { label: "ABNF", value: "abnf" },
    { label: "ActionScript", value: "actionscript" },
    { label: "Ada", value: "ada" },
    { label: "Agda", value: "agda" },
    { label: "AL", value: "al" },
    { label: "ANTLR4", value: "antlr4" },
    { label: "Apache Config", value: "apacheconf" },
    { label: "Apex", value: "apex" },
    { label: "APL", value: "apl" },
    { label: "AppleScript", value: "applescript" },
    { label: "AQL", value: "aql" },
    { label: "Arduino", value: "arduino" },
    { label: "ARFF", value: "arff" },
    { label: "AsciiDoc", value: "asciidoc" },
    { label: "6502 Assembly", value: "asm6502" },
    { label: "ASP.NET (C#)", value: "aspnet" },
    { label: "AutoHotkey", value: "autohotkey" },
    { label: "AutoIt", value: "autoit" },
    { label: "AviSynth", value: "avisynth" },
    { label: "Avro IDL", value: "avro-idl" },
    { label: "BASIC", value: "basic" },
    { label: "Batch", value: "batch" },
    { label: "BBcode", value: "bbcode" },
    { label: "Bicep", value: "bicep" },
    { label: "Bison", value: "bison" },
    { label: "BNF", value: "bnf" },
    { label: "Brainfuck", value: "brainfuck" },
    { label: "BrightScript", value: "brightscript" },
    { label: "Bro", value: "bro" },
    { label: "BSL (1C)", value: "bsl" },
    { label: "CFScript", value: "cfscript" },
    { label: "ChaiScript", value: "chaiscript" },
    { label: "CIL", value: "cil" },
    { label: "Clojure", value: "clojure" },
    { label: "CMake", value: "cmake" },
    { label: "COBOL", value: "cobol" },
    { label: "CoffeeScript", value: "coffeescript" },
    { label: "Concurnas", value: "concurnas" },
    { label: "CSP", value: "csp" },
    { label: "Cooklang", value: "cooklang" },
    { label: "Coq", value: "coq" },
    { label: "Crystal", value: "crystal" },
    { label: "CSV", value: "csv" },
    { label: "CUE", value: "cue" },
    { label: "Cypher", value: "cypher" },
    { label: "D", value: "d" },
    { label: "Dhall", value: "dhall" },
    { label: "Django/Jinja2", value: "django" },
    { label: "DNS Zone File", value: "dns-zone-file" },
    { label: "Docker", value: "docker" },
    { label: "DOT (Graphviz)", value: "dot" },
    { label: "EBNF", value: "ebnf" },
    { label: "EditorConfig", value: "editorconfig" },
    { label: "Eiffel", value: "eiffel" },
    { label: "EJS", value: "ejs" },
    { label: "Elixir", value: "elixir" },
    { label: "Elm", value: "elm" },
    { label: "ERB", value: "erb" },
    { label: "Erlang", value: "erlang" },
    { label: "Excel Formula", value: "excel-formula" },
    { label: "F#", value: "fsharp" },
    { label: "Factor", value: "factor" },
    { label: "Firestore Rules", value: "firestore-security-rules" },
    { label: "Flow", value: "flow" },
    { label: "Fortran", value: "fortran" },
    { label: "FreeMarker", value: "ftl" },
    { label: "G-code", value: "gcode" },
    { label: "GDScript", value: "gdscript" },
    { label: "GEDCOM", value: "gedcom" },
    { label: "Gherkin", value: "gherkin" },
    { label: "Git", value: "git" },
    { label: "GLSL", value: "glsl" },
    { label: "GameMaker", value: "gml" },
    { label: "GN", value: "gn" },
    { label: "Go module", value: "go-module" },
    { label: "Gradle", value: "gradle" },
    { label: "GraphQL", value: "graphql" },
    { label: "Groovy", value: "groovy" },
    { label: "Haml", value: "haml" },
    { label: "Handlebars", value: "handlebars" },
    { label: "Haskell", value: "haskell" },
    { label: "Haxe", value: "haxe" },
    { label: "HCL", value: "hcl" },
    { label: "HLSL", value: "hlsl" },
    { label: "HTTP", value: "http" },
    { label: "IchigoJam", value: "ichigojam" },
    { label: "Icon", value: "icon" },
    { label: "Idris", value: "idris" },
    { label: ".ignore", value: "ignore" },
    { label: "Inform 7", value: "inform7" },
    { label: "Ini", value: "ini" },
    { label: "Io", value: "io" },
    { label: "J", value: "j" },
    { label: "JavaDoc", value: "javadoc" },
    { label: "Jexl", value: "jexl" },
    { label: "Jolie", value: "jolie" },
    { label: "JQ", value: "jq" },
    { label: "JSDoc", value: "jsdoc" },
    { label: "JSON5", value: "json5" },
    { label: "JSONP", value: "jsonp" },
    { label: "JSX", value: "jsx" },
    { label: "Julia", value: "julia" },
    { label: "Keepalived", value: "keepalived" },
    { label: "Keyman", value: "keyman" },
    { label: "KuMir", value: "kumir" },
    { label: "Kusto", value: "kusto" },
    { label: "LaTeX", value: "latex" },
    { label: "Latte", value: "latte" },
    { label: "Less", value: "less" },
    { label: "LilyPond", value: "lilypond" },
    { label: "Liquid", value: "liquid" },
    { label: "Lisp", value: "lisp" },
    { label: "LiveScript", value: "livescript" },
    { label: "LLVM IR", value: "llvm" },
    { label: "Log file", value: "log" },
    { label: "LOLCODE", value: "lolcode" },
    { label: "Magma", value: "magma" },
    { label: "Makefile", value: "makefile" },
    { label: "MATLAB", value: "matlab" },
    { label: "MAXScript", value: "maxscript" },
    { label: "MEL", value: "mel" },
    { label: "Mermaid", value: "mermaid" },
    { label: "MongoDB", value: "mongodb" },
    { label: "Monkey", value: "monkey" },
    { label: "MoonScript", value: "moonscript" },
    { label: "N1QL", value: "n1ql" },
    { label: "NASM", value: "nasm" },
    { label: "NEON", value: "neon" },
    { label: "Nginx", value: "nginx" },
    { label: "Nim", value: "nim" },
    { label: "Nix", value: "nix" },
    { label: "NSIS", value: "nsis" },
    { label: "Objective-C", value: "objectivec" },
    { label: "OCaml", value: "ocaml" },
    { label: "Odin", value: "odin" },
    { label: "OpenCL", value: "opencl" },
    { label: "OpenQasm", value: "openqasm" },
    { label: "Oz", value: "oz" },
    { label: "PARI/GP", value: "parigp" },
    { label: "Parser", value: "parser" },
    { label: "Pascal", value: "pascal" },
    { label: "Pascaligo", value: "pascaligo" },
    { label: "PeopleCode", value: "peoplecode" },
    { label: "PHPDoc", value: "phpdoc" },
    { label: "PlantUML", value: "plant-uml" },
    { label: "PL/SQL", value: "plsql" },
    { label: "PowerQuery", value: "powerquery" },
    { label: "Processing", value: "processing" },
    { label: "Prolog", value: "prolog" },
    { label: "PromQL", value: "promql" },
    { label: ".properties", value: "properties" },
    { label: "Protocol Buffers", value: "protobuf" },
    { label: "Pug", value: "pug" },
    { label: "Puppet", value: "puppet" },
    { label: "Pure", value: "pure" },
    { label: "PureBasic", value: "purebasic" },
    { label: "PureScript", value: "purescript" },
    { label: "Q (kdb+)", value: "q" },
    { label: "QML", value: "qml" },
    { label: "Qore", value: "qore" },
    { label: "Q#", value: "qsharp" },
    { label: "Racket", value: "racket" },
    { label: "Reason", value: "reason" },
    { label: "Regex", value: "regex" },
    { label: "Rego", value: "rego" },
    { label: "Ren'py", value: "renpy" },
    { label: "ReScript", value: "rescript" },
    { label: "reST", value: "rest" },
    { label: "Rip", value: "rip" },
    { label: "Roboconf", value: "roboconf" },
    { label: "Robot Framework", value: "robotframework" },
    { label: "SAS", value: "sas" },
    { label: "Sass (Sass)", value: "sass" },
    { label: "Sass (Scss)", value: "scss" },
    { label: "Scheme", value: "scheme" },
    { label: "Shell session", value: "shell-session" },
    { label: "Smali", value: "smali" },
    { label: "Smalltalk", value: "smalltalk" },
    { label: "Smarty", value: "smarty" },
    { label: "SML", value: "sml" },
    { label: "Solidity", value: "solidity" },
    { label: "Soy", value: "soy" },
    { label: "SPARQL", value: "sparql" },
    { label: "Splunk SPL", value: "splunk-spl" },
    { label: "SQF", value: "sqf" },
    { label: "Squirrel", value: "squirrel" },
    { label: "Stan", value: "stan" },
    { label: "Stylus", value: "stylus" },
    { label: "Systemd", value: "systemd" },
    { label: "T4 (C#)", value: "t4-cs" },
    { label: "T4 (VB)", value: "t4-vb" },
    { label: "TAP", value: "tap" },
    { label: "Tcl", value: "tcl" },
    { label: "Textile", value: "textile" },
    { label: "TOML", value: "toml" },
    { label: "Tremor", value: "tremor" },
    { label: "TSX", value: "tsx" },
    { label: "TT2", value: "tt2" },
    { label: "Turtle", value: "turtle" },
    { label: "Twig", value: "twig" },
    { label: "TypoScript", value: "typoscript" },
    { label: "UnrealScript", value: "unrealscript" },
    { label: "URI", value: "uri" },
    { label: "V", value: "v" },
    { label: "Vala", value: "vala" },
    { label: "VB.Net", value: "vbnet" },
    { label: "Velocity", value: "velocity" },
    { label: "Verilog", value: "verilog" },
    { label: "VHDL", value: "vhdl" },
    { label: "Vim", value: "vim" },
    { label: "Visual Basic", value: "visual-basic" },
    { label: "WarpScript", value: "warpscript" },
    { label: "WebAssembly", value: "wasm" },
    { label: "Web IDL", value: "web-idl" },
    { label: "Wiki markup", value: "wiki" },
    { label: "Wolfram", value: "wolfram" },
    { label: "Wren", value: "wren" },
    { label: "Xeora", value: "xeora" },
    { label: "Xojo", value: "xojo" },
    { label: "XQuery", value: "xquery" },
    { label: "YANG", value: "yang" },
    { label: "Zig", value: "zig" }
];

const LANGUAGE_LIST = [
    ...EXISTING_LANGUAGES,
    ...ADDITIONAL_LANGUAGES
];

// 実行ボタンを表示する言語のリスト
const EXECUTABLE_LANGUAGES = new Set([
    "javascript", "js", "node",
    "typescript", "ts",
    "python", "py",
    "bash", "sh", "zsh", "shell",
    "c", "gcc",
    "cpp", "c++",
    "java",
    "csharp", "cs",
    "php",
    "ruby", "rb",
    "perl", "pl",
    "lua",
    "powershell", "ps1", "pwsh",
    "r",
    "go", "golang",
    "rust", "rs",
    "dart",
    "kotlin", "kt",
    "swift",
    "sql",
    "scala",
    "brainfuck", "bf",
    "whitespace", "ws"
]);

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
        "sh": "Bash", "zsh": "Bash", "shell": "Bash",
        "yml": "YAML",
        "rb": "Ruby",
        "go": "Go",
        "ps1": "PowerShell", "pwsh": "PowerShell",
        "docker": "Dockerfile",
        "gcc": "C",
        "kt": "Kotlin",
        "bf": "Brainfuck",
        "ws": "Whitespace"
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

/* --- <br>タグ用ウィジェット --- */
class BrWidget extends WidgetType {
    toDOM() {
        const br = document.createElement("br");
        return br;
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

        // 画像読み込み完了時にエディタのレイアウトを再計算させる
        img.onload = () => {
            if (view) view.requestMeasure();
        };

        // パス解決ロジック (ローカルファイル対応)
        let imageSrc = this.src;

        // URLが http/https で始まらず、かつデータURIでもない場合
        if (!/^https?:\/\//i.test(imageSrc) && !/^data:/i.test(imageSrc)) {
            // renderer.js で設定した現在のディレクトリパスを取得
            // activeFileDir (ファイルの場所) を優先、なければ currentDir (ルート)
            const currentDir = document.body.dataset.activeFileDir || document.body.dataset.currentDir;

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

/* PdfWidget (PDF全ページ表示・スクロール対応版) */
class PdfWidget extends WidgetType {
    constructor(alt, src, width) {
        super();
        this.alt = alt;
        this.src = src;
        this.width = width;
    }

    eq(other) {
        return this.src === other.src &&
            this.alt === other.alt &&
            this.width === other.width;
    }

    toDOM(view) {
        const wrapper = document.createElement("div");
        wrapper.className = "cm-pdf-wrapper";

        // === スタイル設定: スクロール可能なビューワーにする ===
        wrapper.style.display = "block";
        wrapper.style.position = "relative";
        wrapper.style.backgroundColor = "#525659"; // PDFリーダー風の背景色
        wrapper.style.border = "1px solid #ccc";

        // 高さを固定してスクロールバーを出す
        wrapper.style.height = "500px"; // 高さを少し広めに設定
        wrapper.style.overflow = "hidden"; // iframe内でスクロールさせるため隠す
        wrapper.style.marginBottom = "0px";

        // 幅指定 (デフォルト100%)
        const displayWidth = this.width ? parseInt(this.width) + "px" : "100%";
        wrapper.style.width = displayWidth;
        wrapper.style.maxWidth = "100%";

        // パス解決ロジック
        let fileSrc = this.src;
        if (!/^https?:\/\//i.test(fileSrc) && !/^data:/i.test(fileSrc)) {
            // activeFileDir (ファイルの場所) を優先、なければ currentDir (ルート)
            const currentDir = document.body.dataset.activeFileDir || document.body.dataset.currentDir;
            if (currentDir) {
                // pathモジュールが使えるか確認
                if (typeof path !== 'undefined') {
                    if (!path.isAbsolute(fileSrc)) {
                        const absPath = path.join(currentDir, fileSrc);
                        fileSrc = `file://${absPath.replace(/\\/g, '/')}`;
                    } else {
                        fileSrc = `file://${fileSrc.replace(/\\/g, '/')}`;
                    }
                }
            }
        }

        // iframeを作成してPDFを表示 (Chrome標準ビューア)
        const iframe = document.createElement('iframe');
        iframe.src = fileSrc;
        iframe.style.width = "100%";
        iframe.style.height = "100%";
        iframe.style.border = "none";

        wrapper.appendChild(iframe);

        // リサイズ用ハンドル (幅変更)
        const handle = document.createElement("div");
        handle.className = "cm-image-resize-handle";
        wrapper.appendChild(handle);

        handle.addEventListener("mousedown", (e) => {
            e.preventDefault(); e.stopPropagation();
            const startX = e.clientX;
            const startRect = wrapper.getBoundingClientRect();
            const startWidth = startRect.width;
            let currentWidth = startWidth;

            const onMouseMove = (moveEvent) => {
                const diff = moveEvent.clientX - startX;
                currentWidth = Math.max(200, startWidth + diff);
                wrapper.style.width = `${currentWidth}px`;
            };

            const onMouseUp = () => {
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                this.updateSizeInMarkdown(view, wrapper, Math.round(currentWidth));
            };
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });

        return wrapper;
    }

    updateSizeInMarkdown(view, wrapperDom, newWidth) {
        const pos = view.posAtDOM(wrapperDom);
        if (pos === null) return;

        try {
            const { syntaxTree } = require("@codemirror/language");
            const tree = syntaxTree(view.state);
            let node = tree.resolveInner(pos, 1);
            while (node && node.name !== "Image" && node.name !== "Document") {
                node = node.parent;
            }

            if (node && node.name === "Image") {
                const newAltText = `${this.alt}|${newWidth}`;
                const newText = `![${newAltText}](${this.src})`;

                view.dispatch({
                    changes: { from: node.from, to: node.to, insert: newText }
                });
            }
        } catch (e) {
            console.warn("Resize update skipped:", e);
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

/* --- PlaceholderTextWidget --- */
class PlaceholderTextWidget extends WidgetType {
    constructor(text) {
        super();
        this.text = text;
    }
    eq(other) {
        return other.text === this.text;
    }
    toDOM() {
        const span = document.createElement("span");
        span.textContent = this.text;
        // Admonitionのタイトルが空であることを示すスタイルを適用
        span.style.opacity = "0.6";
        span.style.fontStyle = "italic";
        return span;
    }
    ignoreEvent() { return true; }
}

/* ========== Execution Result Logic ========== */

// 実行結果を追加・削除するためのStateEffect
const setExecutionResult = StateEffect.define();
const clearExecutionResult = StateEffect.define();

// 実行結果表示用ウィジェット
class ExecutionResultWidget extends WidgetType {
    constructor(output, isError, id) {
        super();
        this.output = output;
        this.isError = isError;
        this.id = id;
    }

    eq(other) {
        return other.output === this.output && other.isError === this.isError && other.id === this.id;
    }

    toDOM(view) {
        const div = document.createElement("div");
        div.className = `cm-execution-result ${this.isError ? "error" : ""}`;
        div.style.position = "relative"; // ボタン配置の基準点

        // --- コピーボタン ---
        const copyBtn = document.createElement("button");
        copyBtn.textContent = "Copy";
        copyBtn.title = "結果をコピー";
        // スタイル設定 (CSSファイルを触らずに済むよう直接指定)
        copyBtn.style.position = "absolute";
        copyBtn.style.top = "5px";
        copyBtn.style.right = "30px"; // 閉じるボタンの左隣
        copyBtn.style.background = "transparent";
        copyBtn.style.border = "1px solid rgba(128,128,128,0.3)";
        copyBtn.style.borderRadius = "3px";
        copyBtn.style.cursor = "pointer";
        copyBtn.style.fontSize = "10px";
        copyBtn.style.padding = "2px 6px";
        copyBtn.style.color = "inherit";
        copyBtn.style.opacity = "0.7";

        // クリック時のコピー処理
        copyBtn.onclick = (e) => {
            e.preventDefault();
            navigator.clipboard.writeText(this.output).then(() => {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = "Copied!";
                copyBtn.style.color = "#28a745"; // 緑色でフィードバック
                copyBtn.style.borderColor = "#28a745";

                setTimeout(() => {
                    copyBtn.textContent = originalText;
                    copyBtn.style.color = "inherit";
                    copyBtn.style.borderColor = "rgba(128,128,128,0.3)";
                }, 2000);
            });
        };

        // --- 閉じるボタン ---
        const closeBtn = document.createElement("button");
        closeBtn.className = "cm-execution-close-btn";
        closeBtn.textContent = "×";
        closeBtn.title = "結果を閉じる";

        // 既存CSSがあると思われますが、念のため右上の位置を固定
        closeBtn.style.position = "absolute";
        closeBtn.style.top = "5px";
        closeBtn.style.right = "5px";

        // 固定のIDではなく、クリック時のDOM位置から最新の座標を取得して削除する
        closeBtn.onmousedown = (e) => {
            e.preventDefault();
            // 現在のDOM位置を取得
            const currentPos = view.posAtDOM(div);
            if (currentPos !== null) {
                view.dispatch({
                    effects: clearExecutionResult.of(currentPos)
                });
            }
        };

        // --- コンテンツ ---
        const content = document.createElement("div");
        content.textContent = this.output;
        content.style.whiteSpace = "pre-wrap"; // 改行を維持
        content.style.marginTop = "10px";      // ボタンと重ならないよう余白確保

        div.appendChild(copyBtn);
        div.appendChild(closeBtn);
        div.appendChild(content);
        return div;
    }

    ignoreEvent() { return true; }
}

// 実行結果を管理するStateField
const executionResultField = StateField.define({
    create() { return Decoration.none; },
    update(decorations, tr) {
        decorations = decorations.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(setExecutionResult)) {
                const { pos, output, isError } = effect.value;
                const widget = Decoration.widget({
                    widget: new ExecutionResultWidget(output, isError, pos),
                    block: true,
                    side: 1
                });
                decorations = decorations.update({
                    filter: (from) => from !== pos,
                    add: [widget.range(pos)]
                });
            } else if (effect.is(clearExecutionResult)) {
                decorations = decorations.update({ filter: (from) => from !== effect.value });
            }
        }
        return decorations;
    },
    provide: f => EditorView.decorations.from(f)
});

// --- Mermaid Diagram Widget ---
class MermaidWidget extends WidgetType {
    constructor(code) {
        super();
        this.code = code;
    }

    eq(other) { return this.code === other.code; }

    toDOM(view) {
        const div = document.createElement("div");
        div.className = "cm-mermaid-preview";

        // CSSでスタイル制御するため、JS側でのスタイル指定は最小限に留めるか削除します
        // (前回のCSS修正が適用されていれば、ここはクラスだけで十分機能します)

        div.textContent = "Rendering...";

        // 非同期で描画
        setTimeout(async () => {
            try {
                if (window.mermaid) {
                    const id = 'mermaid-' + Math.random().toString(36).substr(2, 9);
                    const { svg } = await window.mermaid.render(id, this.code);
                    div.innerHTML = svg;

                    // 描画完了後にレイアウト再計算を要求する
                    // これにより、図の高さに合わせて行番号の位置が正しく更新されます
                    if (view) view.requestMeasure();
                } else {
                    div.textContent = "Mermaid library not loaded.";
                }
            } catch (e) {
                div.textContent = "Mermaid Syntax Error";
                div.style.color = "red";
                console.warn(e);
                // エラー表示で行の高さが変わる場合も考慮して再計算
                if (view) view.requestMeasure();
            }
        }, 0);

        return div;
    }

    ignoreEvent() { return true; }
}

/* CodeBlockLanguageWidget (修正版: 検索機能の復活とMermaid/実行機能の維持) */
class CodeBlockLanguageWidget extends WidgetType {
    // コンストラクタ: Mermaid対応のため mode, codeContent を維持
    constructor(lang, mode = 'code', codeContent = '', args = '') {
        super();
        this.lang = lang;
        this.mode = mode; // mermaid用のモード
        this.codeContent = codeContent; // 保存用にコードを保持
        this.args = args;
        this.selectedPath = null;
        this.selectedLabel = "Default";
    }

    eq(other) {
        // 同値判定
        return other.lang === this.lang &&
            other.mode === this.mode &&
            other.codeContent === this.codeContent &&
            other.args === this.args;
    }

    toDOM(view) {
        const container = document.createElement("div");
        container.className = "cm-language-widget-container";

        const normLang = (this.lang || "").toLowerCase();

        // 1. 言語選択ボタン
        const selectBtn = document.createElement("button");
        selectBtn.className = "cm-language-select-btn";
        selectBtn.innerHTML = `<span>${formatLanguageName(this.lang)}</span> <span class="arrow">▼</span>`;
        // ここで検索機能付きの showDropdown を呼び出す
        selectBtn.onmousedown = (e) => { e.preventDefault(); this.showDropdown(view, selectBtn); };
        container.appendChild(selectBtn);

        // 2. Mermaid用モード切替 (既存機能を維持)
        if (normLang === 'mermaid') {
            const btnGroup = document.createElement("div");
            btnGroup.className = "cm-mermaid-mode-group";

            const modes = [
                { val: 'code', label: 'Code' },
                { val: 'preview', label: 'Preview' },
                { val: 'both', label: 'Both' }
            ];

            modes.forEach(m => {
                const btn = document.createElement("button");
                btn.className = "cm-mermaid-mode-btn";
                if (this.mode === m.val) btn.classList.add("active");
                btn.textContent = m.label;

                btn.onmousedown = (e) => {
                    e.preventDefault();
                    if (this.mode === m.val) return;

                    const pos = view.posAtDOM(container);
                    if (pos !== null) {
                        const line = view.state.doc.lineAt(pos);
                        view.dispatch({
                            effects: setMermaidMode.of({ pos: line.from, mode: m.val })
                        });
                    }
                };
                btnGroup.appendChild(btn);
            });
            container.appendChild(btnGroup);

            // 画像保存ボタン
            const saveBtn = document.createElement("button");
            saveBtn.className = "cm-mermaid-mode-btn";
            saveBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`;
            saveBtn.title = "Save as PNG";
            saveBtn.style.marginLeft = "6px";
            saveBtn.style.display = "inline-flex";
            saveBtn.style.alignItems = "center";
            saveBtn.style.justifyContent = "center";
            saveBtn.style.padding = "3px 6px";
            saveBtn.style.borderRadius = "3px";

            saveBtn.onmousedown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.saveMermaidImage();
            };
            container.appendChild(saveBtn);
        }

        // 3. バージョン/環境選択 (Python, Shell系)
        if (['python', 'py', 'bash', 'sh', 'shell', 'zsh'].includes(normLang)) {
            const verBtn = document.createElement("button");
            verBtn.className = "cm-language-select-btn";
            verBtn.style.marginLeft = "4px";
            verBtn.style.color = "#666";
            verBtn.innerHTML = `<span>${this.selectedLabel}</span> <span class="arrow">▼</span>`;
            verBtn.title = "実行環境を選択";
            verBtn.onmousedown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.showVersionDropdown(view, verBtn);
            };
            container.appendChild(verBtn);
        }

        // 4. 引数入力欄 (実行可能な言語の場合)
        if (EXECUTABLE_LANGUAGES.has(normLang)) {
            const argsInput = document.createElement("input");
            argsInput.type = "text";
            argsInput.className = "cm-code-args-input";
            argsInput.placeholder = "Args...";
            argsInput.value = this.args;
            argsInput.spellcheck = false;

            // スタイル設定 (CSSファイルに追加推奨ですが、即時反映のためここに記述)
            argsInput.style.marginLeft = "8px";
            argsInput.style.width = "100px";
            argsInput.style.height = "20px";
            argsInput.style.fontSize = "12px";
            argsInput.style.padding = "0 4px";
            argsInput.style.border = "1px solid #ccc";
            argsInput.style.borderRadius = "3px";
            argsInput.style.backgroundColor = "transparent";
            argsInput.style.color = "inherit";

            // 入力変更時に状態を更新せずDOMだけ保持する（Widget再生成を防ぐため）
            // 必要ならdispatchで更新をかけるが、入力中のちらつきを防ぐため
            // 実行時にDOMから値を取得する方式にします。

            container.appendChild(argsInput);

            // 実行ボタン
            const runBtn = document.createElement("button");
            runBtn.className = "cm-code-copy-btn";
            runBtn.textContent = "▶ Run";
            runBtn.style.marginLeft = "4px";
            runBtn.style.color = "#28a745";
            runBtn.style.fontWeight = "bold";

            runBtn.onmousedown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                // 入力欄から直接値を取得
                const currentArgs = argsInput.value;
                this.runCode(view, container, runBtn, currentArgs);
            };
            container.appendChild(runBtn);
        }

        // 5. コピーボタン
        const copyBtn = document.createElement("button");
        copyBtn.className = "cm-code-copy-btn";
        copyBtn.textContent = "Copy";
        copyBtn.style.marginLeft = "4px";
        copyBtn.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.copyCode(view, container, copyBtn);
        };
        container.appendChild(copyBtn);

        return container;
    }

    // ★修正: 検索機能付きのドロップダウンメニュー (参照コードより適用)
    showDropdown(view, targetBtn) {
        const existing = document.querySelector(".cm-language-dropdown-portal");
        if (existing) existing.remove();

        const dropdown = document.createElement("div");
        dropdown.className = "cm-language-dropdown-portal";

        // 検索ボックスの追加
        const input = document.createElement("input");
        input.className = "cm-language-search";
        input.placeholder = "言語を検索...";

        const list = document.createElement("div");
        list.className = "cm-language-list";

        const performChange = (newLang) => {
            const pos = view.posAtDOM(targetBtn);
            if (pos === null) return;
            let node = syntaxTree(view.state).resolveInner(pos, 1);
            while (node && node.name !== "FencedCode") node = node.parent;
            if (node) {
                const line = view.state.doc.lineAt(node.from);
                const match = line.text.match(/^(\s*`{3,})([\w-]*)/);
                if (match) {
                    view.dispatch({ changes: { from: line.from + match[1].length, to: line.from + match[1].length + match[2].length, insert: newLang } });
                }
            }
        };

        const renderList = (filter = "") => {
            list.innerHTML = "";
            const lower = filter.toLowerCase();
            LANGUAGE_LIST.forEach(item => {
                if (filter && !item.label.toLowerCase().includes(lower) && !item.value.toLowerCase().includes(lower)) return;

                const div = document.createElement("div");
                div.className = "cm-language-item";
                if ((this.lang || "") === item.value) div.classList.add("selected");
                div.innerHTML = `<span class="label">${item.label}</span>${div.classList.contains("selected") ? '<span class="check">✓</span>' : ''}`;

                div.onmousedown = (e) => {
                    e.preventDefault();
                    performChange(item.value);
                    dropdown.remove();
                    document.removeEventListener("mousedown", closer);
                };
                list.appendChild(div);
            });
            if (list.children.length === 0) list.innerHTML = `<div class="cm-language-item empty">見つかりません</div>`;
        };

        renderList();
        input.oninput = (e) => renderList(e.target.value);
        input.onkeydown = (e) => {
            if (e.key === "Enter") {
                const first = list.querySelector(".cm-language-item:not(.empty)");
                if (first) {
                    const evt = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
                    first.dispatchEvent(evt);
                }
            }
        };

        dropdown.append(input, list);
        document.body.appendChild(dropdown);
        const rect = targetBtn.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 4}px`;

        // 画面右端からはみ出さないように調整
        const dw = 220; // CSSで指定されている幅と合わせる
        dropdown.style.left = (rect.left + dw > window.innerWidth - 20) ? `${rect.right - dw}px` : `${rect.left}px`;

        input.focus();

        const closer = (e) => {
            if (!dropdown.contains(e.target) && e.target !== targetBtn && !targetBtn.contains(e.target)) {
                dropdown.remove();
                document.removeEventListener("mousedown", closer);
            }
        };
        setTimeout(() => document.addEventListener("mousedown", closer), 0);
    }

    // Mermaid画像保存処理 (既存のまま)
    async saveMermaidImage() {
        if (!window.mermaid || !this.codeContent.trim()) return;

        try {
            const id = 'mermaid-save-' + Math.random().toString(36).substr(2, 9);
            const { svg } = await window.mermaid.render(id, this.codeContent);

            const parser = new DOMParser();
            const svgDoc = parser.parseFromString(svg, "image/svg+xml");
            const svgEl = svgDoc.documentElement;

            const viewBox = svgEl.getAttribute("viewBox");
            let width, height;

            if (viewBox) {
                const parts = viewBox.split(/[\s,]+/).filter(v => v).map(parseFloat);
                if (parts.length >= 4) {
                    width = parts[2];
                    height = parts[3];
                }
            }

            if (!width || !height) {
                width = parseFloat(svgEl.getAttribute("width")) || 800;
                height = parseFloat(svgEl.getAttribute("height")) || 600;
            }

            svgEl.setAttribute("width", width);
            svgEl.setAttribute("height", height);
            svgEl.style.backgroundColor = "white";

            const serializer = new XMLSerializer();
            const newSvg = serializer.serializeToString(svgEl);

            const svg64 = btoa(unescape(encodeURIComponent(newSvg)));
            const imageSrc = 'data:image/svg+xml;base64,' + svg64;

            const img = new Image();
            img.crossOrigin = "Anonymous";

            img.onload = async () => {
                const canvas = document.createElement("canvas");
                const scale = 2;
                canvas.width = width * scale;
                canvas.height = height * scale;

                const ctx = canvas.getContext("2d");
                ctx.fillStyle = "white";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.scale(scale, scale);
                ctx.drawImage(img, 0, 0, width, height);

                try {
                    const dataUrl = canvas.toDataURL("image/png");
                    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
                    const buffer = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

                    if (window.electronAPI && window.electronAPI.showSaveDialog) {
                        const result = await window.electronAPI.showSaveDialog({
                            defaultPath: "mermaid-diagram.png",
                            filters: [{ name: "PNG Images", extensions: ["png"] }]
                        });

                        if (!result.canceled && result.filePath) {
                            await window.electronAPI.saveFile(result.filePath, buffer);
                        }
                    }
                } catch (err) {
                    console.error("Canvas Export Error:", err);
                    alert("画像の生成に失敗しました。");
                }
            };

            img.onerror = (e) => {
                console.error("Image Load Error:", e);
                alert("SVG画像の読み込みに失敗しました。");
            };

            img.src = imageSrc;

        } catch (e) {
            console.error("Mermaid Render Error:", e);
            alert("Mermaidのレンダリングに失敗しました: " + e.message);
        }
    }

    // 実行環境バージョン選択ドロップダウン (既存のまま)
    async showVersionDropdown(view, targetBtn) {
        const existing = document.querySelector(".cm-language-dropdown-portal");
        if (existing) existing.remove();

        // 読み込み中表示
        const originalLabel = targetBtn.textContent;
        // targetBtn.querySelector('span').textContent = "Loading..."; // UIがちらつく場合はコメントアウト

        let items = [{ label: "Default (System)", path: null }];
        try {
            const v = await window.electronAPI.getLangVersions(this.lang);
            if (v && v.length > 0) items.push(...v);
        } catch (e) { }

        const dropdown = document.createElement("div");
        dropdown.className = "cm-language-dropdown-portal";
        const list = document.createElement("div");
        list.className = "cm-language-list";

        items.forEach(item => {
            const div = document.createElement("div");
            div.className = "cm-language-item";
            div.textContent = item.label;
            div.onmousedown = (e) => {
                e.preventDefault(); e.stopPropagation();
                this.selectedPath = item.path;
                this.selectedLabel = item.label;
                targetBtn.innerHTML = `<span>${item.label}</span> <span class="arrow">▼</span>`;
                dropdown.remove();
            };
            list.appendChild(div);
        });
        dropdown.appendChild(list);
        document.body.appendChild(dropdown);
        const rect = targetBtn.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.style.left = `${rect.left}px`;
        const closer = (e) => { if (!dropdown.contains(e.target) && e.target !== targetBtn) { dropdown.remove(); document.removeEventListener("mousedown", closer); } };
        setTimeout(() => document.addEventListener("mousedown", closer), 0);
    }

    // コード実行処理 (既存のまま)
    async runCode(view, container, btn, args = "") {
        const pos = view.posAtDOM(container);
        if (pos === null) return;
        let node = syntaxTree(view.state).resolveInner(pos, 1);
        while (node && node.name !== "FencedCode") node = node.parent;
        if (node) {
            const startLine = view.state.doc.lineAt(node.from);
            const endLine = view.state.doc.lineAt(node.to);
            const code = view.state.sliceDoc(startLine.to + 1, endLine.from);

            const originalText = btn.textContent;
            btn.textContent = "⏳";
            btn.disabled = true;
            try {
                // ディレクトリパスを取得して実行
                const currentFileDir = document.body.dataset.activeFileDir || null;
                const result = await window.electronAPI.executeCode(code, this.lang, this.selectedPath, currentFileDir, args);
                const output = result.success ? result.stdout : result.stderr;

                view.dispatch({
                    effects: setExecutionResult.of({
                        pos: endLine.to,
                        output: output || "(No output)",
                        isError: !result.success
                    })
                });
            } catch (e) {
                view.dispatch({
                    effects: setExecutionResult.of({
                        pos: endLine.to,
                        output: e.message,
                        isError: true
                    })
                });
            } finally {
                btn.textContent = originalText;
                btn.disabled = false;
            }
        }
    }

    // コードコピー処理 (既存のまま)
    copyCode(view, container, btn) {
        const pos = view.posAtDOM(container);
        if (pos === null) return;
        let node = syntaxTree(view.state).resolveInner(pos, 1);
        while (node && node.name !== "FencedCode") node = node.parent;
        if (node) {
            const startLine = view.state.doc.lineAt(node.from);
            const endLine = view.state.doc.lineAt(node.to);
            const code = view.state.sliceDoc(startLine.to + 1, endLine.from);
            navigator.clipboard.writeText(code).then(() => {
                const original = btn.textContent;
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = original, 2000);
            });
        }
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
        // <a>タグから<div>タグに変更 (二重オープン防止)
        const container = document.createElement("div");
        container.className = "cm-bookmark-widget cm-bookmark-loading";

        container.dataset.href = this.url;

        container.contentEditable = "false";

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

/* LatexWidget (修正版) */
class LatexWidget extends WidgetType {
    constructor(source, displayMode) {
        super();
        this.source = source;
        this.displayMode = displayMode; // true = Block ($$), false = Inline ($)
    }

    eq(other) {
        return this.source === other.source && this.displayMode === other.displayMode;
    }

    toDOM(view) {
        const container = document.createElement("div");

        // クラス設定
        if (this.displayMode) {
            container.className = "cm-latex-block";
        } else {
            container.className = "cm-latex-widget";
        }

        // KaTeXレンダリング
        try {
            katex.render(this.source, container, {
                displayMode: this.displayMode,
                throwOnError: false
            });
        } catch (e) {
            container.textContent = this.source;
            container.style.color = "red";
        }

        // クリックで編集モードに戻る処理
        container.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return; // 左クリックのみ
            e.preventDefault();
            e.stopPropagation();

            const pos = view.posAtDOM(container);
            if (pos !== null) {
                view.dispatch({
                    selection: { anchor: pos, head: pos },
                    scrollIntoView: true
                });
                view.focus();
            }
        });

        // 描画直後に行の高さを再計算させる
        if (view) {
            // 即時実行と、少し待ってからの実行（念のため）
            view.requestMeasure();
            setTimeout(() => view.requestMeasure(), 10);
        }

        return container;
    }

    ignoreEvent() { return true; }
}
/* ========== Decoration Logic ========== */

function buildDecorations(view) {
    const { state } = view;
    const selection = state.selection.main;

    const processedLines = new Set();
    const collectedDecos = [];
    const mermaidModes = state.field(mermaidModeField);

    for (const { from, to } of view.visibleRanges) {
        // 1. テキストベースでのチェック
        for (let pos = from; pos < to;) {
            const line = state.doc.lineAt(pos);
            if (processedLines.has(line.from)) { pos = line.to + 1; continue; }

            const isCursorOnLine = (selection.from <= line.to && selection.to >= line.from);
            const lineText = line.text;

            // インライン数式 ($...$) の処理 (ブロック数式は StateField に移動したため削除)
            const latexInlineRegex = /(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)/g;
            let inlineMatch;
            while ((inlineMatch = latexInlineRegex.exec(lineText)) !== null) {
                const start = line.from + inlineMatch.index;
                const end = start + inlineMatch[0].length;

                // カーソルが範囲内にある場合はプレビューしない
                if (selection.from <= end && selection.to >= start) continue;

                collectedDecos.push({
                    from: start,
                    to: end,
                    side: 1,
                    deco: Decoration.replace({
                        widget: new LatexWidget(inlineMatch[1], false) // false = Inline mode
                    })
                });
            }

            // <br>
            const brRegex = /<br\s*\/?>/gi;
            let brMatch;
            while ((brMatch = brRegex.exec(lineText)) !== null) {
                const start = line.from + brMatch.index;
                const end = start + brMatch[0].length;
                if (!isCursorOnLine) {
                    collectedDecos.push({ from: start, to: end, side: 1, deco: Decoration.replace({ widget: new BrWidget() }) });
                }
            }

            // <img>
            const imgRegex = /<img\s+([^>]+)>/gi;
            let imgMatch;
            while ((imgMatch = imgRegex.exec(lineText)) !== null) {
                const start = line.from + imgMatch.index;
                const end = start + imgMatch[0].length;
                if (selection.from <= end && selection.to >= start) continue;
                const attrs = imgMatch[1];
                const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
                const altMatch = attrs.match(/alt=["']([^"']+)["']/i);
                const widthMatch = attrs.match(/width=["']([^"']+)["']/i);
                if (srcMatch) {
                    const src = srcMatch[1];
                    const alt = altMatch ? altMatch[1] : "";
                    const width = widthMatch ? widthMatch[1].replace('px', '') : null;
                    collectedDecos.push({ from: start, to: end, side: -1, deco: Decoration.replace({ widget: new ImageWidget(alt, src, width) }) });
                }
            }

            // <font>
            const fontRegex = /<font\s+color=["']([^"']+)["']>(.*?)<\/font>/gi;
            let fontMatch;
            while ((fontMatch = fontRegex.exec(lineText)) !== null) {
                const start = line.from + fontMatch.index;
                const end = start + fontMatch[0].length;
                const color = fontMatch[1];
                const content = fontMatch[2];
                const contentStart = start + fontMatch[0].indexOf(content);
                const contentEnd = contentStart + content.length;
                if (selection.from <= end && selection.to >= start) continue;
                collectedDecos.push({ from: start, to: contentStart, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                collectedDecos.push({ from: contentStart, to: contentEnd, side: 1, deco: Decoration.mark({ attributes: { style: `color: ${color}` } }) });
                collectedDecos.push({ from: contentEnd, to: end, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
            }

            // <span>
            const spanRegex = /<span\s+style=["']([^"']+)["']>(.*?)<\/span>/gi;
            let spanMatch;
            while ((spanMatch = spanRegex.exec(lineText)) !== null) {
                const start = line.from + spanMatch.index;
                const end = start + spanMatch[0].length;
                const styleStr = spanMatch[1];
                const content = spanMatch[2];
                const contentStart = start + spanMatch[0].indexOf(content);
                const contentEnd = contentStart + content.length;
                if (selection.from <= end && selection.to >= start) continue;
                collectedDecos.push({ from: start, to: contentStart, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                collectedDecos.push({ from: contentStart, to: contentEnd, side: 1, deco: Decoration.mark({ attributes: { style: styleStr } }) });
                collectedDecos.push({ from: contentEnd, to: end, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
            }

            // インライン装飾タグ
            const styleTags = [
                { tag: 'b', class: 'cm-live-bold' },
                { tag: 'strong', class: 'cm-live-bold' },
                { tag: 'i', class: 'cm-live-em' },
                { tag: 'em', class: 'cm-live-em' },
                { tag: 'u', style: 'text-decoration: underline;' },
                { tag: 's', class: 'cm-live-s' },
                { tag: 'del', class: 'cm-live-s' },
                { tag: 'mark', class: 'cm-live-highlight' },
                { tag: 'sub', style: 'vertical-align: sub; font-size: smaller;' },
                { tag: 'sup', style: 'vertical-align: super; font-size: smaller;' },
                { tag: 'small', style: 'font-size: smaller;' },
                { tag: 'big', style: 'font-size: larger;' },
                { tag: 'kbd', style: 'background-color: #eee; border-radius: 3px; border: 1px solid #b4b4b4; padding: 1px 4px; font-family: monospace; font-size: 0.9em;' },
                { tag: 'var', style: 'font-style: italic; font-family: "Times New Roman", serif;' },
                { tag: 'cite', style: 'font-style: italic; color: #666;' },
                { tag: 'code', style: 'background-color: rgba(0, 0, 0, 0.05); padding: 2px 4px; border-radius: 3px; font-family: monospace; color: #e01e5a;' }
            ];

            // <p align>
            const pAlignRegex = /<p\s+align=["'](left|center|right)["']>(.*?)<\/p>/gi;
            let pMatch;
            while ((pMatch = pAlignRegex.exec(lineText)) !== null) {
                const start = line.from + pMatch.index;
                const end = start + pMatch[0].length;
                const align = pMatch[1];
                const content = pMatch[2];
                const isCursorInTag = (selection.from <= end && selection.to >= start);
                if (!isCursorInTag) {
                    const openTagLength = pMatch[0].indexOf(content);
                    const contentStart = start + openTagLength;
                    const contentEnd = contentStart + content.length;
                    collectedDecos.push({ from: start, to: contentStart, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    collectedDecos.push({ from: contentStart, to: contentEnd, side: 0, deco: Decoration.mark({ attributes: { style: `display: block; text-align: ${align}; width: 100%;` } }) });
                    collectedDecos.push({ from: contentEnd, to: end, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                }
            }

            styleTags.forEach(({ tag, class: className, style }) => {
                const regex = new RegExp(`<${tag}>(.*?)<\\/${tag}>`, 'gi');
                let match;
                while ((match = regex.exec(lineText)) !== null) {
                    const start = line.from + match.index;
                    const end = start + match[0].length;
                    const contentStart = start + match[0].indexOf(match[1]);
                    const contentEnd = contentStart + match[1].length;
                    if (selection.from <= end && selection.to >= start) continue;
                    collectedDecos.push({ from: start, to: contentStart, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    const attrs = {};
                    if (className) attrs.class = className;
                    if (style) attrs.attributes = { style };
                    collectedDecos.push({ from: contentStart, to: contentEnd, side: 1, deco: Decoration.mark(attrs) });
                    collectedDecos.push({ from: contentEnd, to: end, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                }
            });

            // 改ページ
            const pageBreakRegex = /^\s*<div\s+class=["']page-break["']>\s*<\/div>\s*$/i;
            if (pageBreakRegex.test(lineText)) {
                if (!isCursorOnLine) {
                    collectedDecos.push({ from: line.from, to: line.to, side: -1, deco: Decoration.replace({ widget: new PageBreakWidget() }) });
                    processedLines.add(line.from);
                    pos = line.to + 1;
                    continue;
                }
            }

            // ブックマーク
            const bookmarkRegex = /^@card\s+(https?:\/\/[^\s]+)$/;
            const bookmarkMatch = lineText.trim().match(bookmarkRegex);
            if (bookmarkMatch) {
                if (!isCursorOnLine) {
                    collectedDecos.push({ from: line.from, to: line.to, side: -1, deco: Decoration.replace({ widget: new BookmarkWidget(bookmarkMatch[1]) }) });
                    processedLines.add(line.from);
                    pos = line.to + 1;
                    continue;
                }
            }

            // ハイライト (==)
            const highlightRegex = /==([^=]+)==/g;
            let match;
            while ((match = highlightRegex.exec(lineText)) !== null) {
                const start = line.from + match.index;
                const end = start + match[0].length;
                const isCursorIn = (selection.from <= end && selection.to >= start);
                if (!isCursorIn) {
                    collectedDecos.push({ from: start, to: start + 2, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    collectedDecos.push({ from: start + 2, to: end - 2, side: 1, deco: Decoration.mark({ class: "cm-live-highlight" }) });
                    collectedDecos.push({ from: end - 2, to: end, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                }
            }

            pos = line.to + 1;
        }

        // 2. 構文木ベースのチェック (Markdown記法)
        syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
                const n = node.node || node;
                const line = state.doc.lineAt(node.from);

                const isCursorOnLine = (selection.from <= line.to && selection.to >= line.from);
                const isCursorInNode = (selection.from <= node.to && selection.to >= node.from);

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
                    const firstLineText = lineStart.text;

                    // Admonitionの検出: 引用ブロックの1行目が > [!TYPE] 形式かチェック
                    // match[1]: TYPE, match[2]: Title Content (後ろの改行やスペースは含まない)
                    const admonitionMatch = firstLineText.match(/^\s*>\s*\[!(\w+)\]\s*(.*)/i);
                    const isAdmonition = !!admonitionMatch;
                    const admonitionType = isAdmonition ? admonitionMatch[1].toLowerCase() : null;

                    for (let l = lineStart.number; l <= lineEnd.number; l++) {
                        const lineObj = state.doc.line(l);
                        if (processedLines.has(lineObj.from)) continue;
                        if (selection.from <= lineObj.to && selection.to >= lineObj.from) {
                            processedLines.add(lineObj.from);
                            continue;
                        }

                        const lineText = state.doc.sliceString(lineObj.from, lineObj.to);
                        // 行頭の引用マーカー（とそれに続く空白）を取得
                        const markerMatch = lineText.match(/^\s*>\s?/);

                        if (isAdmonition) {
                            // Admonition の処理
                            const isTitleLine = (l === lineStart.number);
                            const className = isTitleLine ? `cm-admonition-title cm-admonition-${admonitionType}` : `cm-admonition-content-line cm-admonition-${admonitionType}`;

                            // 1. 行全体の装飾を適用 (背景色、枠線など)
                            collectedDecos.push({ from: lineObj.from, to: lineObj.from, side: -1, deco: Decoration.line({ class: className }) });

                            if (isTitleLine) {
                                // 【修正A: マーカーとそれに続くスペースを非表示】
                                // > [!TYPE] とそれに続く全てのスペース (タイトルテキストの手前まで) をマッチ
                                const markerAndSpacesMatch = lineText.match(/^(\s*>\s*\[!\w+\]\s*)/i);

                                if (markerAndSpacesMatch) {
                                    const hideStart = lineObj.from;
                                    const hideLength = markerAndSpacesMatch[0].length;
                                    const markerEndPos = hideStart + hideLength;

                                    // 1. マーカー部分を非表示マークで置換
                                    // 注意: Decoration.markは文字を非表示にするだけで、DOM構造には影響を与えません。
                                    collectedDecos.push({
                                        from: hideStart,
                                        to: markerEndPos,
                                        side: 0,
                                        deco: Decoration.mark({ class: "cm-hide-marker" })
                                    });

                                    // 2. タイトルが空の場合 (AdmonitionMatchの第2グループが空かチェック)
                                    const isTitleEmpty = admonitionMatch[2].trim().length === 0;

                                    if (isTitleEmpty) {
                                        // 非表示領域の末尾にウィジェットを挿入
                                        collectedDecos.push({
                                            from: markerEndPos,
                                            to: markerEndPos,
                                            side: 1,
                                            deco: Decoration.widget({
                                                widget: new PlaceholderTextWidget("サンプル"),
                                                side: 1
                                            })
                                        });
                                    }
                                }

                            } else if (markerMatch) {
                                // コンテンツ行の場合: > の部分のみを非表示にする
                                collectedDecos.push({ from: lineObj.from, to: lineObj.from + markerMatch[0].length, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                            }
                        } else {
                            // 通常の引用ブロックの処理 (既存ロジックを維持)
                            collectedDecos.push({ from: lineObj.from, to: lineObj.from, side: -1, deco: Decoration.line({ class: "cm-live-quote" }) });
                            if (markerMatch) {
                                collectedDecos.push({ from: lineObj.from, to: lineObj.from + markerMatch[0].length, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                            }
                        }

                        processedLines.add(lineObj.from);
                    }
                    return true;
                }
                else if (/^ATXHeading[1-6]$/.test(node.name)) {
                    const level = parseInt(node.name.replace("ATXHeading", ""), 10);
                    const headingText = state.doc.sliceString(node.from, node.to);
                    if (!new RegExp(`^#{${level}}\\s`).test(headingText)) { return false; }
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
                    if (!/^\s*([-*+]|\d+\.)\s/.test(lineText)) { return false; }
                    const listMark = n.firstChild;
                    if (!listMark) return true;
                    const indentLevel = calculateIndentLevel(lineText);
                    const indentStyle = `--indent-level: ${indentLevel};`;
                    const taskMarker = n.getChild("TaskMarker");
                    const parent = n.parent;
                    const isOrdered = parent && parent.name === "OrderedList";

                    if (taskMarker) {
                        collectedDecos.push({ from: line.from, to: line.from, side: -1, deco: Decoration.line({ class: "cm-live-task", attributes: { style: indentStyle } }) });
                        if (listMark.name === "ListMark") {
                            collectedDecos.push({ from: line.from, to: listMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                        }
                    } else if (isOrdered) {
                        collectedDecos.push({ from: line.from, to: line.from, side: -1, deco: Decoration.line({ class: "cm-live-ol", attributes: { style: indentStyle } }) });
                        collectedDecos.push({ from: listMark.from, to: listMark.to, side: 0, deco: Decoration.mark({ class: "cm-live-ol-marker" }) });
                        const indentMatch = lineText.match(/^\s*/);
                        if (indentMatch && indentMatch[0].length > 0) {
                            collectedDecos.push({ from: line.from, to: line.from + indentMatch[0].length, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                        }
                    } else {
                        collectedDecos.push({ from: line.from, to: line.from, side: -1, deco: Decoration.line({ class: "cm-live-li", attributes: { style: indentStyle } }) });
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

                    // 既に処理済みの行ならスキップ (ボタン重複防止の決め手)
                    if (processedLines.has(startLine.from)) return false;

                    const match = startLine.text.match(/^(\s*`{3,})([\w-]+)?/);
                    const lang = match && match[2] ? match[2].toLowerCase() : "";

                    if (lang === 'mermaid') {
                        const mode = mermaidModes.get(node.from) || 'code';
                        const codeStart = startLine.to + 1;
                        const codeEnd = endLine.from;
                        const code = state.sliceDoc(codeStart, codeEnd); // コードを取得

                        // ヘッダー (flex-wrap: wrap 追加済み)
                        collectedDecos.push({
                            from: startLine.from,
                            to: startLine.from,
                            side: -1,
                            deco: Decoration.line({
                                class: "cm-code-header",
                                attributes: { style: "flex-wrap: wrap;" }
                            })
                        });

                        collectedDecos.push({ from: startLine.from, to: startLine.to, side: 0, deco: Decoration.mark({ class: "cm-transparent-text" }) });

                        // ★修正: 第3引数に code を渡す
                        collectedDecos.push({
                            from: startLine.to,
                            to: startLine.to,
                            side: 1,
                            deco: Decoration.widget({
                                widget: new CodeBlockLanguageWidget(lang, mode, code), // ここを変更
                                side: 1
                            })
                        });

                        processedLines.add(startLine.from);

                        // コンテンツ
                        if (mode === 'preview') {
                            // ここにあった「行をdisplay:noneにする処理」や「ウィジェット追加」は全て削除します。
                            // すべて mermaidPreviewField 側で行うため、ここでは何もしません。

                            // ただし、エディタ標準のハイライトが干渉しないよう、行だけ「処理済み」にしておきます
                            for (let l = startLine.number + 1; l < endLine.number; l++) {
                                processedLines.add(state.doc.line(l).from);
                            }

                            // フッター行も処理済みにする
                            processedLines.add(endLine.from);
                        } else if (mode === 'both') {
                            // 両方表示：コードの後にインラインウィジェットを追加
                            let relativeLine = 1;
                            for (let l = startLine.number + 1; l < endLine.number; l++) {
                                const lineObj = state.doc.line(l);
                                let attrs = { "data-code-line": String(relativeLine++) };
                                let className = "cm-code-block cm-code-with-linenum";
                                if (isCursorInNode) attrs.style = "background-color: transparent !important;";
                                collectedDecos.push({ from: lineObj.from, to: lineObj.from, side: -1, deco: Decoration.line({ class: className, attributes: attrs }) });
                                processedLines.add(lineObj.from);
                            }

                            // フッター
                            collectedDecos.push({ from: endLine.from, to: endLine.from, side: -1, deco: Decoration.line({ class: "cm-code-footer" }) });
                            collectedDecos.push({ from: endLine.from, to: endLine.to, side: 0, deco: Decoration.mark({ class: "cm-transparent-text" }) });
                            processedLines.add(endLine.from);

                            // グラフ追加 (インラインウィジェット)
                            collectedDecos.push({
                                from: endLine.to, to: endLine.to, side: 1,
                                deco: Decoration.widget({ widget: new MermaidWidget(code), side: 1 })
                            });
                        } else {
                            // Codeモード (既存のまま)
                            let relativeLine = 1;
                            for (let l = startLine.number + 1; l < endLine.number; l++) {
                                const lineObj = state.doc.line(l);
                                let attrs = { "data-code-line": String(relativeLine++) };
                                let className = "cm-code-block cm-code-with-linenum";
                                if (isCursorInNode) attrs.style = "background-color: transparent !important;";
                                collectedDecos.push({ from: lineObj.from, to: lineObj.from, side: -1, deco: Decoration.line({ class: className, attributes: attrs }) });
                                processedLines.add(lineObj.from);
                            }
                            collectedDecos.push({ from: endLine.from, to: endLine.from, side: -1, deco: Decoration.line({ class: "cm-code-footer" }) });
                            collectedDecos.push({ from: endLine.from, to: endLine.to, side: 0, deco: Decoration.mark({ class: "cm-transparent-text" }) });
                            processedLines.add(endLine.from);
                        }

                        return false; // Mermaid処理終了
                    }

                    // 通常のコードブロック処理（既存）
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
                            attrs.style = "background-color: transparent !important;";
                            if (isHeader) className += " cm-code-block-first-active";
                            if (isFooter) className += " cm-code-block-last-active";
                            collectedDecos.push({ from: lineObj.from, to: lineObj.from, side: -1, deco: Decoration.line({ class: className, attributes: attrs }) });
                        } else {
                            if (isHeader) {
                                collectedDecos.push({ from: lineObj.from, to: lineObj.from, side: -1, deco: Decoration.line({ class: "cm-code-header" }) });
                                collectedDecos.push({ from: lineObj.from, to: lineObj.to, side: 0, deco: Decoration.mark({ class: "cm-transparent-text" }) });
                                const match = lineObj.text.match(/^(\s*`{3,})([\w-]+)?/);
                                const lang = match && match[2] ? match[2] : "";
                                collectedDecos.push({ from: lineObj.to, to: lineObj.to, side: 1, deco: Decoration.widget({ widget: new CodeBlockLanguageWidget(lang), side: 1 }) });
                            } else if (isFooter) {
                                collectedDecos.push({ from: lineObj.from, to: lineObj.from, side: -1, deco: Decoration.line({ class: "cm-code-footer" }) });
                                collectedDecos.push({ from: lineObj.from, to: lineObj.to, side: 0, deco: Decoration.mark({ class: "cm-transparent-text" }) });
                            } else {
                                collectedDecos.push({ from: lineObj.from, to: lineObj.from, side: -1, deco: Decoration.line({ class: className, attributes: attrs }) });
                            }
                        }
                        processedLines.add(lineObj.from);
                    }
                    return false;
                }
                else if (node.name === "Image") {
                    if (isCursorInNode) return false;
                    const rawAlt = findLinkText(node, state);
                    const { alt, width } = parseAltText(rawAlt);
                    const urlNode = (typeof n.getChild === "function") ? n.getChild("URL") : null;
                    const src = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : "";
                    let widget;
                    if (src.toLowerCase().endsWith('.pdf')) {
                        widget = new PdfWidget(alt, src, width);
                    } else {
                        widget = new ImageWidget(alt, src, width);
                    }
                    collectedDecos.push({ from: line.from, to: line.to, side: -1, deco: Decoration.replace({ widget: widget }) });
                    processedLines.add(line.from);
                    return false;
                }
                else if (node.name === "Link") {
                    if (isCursorInNode) return false;
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
                else if (node.name === "Strikethrough") {
                    if (isCursorInNode) return;
                    let startMark = (typeof n.getChild === "function") ? n.getChild("StrikethroughMark") : null;
                    let endMark = n.lastChild;
                    if (!startMark || !endMark) return;
                    collectedDecos.push({ from: startMark.from, to: startMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    collectedDecos.push({ from: startMark.to, to: endMark.from, side: 1, deco: Decoration.mark({ class: "cm-live-s" }) });
                    collectedDecos.push({ from: endMark.from, to: endMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                }
                else if (node.name === "StrongEmphasis") {
                    if (isCursorInNode) return;
                    let startMark = (typeof n.getChild === "function") ? n.getChild("EmphasisMark") : null;
                    let endMark = n.lastChild;
                    if (!startMark || !endMark) return;
                    collectedDecos.push({ from: startMark.from, to: startMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                    collectedDecos.push({ from: startMark.to, to: endMark.from, side: 1, deco: Decoration.mark({ class: "cm-live-bold" }) });
                    collectedDecos.push({ from: endMark.from, to: endMark.to, side: 0, deco: Decoration.mark({ class: "cm-hide-marker" }) });
                }
                else if (node.name === "Emphasis") {
                    if (isCursorInNode) return;
                    let startMark = (typeof n.getChild === "function") ? n.getChild("EmphasisMark") : null;
                    let endMark = n.lastChild;
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

// ショートカットキー(Ctrl+Enter)によるコード実行機能
const codeBlockRunKeymap = keymap.of([
    {
        key: "Mod-Enter",
        run: (view) => {
            const state = view.state;
            const selection = state.selection.main;
            const pos = selection.head;

            // カーソル位置のノードを取得
            let node = syntaxTree(state).resolveInner(pos, 1);
            while (node && node.name !== "FencedCode") {
                node = node.parent;
            }

            // コードブロック内にいない場合は何もしない
            if (!node || node.name !== "FencedCode") return false;

            // 言語を取得
            const startLine = state.doc.lineAt(node.from);
            const endLine = state.doc.lineAt(node.to);
            const match = startLine.text.match(/^(\s*`{3,})([\w-]*)/);
            const lang = match && match[2] ? match[2].toLowerCase() : "";

            // 実行可能な言語でなければ何もしない
            if (!EXECUTABLE_LANGUAGES.has(lang)) return false;

            // コード本文を取得
            const codeStart = startLine.to + 1;
            const codeEnd = endLine.from;
            if (codeStart >= codeEnd) return false;

            const code = state.sliceDoc(codeStart, codeEnd);

            // 実行処理 (非同期)
            (async () => {
                try {
                    // "Running..." 表示
                    view.dispatch({
                        effects: setExecutionResult.of({
                            pos: endLine.to,
                            output: "Running...",
                            isError: false
                        })
                    });

                    // Electron API経由で実行
                    const currentFileDir = document.body.dataset.activeFileDir || null;
                    const result = await window.electronAPI.executeCode(code, lang, null, currentFileDir);

                    const output = result.success ? result.stdout : result.stderr;
                    const isError = !result.success || (result.stderr && result.stderr.trim().length > 0);
                    const finalText = output || (result.success ? "(No output)" : "(Unknown error)");

                    // 結果を表示
                    view.dispatch({
                        effects: setExecutionResult.of({
                            pos: endLine.to,
                            output: finalText,
                            isError: isError
                        })
                    });

                } catch (e) {
                    view.dispatch({
                        effects: setExecutionResult.of({
                            pos: endLine.to,
                            output: `Execution Error: ${e.message}`,
                            isError: true
                        })
                    });
                }
            })();

            return true;
        }
    }
]);

const plugin = ViewPlugin.define(
    (view) => ({
        decorations: buildDecorations(view),
        update(update) {
            // 修正: Mermaidのモード変更エフェクトがあった場合も再描画対象にする
            const mermaidModeChanged = update.transactions.some(tr =>
                tr.effects.some(e => e.is(setMermaidMode))
            );

            if (update.docChanged || update.viewportChanged || update.selectionSet || mermaidModeChanged) {
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
                    // href ではなく data-href を取得する
                    const url = bookmarkElement.getAttribute("data-href");

                    if (url && window.electronAPI && window.electronAPI.openExternal) {
                        window.electronAPI.openExternal(url);
                    }
                }
            }
        }
    }
);

exports.livePreviewPlugin = [plugin, codeBlockAutoClose, Prec.highest(codeBlockRunKeymap), executionResultField, mermaidModeField, mermaidPreviewField, latexPreviewField, Prec.highest(latexKeymap)];