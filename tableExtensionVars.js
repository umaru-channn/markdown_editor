const {
    EditorView,
    Decoration,
    WidgetType,
    keymap
} = require('@codemirror/view');
const {
    EditorState,
    RangeSetBuilder,
    StateField,
    Prec,
    StateEffect
} = require('@codemirror/state');
const { syntaxTree } = require('@codemirror/language');

// --- ロガー設定 ---
const LOG_STYLES = {
    info: 'color: #00d1b2; font-weight: bold;',
    action: 'color: #3298dc; font-weight: bold;',
    success: 'color: #48c774; font-weight: bold;',
    warn: 'color: #ffdd57; font-weight: bold; background: #333;',
    error: 'color: #ff3860; font-weight: bold; background: #ffe5e5; padding: 4px; border: 1px solid #f00;',
    debug: 'color: #aaa; font-style: italic;'
};

function logInfo(msg, ...args) {
    console.log(`%c[TableExt:INFO] ${msg}`, LOG_STYLES.info, ...args);
}

function logAction(msg, ...args) {
    console.log(`%c[TableExt:ACTION] ${msg}`, LOG_STYLES.action, ...args);
}

function logSuccess(msg, ...args) {
    console.log(`%c[TableExt:OK] ${msg}`, LOG_STYLES.success, ...args);
}

function logWarn(msg, ...args) {
    console.warn(`%c[TableExt:WARN] ${msg}`, LOG_STYLES.warn, ...args);
}

function logError(msg, ...args) {
    console.error(`%c[TableExt:ERROR] ${msg}`, LOG_STYLES.error, ...args);
    if (args.length > 0 && args[0] instanceof Error) {
        console.error(args[0].stack);
    }
}

function logDebug(msg, ...args) {
    console.log(`%c[TableExt:DEBUG] ${msg}`, LOG_STYLES.debug, ...args);
}

console.log('%c TableExtension Loaded (JS Port + Delete Ops) ', 'background: #6e40aa; color: #fff; font-weight: bold; padding: 4px;');

const updateColWidthEffect = StateEffect.define();

const colWidthsField = StateField.define({
    create() { return {}; },
    update(value, tr) {
        const newMap = {};
        if (tr.docChanged) {
            for (const fromKey in value) {
                const oldFrom = Number(fromKey);
                const newFrom = tr.changes.mapPos(oldFrom, 1);
                if (newFrom !== null) newMap[newFrom] = value[oldFrom];
            }
        } else {
            Object.assign(newMap, value);
        }
        for (const effect of tr.effects) {
            if (effect.is(updateColWidthEffect)) {
                const { from, widths } = effect.value;
                newMap[from] = widths;
            }
        }
        return newMap;
    }
});

function serializeTable(headers, aligns, rows) {
    const escape = (s) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

    if (headers.length === 0 && rows.length === 0) return '';

    const colCount = headers.length;
    const resultLines = [];

    const formatLine = (cells) => {
        return '| ' + cells.map(c => c).join(' | ') + ' |';
    };

    resultLines.push(formatLine(headers.map(escape)));

    const safeAligns = Array.from({ length: colCount }, (_, i) => aligns[i] ?? null);

    const delimCells = safeAligns.map((a) => {
        if (a === 'left') return ':---';
        if (a === 'right') return '---:';
        if (a === 'center') return ':---:';
        return '---';
    });
    resultLines.push('| ' + delimCells.join(' | ') + ' |');

    rows.forEach(row => {
        const safeRow = Array.from({ length: colCount }, (_, i) => row[i] ? escape(row[i]) : '');
        resultLines.push(formatLine(safeRow));
    });

    return resultLines.join('\n');
}

function parseTablesInDoc(state) {
    const blocks = [];
    const tree = syntaxTree(state);
    tree.iterate({
        enter: (node) => {
            if (node.name !== 'Table') return;
            const from = node.from;
            const to = node.to;
            const headers = [];
            const aligns = [];
            const rows = [];

            for (let child = node.node.firstChild; child; child = child.nextSibling) {
                const lineText = state.doc.sliceString(child.from, child.to);
                if (child.name === 'TableHeader') {
                    const parts = lineText.split('|').map(s => s.trim());
                    if (parts.length > 0 && parts[0] === '') parts.shift();
                    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
                    headers.push(...parts);
                } else if (child.name === 'TableDelim') {
                    const parts = lineText.split('|').map(s => s.trim());
                    if (parts.length > 0 && parts[0] === '') parts.shift();
                    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
                    parts.forEach(p => {
                        const left = p.startsWith(':');
                        const right = p.endsWith(':');
                        if (left && right) aligns.push('center');
                        else if (left) aligns.push('left');
                        else if (right) aligns.push('right');
                        else aligns.push(null);
                    });
                } else if (child.name === 'TableRow') {
                    const parts = lineText.split('|').map(s => s.trim());
                    if (parts.length > 0 && parts[0] === '') parts.shift();
                    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
                    rows.push(parts);
                }
            }

            blocks.push({ from, to, headers, aligns, rows });
        }
    });
    return blocks;
}

function getTableWidgetContainer(el) {
    if (!el) return null;
    return el.closest('.cm-md-table-widget');
}

function getCellRC(el) {
    const cell = el?.closest('th, td');
    if (!cell) return null;
    const col = cell.cellIndex;
    const rowEl = cell.closest('tr');
    if (!rowEl) return null;
    const head = rowEl.closest('thead');
    if (head) return { row: null, col };
    const tbody = rowEl.closest('tbody');
    if (tbody) {
        const table = rowEl.closest('table');
        const theadRowCount = table?.tHead?.rows.length ?? 0;
        return { row: rowEl.rowIndex - theadRowCount, col };
    }
    return { row: rowEl.rowIndex, col };
}

function getFromFromContainer(container) {
    if (!container || !container.dataset.from) return null;
    return parseInt(container.dataset.from, 10);
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

class TableWidget extends WidgetType {
    constructor(block, widths) {
        super();
        this.block = block;
        this.widths = widths;
        this.container = null;
        this.isOpeningContextMenu = false;
        this.isProgrammaticFocus = false;
        
        // DnDなどの操作中に意図しないBlurコミットを防ぐためのフラグ
        this.isInteracting = false;
        this.isPerformingDelete = false; // 削除操作中フラグ

        this.DELETE_DOUBLE_CLICK_THRESHOLD = 300; // ダブルタップ判定閾値

        this.dragState = {
            type: null,
            fromIndex: -1,
            isDragging: false
        };

        this.selection = {
            type: 'none',
            anchor: null,
            head: null,
            selectedRows: new Set(),
            selectedCols: new Set()
        };

        // バインド
        this.handleDragStart = this.handleDragStart.bind(this);
        this.handleDragOver = this.handleDragOver.bind(this);
        this.handleDragLeave = this.handleDragLeave.bind(this);
        this.handleDrop = this.handleDrop.bind(this);
        this.handleDragEnd = this.handleDragEnd.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseDown = this.handleMouseDown.bind(this);
    }

    eq(other) {
        // 単純比較では再描画のタイミング制御が難しいため、基本的にfalseを返して再描画させる方針
        // ただし、無限ループを防ぐためにblockの中身が変わっていない場合はtrueを返すなど最適化が可能
        // ここでは既存ロジックを踏襲
        return false;
    }

    updateDOM(dom, view) {
        // DOM再利用のためのチェック
        const oldRowCount = parseInt(dom.dataset.rowCount || '0', 10);
        const oldColCount = parseInt(dom.dataset.colCount || '0', 10);
        const newRowCount = this.block.rows.length;
        const newColCount = Math.max(
            this.block.headers.length, 
            ...this.block.rows.map(r => r.length)
        );

        if (oldRowCount !== newRowCount || oldColCount !== newColCount) {
            return false; // 構造が変わった場合は再生成
        }

        // 古いWidgetの状態を引き継ぐ
        const oldWidget = dom.cmWidget;
        if (oldWidget) {
            this.selection = { ...oldWidget.selection };
            // Setは参照渡しだと共有されてしまうためコピー
            if (this.selection.selectedRows) {
                this.selection.selectedRows = new Set(this.selection.selectedRows);
            }
            if (this.selection.selectedCols) {
                this.selection.selectedCols = new Set(this.selection.selectedCols);
            }
        }

        dom.cmWidget = this;
        this.container = dom;

        // ヘッダーとボディの内容のみ更新
        const table = dom.querySelector('table');
        if (!table) return false;

        // Header Update
        const thead = table.querySelector('thead');
        if (thead && thead.rows.length > 0) {
            const headerRow = thead.rows[0];
            for (let i = 0; i < headerRow.cells.length; i++) {
                const cell = headerRow.cells[i];
                const newText = this.block.headers[i] ?? '';
                // フォーカス中のセルは書き換えない（入力が飛ぶのを防ぐ）
                if (document.activeElement !== cell && cell.querySelector('.cm-cell-content').textContent !== newText) {
                    cell.querySelector('.cm-cell-content').textContent = newText;
                }
            }
        }

        // Body Update
        const tbody = table.querySelector('tbody');
        if (tbody) {
            for (let r = 0; r < tbody.rows.length; r++) {
                const row = tbody.rows[r];
                for (let c = 0; c < row.cells.length; c++) {
                    const cell = row.cells[c];
                    const newText = this.block.rows[r]?.[c] ?? '';
                    if (document.activeElement !== cell && cell.querySelector('.cm-cell-content').textContent !== newText) {
                        cell.querySelector('.cm-cell-content').textContent = newText;
                    }
                }
            }
        }

        dom.dataset.from = this.block.from.toString();
        this.updateSelectionStyles(); // 選択状態のスタイルを適用
        return true;
    }

    // --- DnD Handlers --- (省略なしで記述)

    handleDragStart(e, type, index) {
        logAction(`Drag Start: Type=${type}, Index=${index}`);
        e.stopPropagation();

        this.isInteracting = true;
        this.dragState = {
            type,
            fromIndex: index,
            isDragging: true
        };
        e.dataTransfer.effectAllowed = 'move';
        // データをセットしないとFirefoxなどでドラッグが開始されない場合がある
        e.dataTransfer.setData('application/x-cm-table-dnd', JSON.stringify({ type, index, from: this.block.from }));

        if (this.container) {
            this.container.classList.add('cm-table-dragging-active');
        }
    }

    handleDragOver(e, type, index) {
        if (!this.dragState.isDragging || this.dragState.type !== type) return;

        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        this.clearDropHighlights();

        if (this.dragState.fromIndex === index) return;

        const target = e.currentTarget;
        if (type === 'col') {
            const cell = target.closest('th, td');
            if (cell) cell.classList.add('cm-drop-target');
        } else {
            const tr = target.closest('tr');
            if (tr) tr.classList.add('cm-drop-target');
        }
    }

    handleDragLeave(e) {
        const target = e.currentTarget;
        target.classList.remove('cm-drop-target');
        const tr = target.closest('tr');
        if (tr) tr.classList.remove('cm-drop-target');
    }

    clearDropHighlights() {
        if (!this.container) return;
        const highlights = this.container.querySelectorAll('.cm-drop-target');
        highlights.forEach(el => el.classList.remove('cm-drop-target'));
    }

    handleDrop(e, view, type, toIndex) {
        e.preventDefault();
        e.stopPropagation();
        this.clearDropHighlights();

        if (!this.dragState.isDragging || this.dragState.type !== type) {
            this.isInteracting = false;
            return;
        }

        const fromIndex = this.dragState.fromIndex;
        if (fromIndex === toIndex) {
            logInfo('Drop canceled: Dropped on same index');
            this.isInteracting = false;
            return;
        }

        logAction(`Drop Executed: ${type} from ${fromIndex} -> to ${toIndex}`);

        try {
            if (type === 'col') {
                this.moveColumn(view, fromIndex, toIndex);
            } else {
                this.moveRow(view, fromIndex, toIndex);
            }
        } catch (err) {
            logError('Drop Error', err);
        } finally {
            this.dragState = { type: null, fromIndex: -1, isDragging: false };
            if (this.container) this.container.classList.remove('cm-table-dragging-active');
            setTimeout(() => {
                this.isInteracting = false;
            }, 200);
        }
    }

    handleDragEnd(_e) {
        this.clearDropHighlights();
        this.dragState = { type: null, fromIndex: -1, isDragging: false };
        if (this.container) this.container.classList.remove('cm-table-dragging-active');
        setTimeout(() => {
            this.isInteracting = false;
        }, 200);
    }

    // --- Move Logic ---

    moveColumn(view, from, to) {
        const fromPos = getFromFromContainer(this.container);
        if (fromPos === null) return;

        const block = this.getBlockAtFrom(view.state, fromPos) ?? this.block;

        const moveArrayItem = (arr, fromIdx, toIdx) => {
            const clone = [...arr];
            if (fromIdx < 0 || fromIdx >= clone.length) return clone;
            const safeTo = Math.max(0, Math.min(toIdx, clone.length - 1));
            if (fromIdx === safeTo) return clone;
            const [item] = clone.splice(fromIdx, 1);
            clone.splice(safeTo, 0, item);
            return clone;
        };

        try {
            const newHeaders = moveArrayItem(block.headers, from, to);
            const fullAligns = [...block.aligns];
            while (fullAligns.length < block.headers.length) fullAligns.push(null);
            const newAligns = moveArrayItem(fullAligns, from, to);

            const newRows = block.rows.map((row) => {
                const fullRow = [...row];
                while (fullRow.length < block.headers.length) fullRow.push('');
                return moveArrayItem(fullRow, from, to);
            });

            let newWidths = null;
            if (this.widths && this.widths.length > 0) {
                const fullWidths = [...this.widths];
                while (fullWidths.length < block.headers.length) fullWidths.push(100);
                newWidths = moveArrayItem(fullWidths, from, to);
            }

            const updated = { ...block, headers: newHeaders, aligns: newAligns, rows: newRows };
            logSuccess(`Applied column move.`);

            this.dispatchReplace(view, fromPos, updated, newWidths, (latestFrom) => {
                const targetCol = Math.max(0, Math.min(to, newHeaders.length - 1));
                this.focusCellAt(view, latestFrom ?? fromPos, null, targetCol);
            });
        } catch (e) {
            logError('moveColumn error', e);
        }
    }

    moveRow(view, from, to) {
        const fromPos = getFromFromContainer(this.container);
        if (fromPos === null) return;

        const block = this.getBlockAtFrom(view.state, fromPos) ?? this.block;
        if (from < 0 || from >= block.rows.length) return;

        const safeTo = Math.max(0, Math.min(to, block.rows.length - 1));

        try {
            const newRows = [...block.rows];
            const [movedRow] = newRows.splice(from, 1);
            newRows.splice(safeTo, 0, movedRow);

            const updated = { ...block, rows: newRows };
            logSuccess('Applied row move.');
            this.dispatchReplace(view, fromPos, updated, null, (latestFrom) => {
                this.focusCellAt(view, latestFrom ?? fromPos, safeTo, 0);
            });
        } catch (e) {
            logError('moveRow error', e);
        }
    }

    // --- Event Handling ---

    ignoreEvent(event) {
        if (event.type === 'keydown') {
            const key = event.key;
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'PageUp', 'PageDown', 'Home', 'End'].includes(key)) return false;
            if (key === 'Enter') return true;
            // Delete/BackspaceはprocessKeyDownで処理するため、ここではtrue(CMに渡さない)
            if (key === 'Delete' || key === 'Backspace') return true;
            if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return true;
            return false;
        }
        if (event.type === 'mousedown') {
            const target = event.target;
            if (target.classList.contains('cm-drag-handle') || target.classList.contains('cm-table-resizer')) {
                return true;
            }
            return true; // セル選択などはMouseDownで行うが、CMのSelection制御と競合しないようにする
        }
        if (event.type === 'copy') return true;
        return true;
    }

    // キーイベントハンドラ (toDOMで登録)
    processKeyDown(event, view) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
            if (this.selection.type !== 'none') {
                event.preventDefault();
                event.stopPropagation();
                this.performCopy(view);
            }
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            // ★修正: 単一セル選択かつ編集中(フォーカスがある)場合は、デフォルトの文字削除動作を優先する
            const isSingleCell = this.selection.type === 'rect' && 
                                 this.selection.selectedRows.size === 1 && 
                                 this.selection.selectedCols.size === 1;
            
            // 現在のアクティブ要素がこのテーブルウィジェット内にあり、かつセル(td, th)の内部であることを確認
            const activeEl = document.activeElement;
            const isActiveInTable = activeEl && this.container && this.container.contains(activeEl);
            
            // activeElementがcontentEditableなセル自身、またはその内部要素である場合
            const isEditing = isActiveInTable && (
                activeEl.tagName === 'TD' || activeEl.tagName === 'TH' || activeEl.closest('td, th')
            );

            if (isSingleCell && isEditing) {
                // 文字削除を許可するため、何もしない（ブラウザのデフォルト動作に任せる）
                return;
            }

            if (this.selection.type !== 'none') {
                event.preventDefault();
                event.stopPropagation();

                const dom = this.container;
                if (!dom) return;

                if (dom.deleteTimer) {
                    // 2回目: 構造的な削除（行・列削除）
                    logAction('Double Delete Detected -> Structure Delete');
                    clearTimeout(dom.deleteTimer);
                    dom.deleteTimer = undefined;

                    const cachedSelection = dom.pendingDeleteSelection;
                    if (cachedSelection) {
                        this.selection = cachedSelection;
                    }

                    this.performDelete(view, 'structure');
                    dom.pendingDeleteSelection = undefined;

                } else {
                    // 1回目: コンテンツ削除 (待機)
                    logInfo('First Delete -> Waiting...');

                    // 選択状態を保存
                    dom.pendingDeleteSelection = {
                        ...this.selection,
                        selectedRows: new Set(this.selection.selectedRows),
                        selectedCols: new Set(this.selection.selectedCols)
                    };

                    dom.deleteTimer = window.setTimeout(() => {
                        logInfo('Timeout -> Single Delete (Content Clear)');
                        dom.deleteTimer = undefined;
                        dom.pendingDeleteSelection = undefined;

                        this.performDelete(view, 'content');
                    }, this.DELETE_DOUBLE_CLICK_THRESHOLD);
                }
            }
        }

        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab'].includes(event.key)) {
            this.clearSelection();
        }
    }

    processCopy(e, view) {
        if (this.selection.type === 'none') return;
        e.preventDefault();
        e.stopPropagation();
        this.performCopy(view);
    }

    performCopy(view) {
        if (!this.container) return;
        const currentFrom = getFromFromContainer(this.container);
        if (currentFrom === null) return;

        if (this.selection.type === 'none' || this.selection.selectedRows.size === 0) return;
        const currentBlock = this.getBlockAtFrom(view.state, currentFrom);
        if (!currentBlock) return;

        const targetRows = Array.from(this.selection.selectedRows).sort((a, b) => a - b);
        const targetCols = Array.from(this.selection.selectedCols).sort((a, b) => a - b);

        const safeHeaders = currentBlock.headers || [];
        const safeAligns = currentBlock.aligns || [];
        const safeRows = currentBlock.rows || [];

        const hasOriginalHeader = targetRows.includes(-1);
        const dataRowsIndices = targetRows.filter(r => r >= 0);

        const extractCols = (row) => targetCols.map(c => row && row[c] ? row[c] : '');
        const newAligns = targetCols.map(c => safeAligns[c] ?? null);

        let newRows = dataRowsIndices.map(r => extractCols(safeRows[r]));
        let newHeaders = [];

        if (hasOriginalHeader) {
            newHeaders = extractCols(safeHeaders);
        } else if (newRows.length > 0) {
            newHeaders = newRows[0];
            newRows = newRows.slice(1);
        } else {
            newHeaders = targetCols.map(() => '');
        }

        let markdownTable = serializeTable(newHeaders, newAligns, newRows);
        // クリップボードにコピー
        if (navigator.clipboard) {
            navigator.clipboard.writeText(markdownTable).then(() => {
                logSuccess('Copied table selection to clipboard');
            }).catch(err => {
                logError('Failed to write to clipboard', err);
            });
        }
    }

    performDelete(view, mode) {
        if (!this.container) return;
        const currentFrom = getFromFromContainer(this.container);
        if (currentFrom === null) return;

        if (this.selection.type === 'none' || this.selection.selectedRows.size === 0) return;

        this.isPerformingDelete = true; // 削除操作中フラグ

        // フォーカスを外してコミットを防ぐ
        if (document.activeElement && this.container.contains(document.activeElement)) {
            document.activeElement.blur();
        }

        const currentSelection = { ...this.selection };
        let targetRows = [];
        let targetCols = [];

        // 選択範囲の正規化
        if (currentSelection.type === 'rect' && currentSelection.anchor && currentSelection.head) {
            const r1 = currentSelection.anchor.row;
            const r2 = currentSelection.head.row;
            const c1 = currentSelection.anchor.col;
            const c2 = currentSelection.head.col;

            const rStart = (r1 === null ? -1 : r1);
            const rEnd = (r2 === null ? -1 : r2);

            const minR = Math.min(rStart, rEnd);
            const maxR = Math.max(rStart, rEnd);
            const minC = Math.min(c1, c2);
            const maxC = Math.max(c1, c2);

            for (let r = minR; r <= maxR; r++) targetRows.push(r);
            for (let c = minC; c <= maxC; c++) targetCols.push(c);

            targetRows.sort((a, b) => a - b);
            targetCols.sort((a, b) => a - b);

            // 1セルだけのRect選択の場合
            if (r1 === r2 && c1 === c2 && targetRows.length > 1) {
                targetRows = [rStart];
                targetCols = [c1];
            }
        } else {
            targetRows = Array.from(currentSelection.selectedRows).map(Number).sort((a, b) => a - b);
            targetCols = Array.from(currentSelection.selectedCols).map(Number).sort((a, b) => a - b);
        }

        if (mode === 'structure') {
            this.clearSelection();
        }

        const currentBlock = this.getBlockAtFrom(view.state, currentFrom);
        if (!currentBlock) {
            this.isPerformingDelete = false;
            return;
        }

        if (mode === 'content') {
            // 内容クリア
            const newHeaders = [...currentBlock.headers];
            const newRows = currentBlock.rows.map(r => [...r]);

            for (const r of targetRows) {
                for (const c of targetCols) {
                    if (r === -1) {
                        if (newHeaders[c] !== undefined) newHeaders[c] = '';
                    } else {
                        if (newRows[r] && newRows[r][c] !== undefined) newRows[r][c] = '';
                    }
                }
            }

            const updated = { ...currentBlock, headers: newHeaders, rows: newRows };
            this.dispatchReplace(view, currentFrom, updated, null, (latestFrom) => {
                this.isPerformingDelete = false;
                if (targetRows.length > 0 && targetCols.length > 0) {
                    requestAnimationFrame(() => {
                        this.focusCellAt(view, latestFrom ?? currentFrom, targetRows[0], targetCols[0]);
                    });
                }
            });

        } else {
            // 構造削除 (行/列の削除)
            let newHeaders = [...currentBlock.headers];
            let newAligns = [...currentBlock.aligns];
            let newRows = currentBlock.rows.map(r => [...r]);
            let newWidths = null;
            const currentWidths = (view.state.field(colWidthsField) ?? {})[currentFrom];
            if (currentWidths) newWidths = [...currentWidths];

            // Rect選択が全行をカバーしている場合、列削除とみなす
            const isRectCoveringAllRows = (
                currentSelection.type === 'rect' &&
                targetRows.length >= (currentBlock.rows.length + 1) // ヘッダー + ボディ全行
            );

            if (currentSelection.type === 'col' || isRectCoveringAllRows) {
                // 列削除
                const reversedCols = [...targetCols].sort((a, b) => b - a);
                reversedCols.forEach(c => {
                    newHeaders.splice(c, 1);
                    newAligns.splice(c, 1);
                    newRows.forEach(row => row.splice(c, 1));
                    if (newWidths) newWidths.splice(c, 1);
                });
            } else {
                // 行削除
                const reversedRows = [...targetRows].sort((a, b) => b - a);
                reversedRows.forEach(r => {
                    if (r === -1) {
                        // ヘッダー行の完全削除はMarkdownテーブルとして成立しないため、中身クリアのみ
                        newHeaders.fill('');
                    } else {
                        if (r >= 0 && r < newRows.length) {
                            newRows.splice(r, 1);
                        }
                    }
                });
            }

            const updated = { ...currentBlock, headers: newHeaders, aligns: newAligns, rows: newRows };
            this.dispatchReplace(view, currentFrom, updated, newWidths, (latestFrom) => {
                this.clearSelection();
                this.isPerformingDelete = false;
                requestAnimationFrame(() => {
                    // 行削除後、行が残っていれば0行目に、なければヘッダーにフォーカス
                    const focusRow = updated.rows.length > 0 ? 0 : -1;
                    this.focusCellAt(view, latestFrom ?? currentFrom, focusRow, 0);
                });
            });
        }
    }

    // 編集内容をStateに反映 (同期的に実行するように修正)
    dispatchReplace(view, originFrom, updated, newWidths = null, after) {
        logDebug(`dispatchReplace: originFrom=${originFrom}`);

        const latestBlock = parseTablesInDoc(view.state).find(b => b.from === originFrom);

        if (!latestBlock) {
            logWarn('dispatchReplace: Block not found at', originFrom);
            return;
        }

        const newText = serializeTable(updated.headers, updated.aligns, updated.rows);
        const changes = { from: latestBlock.from, to: latestBlock.to, insert: newText };

        // 先にトランザクションを作成して位置マッピングを取得
        const tempTr = view.state.update({ changes });
        const newFrom = tempTr.changes.mapPos(latestBlock.from, 1);

        const finalSpec = {
            changes,
            effects: (newWidths && newFrom !== null) ? updateColWidthEffect.of({ from: newFrom, widths: newWidths }) : []
        };

        // 同期的にディスパッチ
        try {
            view.dispatch(finalSpec);
        } catch (e) {
            logError('dispatchReplace error', e);
            return;
        }

        if (after) {
            requestAnimationFrame(() => after(newFrom ?? latestBlock.from));
        }
    }

    focusCellAt(view, from, row, col) {
        // コンテナを探してフォーカス
        // DOM更新直後はまだ要素がない場合があるため、少し待つ（ポーリング）
        let retries = 0;
        const poll = () => {
            const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`);
            if (container) {
                const success = this.doFocus(container, row, col);
                if (!success) {
                    retries++;
                    if (retries < 20) requestAnimationFrame(poll);
                }
            } else {
                retries++;
                if (retries < 20) requestAnimationFrame(poll);
            }
        };
        poll();
    }

    doFocus(container, row, col) {
        let target = null;
        try {
            if (row == null || row < 0) {
                target = container.querySelector(`thead tr > :nth-child(${col + 1})`);
            } else {
                const tr = container.querySelector(`tbody tr:nth-child(${row + 1})`);
                if (tr) target = tr.children[col];
            }

            if (target) {
                this.isProgrammaticFocus = true;
                target.focus({ preventScroll: false });

                // キャレットをコンテンツスパン内の末尾に配置
                // ドラッグハンドルやリサイザーではなく、実際のテキストコンテンツ内にキャレットを置く
                const contentSpan = target.querySelector('.cm-cell-content');
                // コンテンツスパンがあればその中に、なければセル全体にキャレットを配置
                const focusTarget = contentSpan || (target.firstChild || target.textContent ? target : null);
                if (focusTarget) {
                    const s = window.getSelection();
                    if (s) {
                        const r = document.createRange();
                        r.selectNodeContents(focusTarget);
                        r.collapse(false); // 末尾に移動
                        s.removeAllRanges();
                        s.addRange(r);
                    }
                }
                target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                return true;
            }
        } catch (e) {
            logError('doFocus error', e);
        }
        return false;
    }

    getBlockAtFrom(state, from) {
        const blocks = parseTablesInDoc(state);
        return blocks.find(b => b.from === from) ?? null;
    }

    // --- Selection & Mouse Handling ---
    clearSelection() {
        if (this.selection.type !== 'none') {
            this.selection = { type: 'none', anchor: null, head: null, selectedRows: new Set(), selectedCols: new Set() };
            this.updateSelectionStyles();
        }
    }

    updateSelectionRange() {
        if (!this.selection.anchor || !this.selection.head) return;
        const r1 = this.selection.anchor.row;
        const c1 = this.selection.anchor.col;
        const r2 = this.selection.head.row;
        const c2 = this.selection.head.col;
        const rStart = (r1 === null ? -1 : r1);
        const rEnd = (r2 === null ? -1 : r2);
        const minR = Math.min(rStart, rEnd);
        const maxR = Math.max(rStart, rEnd);
        const minC = Math.min(c1, c2);
        const maxC = Math.max(c1, c2);

        this.selection.selectedRows.clear();
        this.selection.selectedCols.clear();

        if (this.selection.type === 'rect') {
            for (let r = minR; r <= maxR; r++) this.selection.selectedRows.add(r);
            for (let c = minC; c <= maxC; c++) this.selection.selectedCols.add(c);
        }
        else if (this.selection.type === 'row') {
            const colCount = Math.max(this.block.headers.length, ...this.block.rows.map(r => r.length));
            for (let c = 0; c < colCount; c++) this.selection.selectedCols.add(c);
            for (let r = minR; r <= maxR; r++) this.selection.selectedRows.add(r);
        }
        else if (this.selection.type === 'col') {
            const rowCount = this.block.rows.length;
            this.selection.selectedRows.add(-1);
            for (let r = 0; r < rowCount; r++) this.selection.selectedRows.add(r);
            for (let c = minC; c <= maxC; c++) this.selection.selectedCols.add(c);
        }
        this.updateSelectionStyles();
    }

    updateSelectionStyles() {
        if (!this.container) return;
        const table = this.container.querySelector('table');
        if (!table) return;
        const rows = Array.from(table.rows);
        const theadRowCount = table.tHead?.rows.length ?? 0;
        rows.forEach((tr) => {
            const isHeader = tr.parentElement?.tagName === 'THEAD';
            const bodyRowIndex = isHeader ? -1 : tr.rowIndex - theadRowCount;
            Array.from(tr.cells).forEach((cell, cIdx) => {
                let selected = false;
                if (this.selection.type !== 'none') {
                    if (this.selection.selectedRows.has(bodyRowIndex) && this.selection.selectedCols.has(cIdx)) selected = true;
                }
                if (selected) cell.classList.add('cm-table-selected');
                else cell.classList.remove('cm-table-selected');
            });
        });
    }

    startSelection(rc, type) {
        this.selection.type = type;
        this.selection.anchor = rc;
        this.selection.head = rc;
        this.dragState.isDragging = true; // 選択中のドラッグ状態
        this.updateSelectionRange();
    }

    updateDragSelection(rc) {
        if (!this.dragState.isDragging || this.selection.type === 'none') return;
        if (this.selection.head?.row !== rc.row || this.selection.head?.col !== rc.col) {
            this.selection.head = rc;
            this.updateSelectionRange();
        }
    }

    getMouseAction(e) {
        const target = e.target;
        if (target.classList.contains('cm-drag-handle')) {
            return { type: null, index: -1, rc: null };
        }

        const targetCell = target.closest('th, td');
        if (!targetCell) return { type: null, index: -1, rc: null };

        if (target.classList.contains('cm-table-resizer')) return { type: null, index: -1, rc: null };

        const rect = targetCell.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        const rc = getCellRC(targetCell);
        if (!rc) return { type: null, index: -1, rc: null };

        if (e.ctrlKey || e.metaKey) {
            if (targetCell.tagName === 'TH') return { type: 'col', index: rc.col, rc };
            if (rc.row !== null) return { type: 'row', index: rc.row, rc };
        }

        const isHeader = targetCell.tagName === 'TH';
        const isFirstCol = rc.col === 0;

        const COL_SELECT_EDGE = isHeader ? 15 : 0;
        const ROW_SELECT_EDGE = isFirstCol ? 15 : 0;

        if (offsetY < COL_SELECT_EDGE) return { type: 'col', index: rc.col, rc };
        if (offsetX < ROW_SELECT_EDGE) {
            if (rc.row !== null) return { type: 'row', index: rc.row, rc };
        }
        return { type: 'cell', index: -1, rc };
    }

    handleMouseMove(e) {
        if (document.body.classList.contains('cm-table-resizing')) return;
        
        // ドラッグ選択中
        if (this.dragState.isDragging && this.selection.type !== 'none') {
            const target = e.target;
            const targetCell = target.closest('th, td');
            if (targetCell) {
                const rc = getCellRC(targetCell);
                if (rc) {
                    this.updateDragSelection(rc);
                    e.preventDefault();
                }
            }
            return;
        }

        const target = e.target;
        if (target.classList.contains('cm-drag-handle')) {
            target.style.cursor = 'grab';
            return;
        }

        const targetCell = target.closest('th, td');
        if (this.container) this.container.style.cursor = 'default';
        if (targetCell) targetCell.style.cursor = 'text';

        const action = this.getMouseAction(e);
        if (action.type === 'col' && targetCell) targetCell.style.cursor = 's-resize';
        else if (action.type === 'row' && targetCell) targetCell.style.cursor = 'e-resize';
    }

    handleMouseDown(e) {
        if ((e.target).classList.contains('cm-table-resizer')) return;
        if ((e.target).classList.contains('cm-drag-handle')) return;

        if (e.button !== 0) return;

        const action = this.getMouseAction(e);
        const onMouseUp = () => {
            this.dragState.isDragging = false; // ドラッグ終了
            window.removeEventListener('mouseup', onMouseUp);
            if (action.type !== 'cell') {
                this.container?.focus({ preventScroll: true });
            }
        };
        window.addEventListener('mouseup', onMouseUp);

        if (action.type === 'col' && action.rc) {
            this.startSelection(action.rc, 'col');
            e.preventDefault();
            e.stopPropagation();
            this.container?.focus({ preventScroll: true });
        } else if (action.type === 'row' && action.rc) {
            this.startSelection(action.rc, 'row');
            e.preventDefault();
            e.stopPropagation();
            this.container?.focus({ preventScroll: true });
        } else if (action.type === 'cell' && action.rc) {
            this.startSelection(action.rc, 'rect');
        } else {
            this.clearSelection();
        }
    }

    createDragHandle(type, index, view) {
        const handle = document.createElement('div');
        handle.className = `cm-drag-handle cm-drag-handle-${type}`;
        handle.draggable = true;
        handle.contentEditable = 'false';

        handle.addEventListener('dragstart', (e) => this.handleDragStart(e, type, index));
        handle.addEventListener('dragend', this.handleDragEnd);
        return handle;
    }

    createResizer(view, th, colIndex) {
        const resizer = document.createElement('div');
        resizer.className = 'cm-table-resizer';
        resizer.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const container = getTableWidgetContainer(th);
            if (!container) return;

            this.isInteracting = true;

            const table = container.querySelector('table');
            if (!table) return;
            const colgroup = table.querySelector('colgroup');
            if (!colgroup) return;
            const cols = Array.from(colgroup.children);
            const currentWidths = cols.map(c => c.offsetWidth);
            for (let i = 0; i < cols.length; i++) cols[i].style.width = `${currentWidths[i]}px`;

            const startX = e.clientX;
            const startWidth = currentWidths[colIndex];
            table.style.tableLayout = 'fixed';
            table.style.width = 'auto';
            document.body.classList.add('cm-table-resizing');

            const onMouseMove = (e) => {
                const deltaX = e.clientX - startX;
                const newWidth = Math.max(50, startWidth + deltaX);
                cols[colIndex].style.width = `${newWidth}px`;
            };

            const onMouseUp = () => {
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                document.body.classList.remove('cm-table-resizing');
                const finalWidths = cols.map(c => c.offsetWidth);
                const latestFrom = getFromFromContainer(container) ?? this.block.from;

                view.dispatch({
                    effects: updateColWidthEffect.of({ from: latestFrom, widths: finalWidths })
                });

                setTimeout(() => { this.isInteracting = false; }, 100);
            };
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
        return resizer;
    }

    buildCell(
        tag,
        text,
        col,
        row,
        al,
        updateValue,
        view
    ) {
        const el = document.createElement(tag);
        el.style.minWidth = '50px';
        el.style.textAlign = al ?? 'left';
        el.style.padding = '4px 8px';
        el.style.border = '1px solid #ccc';
        el.style.backgroundColor = tag === 'th' ? '#f0f0f0' : '#ffffff';
        el.style.position = 'relative';
        el.style.outline = 'none';

        el.addEventListener('dragover', (e) => {
            if (this.dragState.type === 'col') {
                this.handleDragOver(e, 'col', col);
            } else if (this.dragState.type === 'row' && row !== null) {
                this.handleDragOver(e, 'row', row);
            }
        });

        el.addEventListener('drop', (e) => {
            if (this.dragState.type === 'col') {
                this.handleDrop(e, view, 'col', col);
            } else if (this.dragState.type === 'row' && row !== null) {
                this.handleDrop(e, view, 'row', row);
            }
        });

        el.addEventListener('dragleave', this.handleDragLeave);

        if (tag === 'th') {
            const handle = this.createDragHandle('col', col, view);
            el.appendChild(handle);
        }
        if (tag === 'td' && col === 0 && row !== null) {
            const handle = this.createDragHandle('row', row, view);
            el.appendChild(handle);
        }

        if (tag === 'th') {
            const resizer = this.createResizer(view, el, col);
            el.appendChild(resizer);
        }

        const contentSpan = document.createElement('span');
        contentSpan.className = 'cm-cell-content';
        contentSpan.textContent = text;
        contentSpan.style.display = 'inline-block';
        contentSpan.style.minWidth = '10px';
        contentSpan.style.width = '100%';
        el.appendChild(contentSpan);

        el.contentEditable = 'true';

        el.addEventListener('focus', () => {
            el.style.boxShadow = 'inset 0 0 0 2px #22d3ee';
            this.isProgrammaticFocus = false;
        });

        const extractValue = () => (contentSpan.textContent ?? '').replace(/\r?\n/g, ' ');

        const commit = (after) => {
            // 削除操作中はコミットしない
            if (this.isPerformingDelete) return;

            const container = getTableWidgetContainer(el);
            const domFrom = getFromFromContainer(container);
            if (domFrom === null) return;

            const latestBlock = this.getBlockAtFrom(view.state, domFrom);
            if (!latestBlock) return;

            const currentValue = (tag === 'th' ? latestBlock.headers[col] : (latestBlock.rows[row]?.[col] ?? ''));
            const newValue = extractValue();

            if (currentValue === newValue) {
                if (after) setTimeout(() => after(latestBlock.from), 0);
                return;
            }
            updateValue(newValue, after, domFrom);
        }

        el.addEventListener('blur', (e) => {
            el.style.boxShadow = 'none';
            if (this.isProgrammaticFocus) return;
            if (this.isInteracting) return;

            if (this.isOpeningContextMenu) {
                this.isOpeningContextMenu = false;
                return;
            }
            const relatedTarget = e.relatedTarget;
            const container = getTableWidgetContainer(el);
            if (container && relatedTarget && container.contains(relatedTarget)) return;
            if (!el.isConnected) return;
            commit();
        });

        el.addEventListener('keydown', (e) => {
            if (e.isComposing) return;

            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();

                const container = getTableWidgetContainer(el);
                if (!container) return;

                const rowCount = parseInt(container.dataset.rowCount || '0', 10);
                const rc = getCellRC(el);
                if (!rc || rc.row == null) return;

                const currentRow = rc.row;
                const currentCol = rc.col;

                commit((latestFrom) => {
                    if (currentRow < rowCount - 1) {
                        this.focusCellAt(view, latestFrom, currentRow + 1, currentCol);
                    } else {
                        const block = this.getBlockAtFrom(view.state, latestFrom);
                        if (!block) return;
                        const currentCols = Math.max(block.headers.length, ...block.rows.map(r => r.length));
                        const newRow = Array(currentCols).fill('');
                        const updated = { ...block, rows: [...block.rows, newRow] };

                        this.dispatchReplace(view, latestFrom, updated, null, (finalFrom) => {
                            const newRowIndex = rowCount;
                            this.focusCellAt(view, finalFrom ?? latestFrom, newRowIndex, currentCol);
                        });
                    }
                });
                return;
            }

            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
                this.clearSelection();
            }
        });
        return el;
    }

    toDOM(view) {
        const container = document.createElement('div');
        this.container = container;
        // インスタンスをDOMに紐付ける (processKeyDown等で参照するため)
        container.cmWidget = this;

        container.className = 'cm-md-table-widget';
        container.style.padding = '12px';
        container.style.border = '1px dashed #ddd';
        container.style.borderRadius = '4px';
        container.style.margin = '1em 0';
        container.style.overflowX = 'auto';
        container.style.minHeight = '20px';
        container.tabIndex = -1;
        container.style.outline = 'none';

        container.addEventListener('mousemove', this.handleMouseMove);
        container.addEventListener('mousedown', this.handleMouseDown);
        container.addEventListener('copy', (e) => this.processCopy(e, view));
        
        // キーイベントは processKeyDown に委譲
        container.addEventListener('keydown', (e) => this.processKeyDown(e, view));

        container.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const action = this.getMouseAction(e);
            if (action.rc) {
                this.showContextMenu(view, container, action.rc, e.clientX, e.clientY);
            }
        });

        const table = document.createElement('table');
        table.style.borderCollapse = 'collapse';
        table.style.tableLayout = this.widths ? 'fixed' : 'auto';
        table.style.width = this.widths ? 'auto' : '100%';
        table.style.minWidth = '100px';

        const colCount = Math.max(
            this.block.headers.length,
            this.block.aligns.length,
            ...this.block.rows.map(r => r.length)
        );
        container.dataset.from = this.block.from.toString();
        container.dataset.colCount = colCount.toString();
        container.dataset.rowCount = this.block.rows.length.toString();

        const colgroup = document.createElement('colgroup');
        for (let i = 0; i < colCount; i++) {
            const colEl = document.createElement('col');
            if (this.widths && this.widths[i]) colEl.style.width = `${this.widths[i]}px`;
            colgroup.appendChild(colEl);
        }
        table.appendChild(colgroup);

        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        trh.style.backgroundColor = '#f8f8f8';

        const headers = Array.from({ length: colCount }, (_, i) => this.block.headers[i] ?? '');
        const aligns = Array.from({ length: colCount }, (_, i) => this.block.aligns[i] ?? null);

        headers.forEach((text, col) => {
            const onUpdate = (val, after, currentFrom) => {
                const currentBlock = this.getBlockAtFrom(view.state, currentFrom) ?? this.block;
                const newHeaders = headers.map((h, i) => (i === col ? val : h));
                const newAligns = aligns.slice();
                while (newAligns.length < newHeaders.length) newAligns.push(null);
                const updated = { ...currentBlock, headers: newHeaders, aligns: newAligns };

                this.dispatchReplace(view, currentFrom, updated, null, (latestFrom) => {
                    if (after) after(latestFrom ?? currentFrom);
                    else this.focusCellAt(view, latestFrom ?? currentFrom, null, col);
                });
            };

            const th = this.buildCell('th', text, col, null, aligns[col] ?? null, onUpdate, view);
            trh.appendChild(th);
        });
        thead.appendChild(trh);

        const tbody = document.createElement('tbody');
        this.block.rows.forEach((row, rIdx) => {
            const tr = document.createElement('tr');
            for (let c = 0; c < colCount; c++) {
                const onUpdate = (val, after, currentFrom) => {
                    const currentBlock = this.getBlockAtFrom(view.state, currentFrom) ?? this.block;
                    const newRows = currentBlock.rows.map((r, i) => (i === rIdx ? [...r] : r.slice()));
                    if (!newRows[rIdx]) newRows[rIdx] = Array(colCount).fill('');
                    while (newRows[rIdx].length < colCount) newRows[rIdx].push('');
                    newRows[rIdx][c] = val;
                    const updated = { ...currentBlock, rows: newRows };

                    this.dispatchReplace(view, currentFrom, updated, null, (latestFrom) => {
                        if (after) after(latestFrom ?? currentFrom);
                        else this.focusCellAt(view, latestFrom ?? currentFrom, rIdx, c);
                    });
                };

                const td = this.buildCell('td', row[c] ?? '', c, rIdx, aligns[c] ?? null, onUpdate, view);
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        });
        table.appendChild(thead);
        table.appendChild(tbody);
        container.appendChild(table);
        setTimeout(() => this.updateSelectionStyles(), 0);
        return container;
    }

    // --- ContextMenu ---
    showContextMenu(view, container, rc, x, y) {
        this.isOpeningContextMenu = true;
        const from = getFromFromContainer(container);
        if (from === null) return;

        document.querySelectorAll('.cm-table-menu').forEach((m) => m.remove());

        const menu = document.createElement('div');
        menu.className = 'cm-table-menu';
        menu.style.position = 'fixed';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.style.backgroundColor = 'white';
        menu.style.border = '1px solid #ccc';
        menu.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
        menu.style.zIndex = '1000';
        menu.style.padding = '4px 0';
        menu.style.fontFamily = 'sans-serif';
        menu.style.fontSize = '14px';
        menu.style.minWidth = '120px';

        const mkItem = (label, cb, enabled = true) => {
            const it = document.createElement('div');
            it.style.padding = '4px 12px';
            it.style.cursor = enabled ? 'pointer' : 'default';
            it.style.color = enabled ? '#333' : '#aaa';
            it.textContent = label;
            if (enabled) {
                it.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    cb();
                    menu.remove();
                });
                it.addEventListener('mouseenter', () => (it.style.backgroundColor = '#f0f0f0'));
                it.addEventListener('mouseleave', () => (it.style.backgroundColor = 'white'));
            }
            return it;
        };
        const closeOnOutside = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeOnOutside);
            }
        };
        setTimeout(() => document.addEventListener('click', closeOnOutside), 0);

        const rowOpsEnabled = rc.row != null;
        const colOpsEnabled = true;

        menu.appendChild(mkItem('上に行を挿入', () => this.insertRow(view, container, rc.col, rc.row, 'above'), rowOpsEnabled));
        menu.appendChild(mkItem('下に行を挿入', () => this.insertRow(view, container, rc.col, rc.row, 'below'), rowOpsEnabled));
        menu.appendChild(mkItem('行を削除', () => this.deleteRow(view, container, rc.row), rowOpsEnabled));
        const sep = document.createElement('div');
        sep.style.height = '1px';
        sep.style.backgroundColor = '#eee';
        sep.style.margin = '4px 0';
        menu.appendChild(sep);
        menu.appendChild(mkItem('左に列を挿入', () => this.insertCol(view, container, rc.col, rc.row, 'left'), colOpsEnabled));
        menu.appendChild(mkItem('右に列を挿入', () => this.insertCol(view, container, rc.col, rc.row, 'right'), colOpsEnabled));
        menu.appendChild(mkItem('列を削除', () => this.deleteCol(view, container, rc.col), colOpsEnabled));
        document.body.appendChild(menu);
    }

    insertRow(view, container, col, row, where) {
        const from = getFromFromContainer(container);
        if (from === null) return;
        const block = this.getBlockAtFrom(view.state, from) ?? this.block;
        const colCount = Math.max(block.headers.length, ...block.rows.map(r => r.length));
        const at = where === 'above' ? row : row + 1;
        const newRows = block.rows.slice();
        newRows.splice(at, 0, Array(colCount).fill(''));
        const updated = { ...block, rows: newRows };
        this.dispatchReplace(view, from, updated, null, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, at, col));
    }

    deleteRow(view, container, row) {
        const from = getFromFromContainer(container);
        if (from === null) return;
        const block = this.getBlockAtFrom(view.state, from) ?? this.block;
        if (block.rows.length === 0) return;
        const newRows = block.rows.slice();
        
        // ★修正: 削除前にスライスしているので、削除後の配列長に基づいてフォーカス位置を計算する
        // 削除実行
        newRows.splice(row, 1);
        
        // フォーカス計算: 削除した行の1つ上、または同じ位置（末尾でなければ）
        // 行がなくなった場合はヘッダー(-1)へ
        let focusRow = row;
        if (newRows.length === 0) {
            focusRow = -1;
        } else if (focusRow >= newRows.length) {
            focusRow = newRows.length - 1;
        }

        const updated = { ...block, rows: newRows };
        this.dispatchReplace(view, from, updated, null, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, focusRow, 0));
    }

    insertCol(view, container, col, row, where) {
        const from = getFromFromContainer(container);
        if (from === null) return;
        const block = this.getBlockAtFrom(view.state, from) ?? this.block;
        const at = where === 'left' ? col : col + 1;
        const headers = block.headers.slice();
        headers.splice(at, 0, '');
        const aligns = block.aligns.slice();
        aligns.splice(at, 0, null);
        const rows = block.rows.map(r => {
            const nr = r.slice();
            nr.splice(at, 0, '');
            return nr;
        });
        const updated = { ...block, headers, aligns, rows };
        const currentWidths = (view.state.field(colWidthsField) ?? {})[from];
        let newWidths = null;
        if (currentWidths) {
            newWidths = currentWidths.slice();
            newWidths.splice(at, 0, 100);
        }
        this.dispatchReplace(view, from, updated, newWidths, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, row, at));
    }

    deleteCol(view, container, col) {
        const from = getFromFromContainer(container);
        if (from === null) return;
        const block = this.getBlockAtFrom(view.state, from) ?? this.block;
        const headers = block.headers.slice();
        if (headers.length <= 1) return;
        
        // 削除実行
        headers.splice(col, 1);
        const aligns = block.aligns.slice();
        aligns.splice(col, 1);
        const rows = block.rows.map(r => {
            const nr = r.slice();
            if (nr.length > 0) nr.splice(col, 1);
            return nr;
        });
        
        // ★修正: 削除後の列数に基づいてフォーカス位置を計算
        let newCol = col;
        if (headers.length === 0) {
            newCol = 0;
        } else if (newCol >= headers.length) {
            newCol = headers.length - 1;
        }

        const updated = { ...block, headers, aligns, rows };
        const currentWidths = (view.state.field(colWidthsField) ?? {})[from];
        let newWidths = null;
        if (currentWidths) {
            newWidths = currentWidths.slice();
            newWidths.splice(col, 1);
        }
        this.dispatchReplace(view, from, updated, newWidths, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, 0, newCol));
    }
    
    // --- KeyDown Handler (Delete/Backspace + Copy) ---
    processKeyDown(event, view) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
            if (this.selection.type !== 'none') {
                event.preventDefault();
                event.stopPropagation();
                this.performCopy(view);
            }
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            // ★追加: 単一セル選択かつ編集中(フォーカスがある)場合は、デフォルトの文字削除動作を優先する
            const isSingleCell = this.selection.type === 'rect' && 
                                 this.selection.selectedRows.size === 1 && 
                                 this.selection.selectedCols.size === 1;
            
            // 現在のアクティブ要素がこのテーブルウィジェット内にあり、かつセル(td, th)の内部であることを確認
            const activeEl = document.activeElement;
            const isActiveInTable = activeEl && this.container && this.container.contains(activeEl);
            
            // activeElementがcontentEditableなセル自身、またはその内部要素である場合
            const isEditing = isActiveInTable && (
                activeEl.tagName === 'TD' || activeEl.tagName === 'TH' || activeEl.closest('td, th')
            );

            if (isSingleCell && isEditing) {
                // 文字削除を許可するため、何もしない（ブラウザのデフォルト動作に任せる）
                return;
            }

            if (this.selection.type !== 'none') {
                event.preventDefault();
                event.stopPropagation();

                const dom = this.container;
                if (!dom) return;

                if (dom.deleteTimer) {
                    // 2回目: 構造的な削除（行・列削除）
                    logAction('Double Delete Detected -> Structure Delete');
                    clearTimeout(dom.deleteTimer);
                    dom.deleteTimer = undefined;

                    const cachedSelection = dom.pendingDeleteSelection;
                    if (cachedSelection) {
                        this.selection = cachedSelection;
                    }

                    this.performDelete(view, 'structure');
                    dom.pendingDeleteSelection = undefined;

                } else {
                    // 1回目: コンテンツ削除 (待機)
                    logInfo('First Delete -> Waiting...');

                    // 選択状態を保存
                    dom.pendingDeleteSelection = {
                        ...this.selection,
                        selectedRows: new Set(this.selection.selectedRows),
                        selectedCols: new Set(this.selection.selectedCols)
                    };

                    dom.deleteTimer = window.setTimeout(() => {
                        logInfo('Timeout -> Single Delete (Content Clear)');
                        dom.deleteTimer = undefined;
                        dom.pendingDeleteSelection = undefined;

                        this.performDelete(view, 'content');
                    }, this.DELETE_DOUBLE_CLICK_THRESHOLD);
                }
            }
        }

        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab'].includes(event.key)) {
            this.clearSelection();
        }
    }

    processCopy(e, view) {
        if (this.selection.type === 'none') return;
        e.preventDefault();
        e.stopPropagation();
        this.performCopy(view);
    }

    performCopy(view) {
        if (!this.container) return;
        const currentFrom = getFromFromContainer(this.container);
        if (currentFrom === null) return;

        if (this.selection.type === 'none' || this.selection.selectedRows.size === 0) return;
        const currentBlock = this.getBlockAtFrom(view.state, currentFrom);
        if (!currentBlock) return;

        const targetRows = Array.from(this.selection.selectedRows).sort((a, b) => a - b);
        const targetCols = Array.from(this.selection.selectedCols).sort((a, b) => a - b);

        const safeHeaders = currentBlock.headers || [];
        const safeAligns = currentBlock.aligns || [];
        const safeRows = currentBlock.rows || [];

        const hasOriginalHeader = targetRows.includes(-1);
        const dataRowsIndices = targetRows.filter(r => r >= 0);

        const extractCols = (row) => targetCols.map(c => row && row[c] ? row[c] : '');
        const newAligns = targetCols.map(c => safeAligns[c] ?? null);

        let newRows = dataRowsIndices.map(r => extractCols(safeRows[r]));
        let newHeaders = [];

        if (hasOriginalHeader) {
            newHeaders = extractCols(safeHeaders);
        } else if (newRows.length > 0) {
            newHeaders = newRows[0];
            newRows = newRows.slice(1);
        } else {
            newHeaders = targetCols.map(() => '');
        }

        let markdownTable = serializeTable(newHeaders, newAligns, newRows);
        // クリップボードにコピー
        if (navigator.clipboard) {
            navigator.clipboard.writeText(markdownTable).then(() => {
                logSuccess('Copied table selection to clipboard');
            }).catch(err => {
                logError('Failed to write to clipboard', err);
            });
        }
    }

    // 削除実行
    performDelete(view, mode) {
        if (!this.container) return;
        const currentFrom = getFromFromContainer(this.container);
        if (currentFrom === null) return;

        if (this.selection.type === 'none' || this.selection.selectedRows.size === 0) return;

        this.isPerformingDelete = true; // 削除操作中フラグ

        // フォーカスを外してコミットを防ぐ
        if (document.activeElement && this.container.contains(document.activeElement)) {
            document.activeElement.blur();
        }

        const currentSelection = { ...this.selection };
        let targetRows = [];
        let targetCols = [];

        // 選択範囲の正規化
        if (currentSelection.type === 'rect' && currentSelection.anchor && currentSelection.head) {
            const r1 = currentSelection.anchor.row;
            const r2 = currentSelection.head.row;
            const c1 = currentSelection.anchor.col;
            const c2 = currentSelection.head.col;

            const rStart = (r1 === null ? -1 : r1);
            const rEnd = (r2 === null ? -1 : r2);

            const minR = Math.min(rStart, rEnd);
            const maxR = Math.max(rStart, rEnd);
            const minC = Math.min(c1, c2);
            const maxC = Math.max(c1, c2);

            for (let r = minR; r <= maxR; r++) targetRows.push(r);
            for (let c = minC; c <= maxC; c++) targetCols.push(c);

            targetRows.sort((a, b) => a - b);
            targetCols.sort((a, b) => a - b);

            // 1セルだけのRect選択の場合
            if (r1 === r2 && c1 === c2 && targetRows.length > 1) {
                targetRows = [rStart];
                targetCols = [c1];
            }
        } else {
            targetRows = Array.from(currentSelection.selectedRows).map(Number).sort((a, b) => a - b);
            targetCols = Array.from(currentSelection.selectedCols).map(Number).sort((a, b) => a - b);
        }

        if (mode === 'structure') {
            this.clearSelection();
        }

        const currentBlock = this.getBlockAtFrom(view.state, currentFrom);
        if (!currentBlock) {
            this.isPerformingDelete = false;
            return;
        }

        if (mode === 'content') {
            // 内容クリア
            const newHeaders = [...currentBlock.headers];
            const newRows = currentBlock.rows.map(r => [...r]);

            for (const r of targetRows) {
                for (const c of targetCols) {
                    if (r === -1) {
                        if (newHeaders[c] !== undefined) newHeaders[c] = '';
                    } else {
                        if (newRows[r] && newRows[r][c] !== undefined) newRows[r][c] = '';
                    }
                }
            }

            const updated = { ...currentBlock, headers: newHeaders, rows: newRows };
            this.dispatchReplace(view, currentFrom, updated, null, (latestFrom) => {
                this.isPerformingDelete = false;
                if (targetRows.length > 0 && targetCols.length > 0) {
                    requestAnimationFrame(() => {
                        this.focusCellAt(view, latestFrom ?? currentFrom, targetRows[0], targetCols[0]);
                    });
                }
            });

        } else {
            // 構造削除 (行/列の削除)
            let newHeaders = [...currentBlock.headers];
            let newAligns = [...currentBlock.aligns];
            let newRows = currentBlock.rows.map(r => [...r]);
            let newWidths = null;
            const currentWidths = (view.state.field(colWidthsField) ?? {})[currentFrom];
            if (currentWidths) newWidths = [...currentWidths];

            // Rect選択が全行をカバーしている場合、列削除とみなす
            const isRectCoveringAllRows = (
                currentSelection.type === 'rect' &&
                targetRows.length >= (currentBlock.rows.length + 1) // ヘッダー + ボディ全行
            );

            if (currentSelection.type === 'col' || isRectCoveringAllRows) {
                // 列削除
                const reversedCols = [...targetCols].sort((a, b) => b - a);
                reversedCols.forEach(c => {
                    newHeaders.splice(c, 1);
                    newAligns.splice(c, 1);
                    newRows.forEach(row => row.splice(c, 1));
                    if (newWidths) newWidths.splice(c, 1);
                });
            } else {
                // 行削除
                const reversedRows = [...targetRows].sort((a, b) => b - a);
                reversedRows.forEach(r => {
                    if (r === -1) {
                        // ヘッダー行の完全削除はMarkdownテーブルとして成立しないため、中身クリアのみ
                        newHeaders.fill('');
                    } else {
                        if (r >= 0 && r < newRows.length) {
                            newRows.splice(r, 1);
                        }
                    }
                });
            }

            const updated = { ...currentBlock, headers: newHeaders, aligns: newAligns, rows: newRows };
            this.dispatchReplace(view, currentFrom, updated, newWidths, (latestFrom) => {
                this.clearSelection();
                this.isPerformingDelete = false;
                requestAnimationFrame(() => {
                    // 行削除後、行が残っていれば0行目に、なければヘッダーにフォーカス
                    const focusRow = updated.rows.length > 0 ? 0 : -1;
                    this.focusCellAt(view, latestFrom ?? currentFrom, focusRow, 0);
                });
            });
        }
    }
}

function buildDecorations(state) {
    const builder = new RangeSetBuilder();
    const blocks = parseTablesInDoc(state);
    const widthsMap = state.field(colWidthsField);
    for (const block of blocks) {
        const widths = widthsMap[block.from] ?? null;
        builder.add(
            block.from,
            block.to,
            Decoration.replace({
                widget: new TableWidget(block, widths)
            })
        );
    }
    return builder.finish();
}

const tableDecoField = StateField.define({
    create(state) {
        return buildDecorations(state);
    },
    update(value, tr) {
        const needsUpdate = tr.docChanged || tr.effects.some(e => e.is(updateColWidthEffect));
        if (!needsUpdate) return value;
        return buildDecorations(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f)
});

const tableKeymap = keymap.of([]);

exports.tableExtension = [
    colWidthsField,
    tableDecoField,
];
exports.tableKeymap = tableKeymap;