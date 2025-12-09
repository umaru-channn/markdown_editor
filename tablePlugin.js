/**
 * tablePlugin.js
 * CodeMirror 6 Notion-Like Table Plugin
 * Update:
 * - Fix: Use view.posAtDOM to determine the exact start position of the widget during updates.
 * - Enforce blank lines above and below the table.
 * - Update: Context Menu Logic fix for editing state.
 * - Update: Allow column resizing from any cell row.
 * - Update: Highlight the entire column resize line when resizing or hovering the handle.
 * - Update: Show drag target line on the entire column/row during drag & drop.
 * - Fix: Ensure clean logic for drag class assignment to avoid syntax errors.
 * - Update: Remove background highlight for drag targets, show border line only.
 */

const { StateField } = require("@codemirror/state");
const { EditorView, Decoration, WidgetType } = require("@codemirror/view");
const { syntaxTree } = require("@codemirror/language");
const { RangeSetBuilder } = require("@codemirror/state");
const { h, render } = require("preact");
const { useState, useEffect, useRef } = require("preact/hooks");
const htm = require("htm");
const { marked } = require("marked");

// Initialize htm with Preact's h function
const html = htm.bind(h);

// ========== 1. Helpers: Markdown Parsing & Serialization ==========

function parseMarkdownTable(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return { headers: [], rows: [], aligns: [] };

    const parseLine = (line) => {
        return line.split('|')
            .map(cell => cell.trim())
            .filter((cell, i, arr) => {
                if (i === 0 && cell === '') return false;
                if (i === arr.length - 1 && cell === '') return false;
                return true;
            });
    };

    const headers = parseLine(lines[0]);
    const separator = parseLine(lines[1]);
    const rows = lines.slice(2).map(parseLine);

    const aligns = separator.map(cell => {
        return 'left';
    });

    return { headers, rows, aligns };
}

function serializeMarkdownTable(headers, rows, aligns) {
    const colWidths = headers.map((h, i) => {
        let max = h ? h.length : 0;
        rows.forEach(row => {
            if (row[i] && row[i].length > max) max = row[i].length;
        });
        return Math.max(max, 3);
    });

    const pad = (text, width) => {
        const t = text || "";
        const p = width - t.length;
        if (p <= 0) return t;
        return t + " ".repeat(p);
    };

    const buildLine = (cells) => {
        return "| " + cells.map((cell, i) => {
            return pad(cell, colWidths[i]);
        }).join(" | ") + " |";
    };

    const buildSeparator = () => {
        return "| " + colWidths.map((w, i) => {
            return "-".repeat(w);
        }).join(" | ") + " |";
    };

    let md = buildLine(headers) + "\n" + buildSeparator();
    rows.forEach(row => {
        md += "\n" + buildLine(row);
    });

    return md;
}

function createWidthComment(widths) {
    const cleanWidths = widths.map(w => w ? Math.round(w) : null);
    return `<!-- table-widths: ${JSON.stringify(cleanWidths)} -->`;
}

function parseWidthComment(commentText) {
    const match = commentText.match(/<!--\s*table-widths:\s*(\[.*?\])\s*-->/);
    if (match) {
        try {
            return JSON.parse(match[1]);
        } catch (e) {
            return null;
        }
    }
    return null;
}

// Array move helper
function arrayMove(arr, fromIndex, toIndex) {
    const newArr = [...arr];
    const element = newArr[fromIndex];
    newArr.splice(fromIndex, 1);
    newArr.splice(toIndex, 0, element);
    return newArr;
}

// ========== 2. UI Components (Preact + HTM) ==========

const Cell = ({
    value, onChange, isHeader, width,
    onResizeStart, onResizeHover, isResizeActive,
    isSelected, isEditing, caretPosition,
    onMouseDown, onMouseEnter, onDblClick, onNavigateRequest,
    // Drag & Drop Props
    rowIndex, colIndex,
    onDragStart, onDragOver, onDrop,
    dragClass,
    // Selection Handlers
    onSelectColumn, onSelectRow,
    // Context Menu
    onContextMenu
}) => {
    const ref = useRef(null);

    useEffect(() => {
        if (isEditing && ref.current) {
            ref.current.focus();
            const range = document.createRange();
            const sel = window.getSelection();
            if (ref.current.childNodes.length > 0) {
                range.selectNodeContents(ref.current);
                if (caretPosition === 'start') {
                    range.collapse(true);
                } else if (caretPosition === 'end') {
                    range.collapse(false);
                }
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
    }, [isEditing, caretPosition]);

    const handleInput = (e) => {
        let text = e.target.innerText.replace(/\n/g, ' ').replace(/\|/g, '&#124;');
        onChange(text);
    };

    const handleKeyDown = (e) => {
        e.stopPropagation();

        // Enter key: Navigate down (or add row)
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onNavigateRequest('enter');
            return;
        }

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            onNavigateRequest('up');
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            onNavigateRequest('down');
            return;
        }

        if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
            const sel = window.getSelection();
            if (!sel.rangeCount || !ref.current.contains(sel.anchorNode)) return;

            const range = sel.getRangeAt(0);
            const isCollapsed = range.collapsed;
            const textLength = ref.current.textContent.length;

            if (e.key === 'ArrowLeft' && isCollapsed && range.startOffset === 0) {
                e.preventDefault();
                onNavigateRequest('prev');
                return;
            }

            if (e.key === 'ArrowRight' && isCollapsed) {
                let isAtEnd = false;
                if (textLength === 0) {
                    isAtEnd = true;
                } else if (range.endContainer === ref.current) {
                    isAtEnd = range.endOffset === ref.current.childNodes.length;
                } else if (range.endContainer.nodeType === Node.TEXT_NODE && range.endContainer === ref.current.lastChild) {
                    isAtEnd = range.endOffset === range.endContainer.length;
                }

                if (isAtEnd) {
                    e.preventDefault();
                    onNavigateRequest('next');
                    return;
                }
            }
        }
    };

    const style = {
        textAlign: 'left',
        width: width ? `${width}px` : 'auto',
        minWidth: width ? `${width}px` : 'auto',
        maxWidth: width ? `${width}px` : 'auto',
        position: 'relative',
        boxSizing: 'border-box'
    };

    const resizeHandle = onResizeStart ? html`
        <div 
            class="cm-table-resize-handle ${isResizeActive ? 'active' : ''}" 
            onMouseDown=${(e) => onResizeStart(e)}
            onClick=${(e) => e.stopPropagation()}
            onMouseEnter=${() => onResizeHover(true)}
            onMouseLeave=${() => onResizeHover(false)}
        ></div>
    ` : null;

    // --- Drag Handles with Click Selection ---
    let dragHandle = null;

    if (isHeader) {
        dragHandle = html`
            <div 
                class="cm-table-drag-handle col-drag-handle" 
                draggable="true"
                onDragStart=${(e) => onDragStart(e, colIndex, 'col')}
                onMouseDown=${(e) => e.stopPropagation()} 
                onClick=${(e) => {
                e.stopPropagation();
                onSelectColumn(colIndex);
            }}
                title="ドラッグで移動 / クリックで列選択"
            >⋮⋮</div>
        `;
    } else if (colIndex === 0) {
        dragHandle = html`
            <div 
                class="cm-table-drag-handle row-drag-handle" 
                draggable="true"
                onDragStart=${(e) => onDragStart(e, rowIndex, 'row')}
                onMouseDown=${(e) => e.stopPropagation()}
                onClick=${(e) => {
                e.stopPropagation();
                onSelectRow(rowIndex);
            }}
                title="ドラッグで移動 / クリックで行選択"
            >⋮⋮</div>
        `;
    }

    let content;
    if (isEditing) {
        // 編集モード：生のMarkdownテキストを表示・編集
        content = html`
            <div
                ref=${ref}
                class="cm-table-cell-content editing"
                contentEditable=${true}
                onInput=${handleInput}
                onKeyDown=${handleKeyDown}
                dangerouslySetInnerHTML=${{ __html: value }}
            />
        `;
    } else {
        // 表示モード：MarkdownをパースしてHTMLとして表示
        let htmlContent = '';
        if (!value || value.trim() === '') {
            htmlContent = '<br>'; // 空の場合は高さを維持するためbrを入れる
        } else {
            try {
                // 1. ハイライト記法 (==text==) を <mark> タグに置換
                // markedに通す前に処理することで、HTMLとして認識させる
                let processed = value.replace(/==([^=]+)==/g, '<mark>$1</mark>');

                // 2. Markdown変換 (parseInlineで段落タグなし)
                htmlContent = marked.parseInline(processed, { breaks: true, gfm: true });
            } catch (e) {
                htmlContent = value;
            }
        }
        
        content = html`
            <div class="cm-table-cell-content view-mode"
                dangerouslySetInnerHTML=${{ __html: htmlContent }}
            ></div>
        `;
    }

    const handleDragOver = (e) => {
        onDragOver(e, isHeader ? colIndex : rowIndex, isHeader ? 'col' : 'row');
    };

    const handleDrop = (e) => {
        onDrop(e, isHeader ? colIndex : rowIndex, isHeader ? 'col' : 'row');
    };

    const handleContextMenu = (e) => {
        if (isEditing) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e, rowIndex, colIndex);
    };

    let className = `cm-table-cell ${isSelected ? 'selected' : ''}`;
    if (dragClass) {
        className += ' ' + dragClass;
    }

    return html`
        <${isHeader ? 'th' : 'td'} 
            style=${style} 
            class=${className}
            onMouseDown=${(e) => { if (!isEditing) onMouseDown(e); }}
            onMouseEnter=${(e) => { if (!isEditing) onMouseEnter(e); }}
            onDblClick=${(e) => { e.stopPropagation(); onDblClick(); }}
            onDragOver=${handleDragOver}
            onDrop=${handleDrop}
            onContextMenu=${handleContextMenu}
        >
            ${dragHandle}
            ${content}
            ${resizeHandle}
        <//>
    `;
};

// Context Menu Component (Updated to use shared CSS classes)
const TableContextMenu = ({ x, y, rowIndex, colIndex, onAction, onClose }) => {
    useEffect(() => {
        const handleClickOutside = () => onClose();
        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
    }, []);

    const style = {
        position: 'fixed',
        top: `${y}px`,
        left: `${x}px`,
        zIndex: 10000,
    };

    const stopProp = (e) => e.stopPropagation();

    // クラス名を renderer.js 側の共通スタイル (context-menu, context-menu-item) に統一
    return html`
        <div class="context-menu" style=${style} onClick=${stopProp}>
            <div class="context-menu-item" onClick=${() => onAction('insertRowAbove', rowIndex, colIndex)}>上に行を挿入</div>
            <div class="context-menu-item" onClick=${() => onAction('insertRowBelow', rowIndex, colIndex)}>下に行を挿入</div>
            <div class="context-menu-item" onClick=${() => onAction('deleteRow', rowIndex, colIndex)}>行を削除</div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" onClick=${() => onAction('insertColLeft', rowIndex, colIndex)}>左に列を挿入</div>
            <div class="context-menu-item" onClick=${() => onAction('insertColRight', rowIndex, colIndex)}>右に列を挿入</div>
            <div class="context-menu-item" onClick=${() => onAction('deleteCol', rowIndex, colIndex)}>列を削除</div>
        </div>
    `;
};

const TableComponent = ({ initialData, initialWidths, onUpdate, onRender }) => {
    const [data, setData] = useState(initialData);
    const [widths, setWidths] = useState(initialWidths || []);

    const [selection, setSelection] = useState(null);
    const [isDragging, setIsDragging] = useState(false);

    const [isEditing, setIsEditing] = useState(false);
    const [caretPosition, setCaretPosition] = useState('end');

    // Drag & Drop State
    const [dragState, setDragState] = useState({ type: null, fromIndex: null, toIndex: null });

    // Context Menu State
    const [contextMenu, setContextMenu] = useState(null);

    // Resize State
    const [resizingColIndex, setResizingColIndex] = useState(-1);
    const [hoveredResizeColIndex, setHoveredResizeColIndex] = useState(-1);

    const lastDeletePressRef = useRef(0);
    const tableRef = useRef(null);

    useEffect(() => { if (onRender) onRender(); });

    useEffect(() => {
        if (tableRef.current) {
            const headerCells = tableRef.current.querySelectorAll('thead th');
            const currentPixelWidths = Array.from(headerCells).map(cell => cell.getBoundingClientRect().width);

            let shouldUpdate = false;
            const newWidths = [...widths];
            if (newWidths.length < currentPixelWidths.length) {
                for (let i = newWidths.length; i < currentPixelWidths.length; i++) newWidths.push(null);
            }
            for (let i = 0; i < currentPixelWidths.length; i++) {
                if (newWidths[i] === null || newWidths[i] === undefined) {
                    newWidths[i] = currentPixelWidths[i];
                    shouldUpdate = true;
                }
            }
            if (shouldUpdate) setWidths(newWidths);
        }
    }, []);

    useEffect(() => {
        if (JSON.stringify(initialData) !== JSON.stringify(data)) setData(initialData);
    }, [initialData]);

    useEffect(() => {
        if (initialWidths && initialWidths.length > 0 && widths.every(w => w === null)) {
            setWidths(initialWidths);
        }
    }, [initialWidths]);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (tableRef.current && !tableRef.current.contains(e.target)) {
                setSelection(null);
                setIsEditing(false);
            }
        };
        const handleGlobalMouseUp = () => { if (isDragging) setIsDragging(false); };
        const handleGlobalDragEnd = () => { setDragState({ type: null, fromIndex: null, toIndex: null }); };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('mouseup', handleGlobalMouseUp);
        document.addEventListener('dragend', handleGlobalDragEnd);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('mouseup', handleGlobalMouseUp);
            document.removeEventListener('dragend', handleGlobalDragEnd);
        };
    }, [isDragging]);

    useEffect(() => {
        if (selection && !isEditing && tableRef.current) {
            tableRef.current.focus();
        }
    }, [selection, isEditing]);

    // --- Logic ---

    const getEffectiveWidths = () => {
        if (!tableRef.current) return widths;
        // 現在のヘッダーセルの幅を取得
        const headerCells = tableRef.current.querySelectorAll('thead th');
        const currentPixelWidths = Array.from(headerCells).map(cell => cell.getBoundingClientRect().width);

        // widthsステートとマージ（既に値がある場合はそれを優先、nullの場合はDOM幅を採用）
        return widths.map((w, i) => {
            return (w === null || w === undefined) ? currentPixelWidths[i] : w;
        });
    };

    const updateCell = (rowIndex, colIndex, value) => {
        const newData = { ...data };
        if (rowIndex === -1) newData.headers[colIndex] = value;
        else newData.rows[rowIndex][colIndex] = value;
        setData(newData);
        debouncedUpdate(newData, widths);
    };

    const selectColumn = (colIndex) => {
        const maxR = data.rows.length - 1;
        setSelection({ anchor: { r: -1, c: colIndex }, head: { r: maxR, c: colIndex } });
        setIsEditing(false);
        if (tableRef.current) tableRef.current.focus();
    };

    const selectRow = (rowIndex) => {
        const maxC = data.headers.length - 1;
        setSelection({ anchor: { r: rowIndex, c: 0 }, head: { r: rowIndex, c: maxC } });
        setIsEditing(false);
        if (tableRef.current) tableRef.current.focus();
    };

    const insertRow = (index) => {
        const newData = { ...data };
        const newRow = new Array(newData.headers.length).fill("");
        const spliceIndex = Math.max(0, Math.min(index, newData.rows.length));
        newData.rows.splice(spliceIndex, 0, newRow);
        setData(newData);
        requestUpdate(newData, widths);
    };

    const deleteRowAt = (index) => {
        const newData = { ...data };
        if (index === -1) {
            if (newData.rows.length > 0) {
                newData.headers = newData.rows[0];
                newData.rows.shift();
            } else {
                newData.headers = new Array(newData.headers.length).fill("");
            }
        } else {
            if (index >= 0 && index < newData.rows.length) {
                newData.rows.splice(index, 1);
            }
        }
        setData(newData);
        requestUpdate(newData, widths);
    };

    const insertColumn = (index) => {
        const newData = { ...data };
        const spliceIndex = Math.max(0, Math.min(index, newData.headers.length));
        newData.headers.splice(spliceIndex, 0, "");
        if (newData.aligns) newData.aligns.splice(spliceIndex, 0, "left");
        newData.rows.forEach(row => row.splice(spliceIndex, 0, ""));
        const newWidths = [...widths];
        newWidths.splice(spliceIndex, 0, 100);
        setWidths(newWidths);
        setData(newData);
        requestUpdate(newData, newWidths);
    };

    const deleteColumnAt = (index) => {
        const newData = { ...data };
        if (newData.headers.length <= 1) return;
        if (index >= 0 && index < newData.headers.length) {
            newData.headers.splice(index, 1);
            if (newData.aligns) newData.aligns.splice(index, 1);
            newData.rows.forEach(row => row.splice(index, 1));
            const newWidths = [...widths];
            newWidths.splice(index, 1);
            setWidths(newWidths);
            setData(newData);
            requestUpdate(newData, newWidths);
        }
    };

    const handleMenuAction = (action, rowIndex, colIndex) => {
        setContextMenu(null);
        switch (action) {
            case 'insertRowAbove': insertRow(rowIndex === -1 ? 0 : rowIndex); break;
            case 'insertRowBelow': insertRow(rowIndex + 1); break;
            case 'deleteRow': deleteRowAt(rowIndex); break;
            case 'insertColLeft': insertColumn(colIndex); break;
            case 'insertColRight': insertColumn(colIndex + 1); break;
            case 'deleteCol': deleteColumnAt(colIndex); break;
        }
    };

    const handleContextMenuOpen = (e, rowIndex, colIndex) => {
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            rowIndex,
            colIndex
        });
    };

    const deleteSelection = () => {
        if (!selection) return false;
        const { minR, maxR, minC, maxC } = getNormalizedSelection();
        const isAllRowsSelected = minR === -1 && maxR === data.rows.length - 1;
        const isAllColsSelected = minC === 0 && maxC === data.headers.length - 1;
        let newData = { ...data };
        let newWidths = [...widths];
        let handled = false;

        if (isAllRowsSelected) {
            if (data.headers.length > 1) {
                const keepColIndex = (i) => i < minC || i > maxC;
                const survivingCols = data.headers.filter((_, i) => keepColIndex(i));
                if (survivingCols.length > 0) {
                    newData.headers = survivingCols;
                    if (newData.aligns) newData.aligns = newData.aligns.filter((_, i) => keepColIndex(i));
                    newData.rows = newData.rows.map(row => row.filter((_, i) => keepColIndex(i)));
                    newWidths = newWidths.filter((_, i) => keepColIndex(i));
                    handled = true;
                }
            }
        }
        else if (isAllColsSelected) {
            const keepRowIndex = (i) => i < minR || i > maxR;
            const headerDeleted = (minR <= -1 && maxR >= -1);
            const survivingDataRows = newData.rows.filter((_, i) => keepRowIndex(i));
            if (headerDeleted) {
                if (survivingDataRows.length > 0) {
                    newData.headers = survivingDataRows[0];
                    newData.rows = survivingDataRows.slice(1);
                } else {
                    newData.headers = new Array(newData.headers.length).fill("");
                    newData.rows = [];
                }
                handled = true;
            } else {
                newData.rows = survivingDataRows;
                handled = true;
            }
        }

        if (handled) {
            setData(newData);
            setWidths(newWidths);
            setSelection(null);
            requestUpdate(newData, newWidths);
            return true;
        }
        return false;
    };

    const clearContentSelection = () => {
        if (!selection) return;
        const { minR, maxR, minC, maxC } = getNormalizedSelection();
        const newData = { ...data };
        let changed = false;
        for (let r = minR; r <= maxR; r++) {
            for (let c = minC; c <= maxC; c++) {
                if (r === -1) {
                    if (newData.headers[c] !== "") { newData.headers[c] = ""; changed = true; }
                } else {
                    if (newData.rows[r][c] !== "") { newData.rows[r][c] = ""; changed = true; }
                }
            }
        }
        if (changed) {
            setData(newData);
            // 削除時に現在の列幅を固定して、幅が変わらないようにする
            const effectiveWidths = getEffectiveWidths();
            setWidths(effectiveWidths);
            requestUpdate(newData, effectiveWidths);
        }
    };

    const addRowBtn = () => {
        const newData = { ...data };
        const newRow = new Array(newData.headers.length).fill("");
        newData.rows.push(newRow);
        setData(newData);
        requestUpdate(newData, widths);
        const lastRowIdx = newData.rows.length - 1;
        setSelection({ anchor: { r: lastRowIdx, c: 0 }, head: { r: lastRowIdx, c: 0 } });
    };

    const addColumnBtn = () => {
        const newData = { ...data };
        newData.headers.push("");
        newData.rows.forEach(row => row.push(""));
        if (newData.aligns) newData.aligns.push('left');
        setData(newData);
        const newWidths = [...widths, 100];
        setWidths(newWidths);
        requestUpdate(newData, newWidths);
    };

    // --- Drag & Drop Logic ---
    const handleDragStart = (e, index, type) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `${type}:${index}`);
        setDragState({ type, fromIndex: index, toIndex: index });
        setSelection(null);
        setIsEditing(false);
    };

    const handleDragOver = (e, index, type) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragState.type === type && dragState.toIndex !== index) {
            setDragState(prev => ({ ...prev, toIndex: index }));
        }
    };

    const handleDrop = (e, index, type) => {
        e.preventDefault();
        const { fromIndex, type: dragType } = dragState;

        if (dragType === type && fromIndex !== null && fromIndex !== index) {
            const newData = { ...data };
            let newWidths = [...widths];

            if (type === 'col') {
                newData.headers = arrayMove(newData.headers, fromIndex, index);
                if (newData.aligns) newData.aligns = arrayMove(newData.aligns, fromIndex, index);
                newData.rows = newData.rows.map(row => arrayMove(row, fromIndex, index));
                newWidths = arrayMove(newWidths, fromIndex, index);
            } else if (type === 'row') {
                newData.rows = arrayMove(newData.rows, fromIndex, index);
            }

            setData(newData);
            setWidths(newWidths);
            requestUpdate(newData, newWidths);
        }
        setDragState({ type: null, fromIndex: null, toIndex: null });
    };

    const timeoutRef = useRef(null);
    const requestUpdate = (currentData, currentWidths) => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        onUpdate(currentData, currentWidths);
    };
    const debouncedUpdate = (newData, newWidths) => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => { onUpdate(newData, newWidths); }, 500);
    };

    const getNormalizedSelection = () => {
        if (!selection) return { minR: 0, maxR: -1, minC: 0, maxC: -1 };
        const { anchor, head } = selection;
        return {
            minR: Math.min(anchor.r, head.r),
            maxR: Math.max(anchor.r, head.r),
            minC: Math.min(anchor.c, head.c),
            maxC: Math.max(anchor.c, head.c)
        };
    };

    const isCellSelected = (r, c) => {
        if (!selection) return false;
        const { minR, maxR, minC, maxC } = getNormalizedSelection();
        return r >= minR && r <= maxR && c >= minC && c <= maxC;
    };

    const moveSelection = (deltaR, deltaC, editMode = false, initialCaret = 'end') => {
        if (!selection) return;
        const { head } = selection;
        let r = head.r;
        let c = head.c;
        const maxR = data.rows.length - 1;
        const maxC = data.headers.length - 1;
        const nextR = r + deltaR;
        const nextC = c + deltaC;
        if (nextC < 0 || nextC > maxC) return;
        if (nextR < -1 || nextR > maxR) return;
        setSelection({ anchor: { r: nextR, c: nextC }, head: { r: nextR, c: nextC } });
        setIsEditing(editMode);
        if (editMode) setCaretPosition(initialCaret);
    };

    const handleNavigateRequest = (direction) => {
        if (!selection) return;
        const { head } = selection;
        if (direction === 'enter') {
            const maxR = data.rows.length - 1;
            if (head.r < maxR) {
                moveSelection(1, 0, false);
            } else {
                addRowBtn();
            }
            return;
        }
        if (direction === 'prev') moveSelection(0, -1, true, 'end');
        else if (direction === 'next') moveSelection(0, 1, true, 'start');
        else if (direction === 'up') moveSelection(-1, 0, true, 'end');
        else if (direction === 'down') moveSelection(1, 0, true, 'end');
    };

    const handleMouseDown = (e, r, c) => {
        if (e.button !== 0) return;
        if (e.target.classList.contains('cm-table-drag-handle')) return;
        e.stopPropagation();
        setSelection({ anchor: { r, c }, head: { r, c } });
        setIsDragging(true);
        setIsEditing(false);
    };

    const handleMouseEnter = (e, r, c) => {
        if (isDragging && selection) {
            setSelection(prev => ({ ...prev, head: { r, c } }));
        }
    };

    const handleEditStart = () => {
        if (selection) {
            setSelection({ anchor: selection.anchor, head: selection.anchor });
            setIsEditing(true);
            setCaretPosition('end');
        }
    };

    const handleKeyDown = (e) => {
        if (isEditing) return;
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            if (!selection) {
                setSelection({ anchor: { r: -1, c: 0 }, head: { r: -1, c: 0 } });
                return;
            }
            if (e.shiftKey) {
                const { head } = selection;
                let r = head.r;
                let c = head.c;
                const maxR = data.rows.length - 1;
                const maxC = data.headers.length - 1;
                if (e.key === 'ArrowUp') r--;
                if (e.key === 'ArrowDown') r++;
                if (e.key === 'ArrowLeft') c--;
                if (e.key === 'ArrowRight') c++;
                r = Math.max(-1, Math.min(r, maxR));
                c = Math.max(0, Math.min(c, maxC));
                setSelection(prev => ({ ...prev, head: { r, c } }));
            } else {
                if (e.key === 'ArrowUp') moveSelection(-1, 0);
                if (e.key === 'ArrowDown') moveSelection(1, 0);
                if (e.key === 'ArrowLeft') moveSelection(0, -1);
                if (e.key === 'ArrowRight') moveSelection(0, 1);
            }
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            if (selection) handleNavigateRequest('enter');
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            const now = Date.now();
            const isDouble = (now - lastDeletePressRef.current) < 300;
            lastDeletePressRef.current = now;
            if (isDouble) {
                const handled = deleteSelection();
                if (!handled) clearContentSelection();
            } else {
                clearContentSelection();
            }
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            handleEditStart();
        }
    };

    // --- Resizing Logic ---
    const handleResizeStart = (index, e) => {
        e.preventDefault();
        e.stopPropagation();
        setResizingColIndex(index);

        const startWidth = widths[index] || e.target.parentElement.offsetWidth;

        const onMouseMove = (moveEvent) => {
            const diff = moveEvent.clientX - e.clientX;
            const newWidth = Math.max(50, startWidth + diff);

            setWidths(prev => {
                const next = [...prev];
                next[index] = newWidth;
                return next;
            });
        };
        const onMouseUp = () => {
            setResizingColIndex(-1);
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            requestUpdate(data, widths);
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    };

    const handleResizeHover = (index, isHovering) => {
        if (isHovering) {
            setHoveredResizeColIndex(index);
        } else {
            if (hoveredResizeColIndex === index) {
                setHoveredResizeColIndex(-1);
            }
        }
    };

    return html`
        <div 
            class="cm-table-widget-wrapper" 
            tabIndex="0" 
            ref=${tableRef}
            onKeyDown=${handleKeyDown}
        >
            <table class="cm-table">
                <thead>
                    <tr>
                        ${data.headers.map((h, i) => {
        // Drag Target Logic for Columns (Headers)
        const isColDragTarget = dragState.type === 'col' && dragState.toIndex === i;
        let dragClass = '';
        if (isColDragTarget && dragState.fromIndex !== i) {
            if (dragState.fromIndex < i) dragClass = 'drag-target-right';
            else dragClass = 'drag-target-left';
        }

        const isResizeActive = (i === resizingColIndex) || (i === hoveredResizeColIndex);

        return html`
                                <${Cell} 
                                    key=${i}
                                    value=${h} 
                                    isHeader=${true}
                                    width=${widths[i]}
                                    rowIndex=${-1}
                                    colIndex=${i}
                                    isSelected=${isCellSelected(-1, i)}
                                    isEditing=${selection && selection.anchor.r === -1 && selection.anchor.c === i && isEditing}
                                    caretPosition=${caretPosition}
                                    onMouseDown=${(e) => handleMouseDown(e, -1, i)}
                                    onMouseEnter=${(e) => handleMouseEnter(e, -1, i)}
                                    onDblClick=${handleEditStart}
                                    onNavigateRequest=${handleNavigateRequest}
                                    onChange=${(val) => updateCell(-1, i, val)}
                                    
                                    onResizeStart=${(e) => handleResizeStart(i, e)}
                                    onResizeHover=${(hover) => handleResizeHover(i, hover)}
                                    isResizeActive=${isResizeActive}

                                    onDragStart=${handleDragStart}
                                    onDragOver=${handleDragOver}
                                    onDrop=${handleDrop}
                                    dragClass=${dragClass}

                                    onSelectColumn=${selectColumn}
                                    onSelectRow=${selectRow}
                                    onContextMenu=${handleContextMenuOpen}
                                />
                            `;
    })}
                    </tr>
                </thead>
                <tbody>
                    ${data.rows.map((row, rI) => html`
                        <tr key=${rI}>
                            ${row.map((cell, cI) => {
        // Drag Target Logic for Body Cells (Row & Column)
        let dragClass = '';

        // 1. Row Dragging Logic
        const isRowDragTarget = dragState.type === 'row' && dragState.toIndex === rI;
        if (isRowDragTarget && dragState.fromIndex !== rI) {
            if (dragState.fromIndex < rI) dragClass = 'drag-target-bottom';
            else dragClass = 'drag-target-top';
        }

        // 2. Column Dragging Logic
        const isColDragTarget = dragState.type === 'col' && dragState.toIndex === cI;
        if (isColDragTarget && dragState.fromIndex !== cI) {
            if (dragState.fromIndex < cI) dragClass = 'drag-target-right';
            else dragClass = 'drag-target-left';
        }

        const isResizeActive = (cI === resizingColIndex) || (cI === hoveredResizeColIndex);

        return html`
                                    <${Cell} 
                                        key=${`${rI}-${cI}`}
                                        value=${cell}
                                        width=${widths[cI]}
                                        rowIndex=${rI}
                                        colIndex=${cI}
                                        isSelected=${isCellSelected(rI, cI)}
                                        isEditing=${selection && selection.anchor.r === rI && selection.anchor.c === cI && isEditing}
                                        caretPosition=${caretPosition}
                                        onMouseDown=${(e) => handleMouseDown(e, rI, cI)}
                                        onMouseEnter=${(e) => handleMouseEnter(e, rI, cI)}
                                        onDblClick=${handleEditStart}
                                        onNavigateRequest=${handleNavigateRequest}
                                        onChange=${(val) => updateCell(rI, cI, val)}
                                        
                                        onResizeStart=${(e) => handleResizeStart(cI, e)}
                                        onResizeHover=${(hover) => handleResizeHover(cI, hover)}
                                        isResizeActive=${isResizeActive}

                                        onDragStart=${handleDragStart}
                                        onDragOver=${handleDragOver}
                                        onDrop=${handleDrop}
                                        dragClass=${dragClass}

                                        onSelectColumn=${selectColumn}
                                        onSelectRow=${selectRow}
                                        onContextMenu=${handleContextMenuOpen}
                                    />
                                `;
    })}
                        </tr>
                    `)}
                </tbody>
            </table>
            
            <button class="cm-table-add-col-btn" onClick=${addColumnBtn} title="列を追加">+</button>
            <button class="cm-table-add-row-btn" onClick=${addRowBtn} title="行を追加">+</button>
            
            ${contextMenu && html`
                <${TableContextMenu} 
                    x=${contextMenu.x} 
                    y=${contextMenu.y} 
                    rowIndex=${contextMenu.rowIndex} 
                    colIndex=${contextMenu.colIndex} 
                    onAction=${handleMenuAction}
                    onClose=${() => setContextMenu(null)}
                />
            `}
        </div>
    `;
};

// ========== 3. CodeMirror Integration ==========

class TableWidget extends WidgetType {
    constructor(markdownText, widthComment, from, to) {
        super();
        this.markdownText = markdownText;
        this.widthComment = widthComment;
        this.from = from;
        this.to = to;
        this.parsedData = parseMarkdownTable(markdownText);
        this.widths = widthComment ? parseWidthComment(widthComment) : [];

        if (this.widths && this.widths.length < this.parsedData.headers.length) {
            this.widths = [...this.widths, ...Array(this.parsedData.headers.length - this.widths.length).fill(null)];
        } else if (!this.widths) {
            this.widths = Array(this.parsedData.headers.length).fill(null);
        }
    }

    eq(other) {
        return other.markdownText === this.markdownText && other.widthComment === this.widthComment;
    }

    toDOM(view) {
        const container = document.createElement("div");
        container.className = "cm-table-widget-container";
        this.mountComponent(container, view);
        return container;
    }

    mountComponent(container, view) {
        const onUpdate = (newData, newWidths) => {
            const currentFrom = view.posAtDOM(container);
            const currentComment = this.widthComment ? this.widthComment + "\n" : "";
            const currentText = currentComment + this.markdownText;
            const currentTo = currentFrom + currentText.length;

            const newMarkdown = serializeMarkdownTable(newData.headers, newData.rows, newData.aligns);
            const newComment = createWidthComment(newWidths);
            const fullText = (newComment + "\n" + newMarkdown).trim();

            view.dispatch({
                changes: { from: currentFrom, to: currentTo, insert: fullText }
            });
        };

        render(html`
            <${TableComponent} 
                initialData=${this.parsedData} 
                initialWidths=${this.widths}
                onUpdate=${onUpdate}
                onRender=${() => view.requestMeasure()} 
            />
        `, container);
    }

    updateDOM(dom, view) {
        this.mountComponent(dom, view);
        return true;
    }

    destroy(dom) {
        render(null, dom);
    }

    ignoreEvent(event) {
        if (event.type === "mousedown") return true;
        if (event.type === "keydown") return true;
        if (event.type === "dragstart") return true;
        return true;
    }
}

function buildTableDecorations(state) {
    const builder = new RangeSetBuilder();
    syntaxTree(state).iterate({
        enter: (node) => {
            if (node.name === "Table") {
                let tableFrom = node.from;
                let tableTo = node.to;
                let adjustedTo = tableTo;
                while (adjustedTo > tableFrom) {
                    const line = state.doc.lineAt(adjustedTo - 1);
                    if (line.from < tableFrom) break;
                    const text = line.text;
                    if (!text.includes('|')) adjustedTo = line.from;
                    else break;
                }
                tableTo = adjustedTo;
                if (tableTo <= tableFrom) return;

                const tableText = state.sliceDoc(tableFrom, tableTo);
                const line = state.doc.lineAt(tableFrom);
                let commentText = null;

                if (line.number > 1) {
                    const prevLine = state.doc.line(line.number - 1);
                    const prevLineText = prevLine.text.trim();
                    if (prevLineText.match(/^<!--\s*table-widths:/)) {
                        commentText = prevLineText;
                        tableFrom = prevLine.from;
                    }
                }

                builder.add(tableFrom, tableTo, Decoration.replace({
                    widget: new TableWidget(tableText, commentText, tableFrom, tableTo),
                    block: true
                }));
            }
        }
    });
    return builder.finish();
}

const tableField = StateField.define({
    create(state) { return buildTableDecorations(state); },
    update(decorations, tr) {
        if (tr.docChanged) return buildTableDecorations(tr.state);
        return decorations.map(tr.changes);
    },
    provide: f => EditorView.decorations.from(f)
});

const tableGapEnforcer = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (update.transactions.some(tr => tr.isUserEvent('table-fixup'))) return;
    const { state, view } = update;
    const changes = [];

    syntaxTree(state).iterate({
        enter: (node) => {
            if (node.name === "Table") {
                const tableFrom = node.from;
                let tableTo = node.to;
                let adjustedTo = tableTo;
                while (adjustedTo > tableFrom) {
                    const line = state.doc.lineAt(adjustedTo - 1);
                    if (line.from < tableFrom) break;
                    const text = line.text;
                    if (!text.includes('|')) adjustedTo = line.from;
                    else break;
                }
                tableTo = adjustedTo;

                const startLine = state.doc.lineAt(tableFrom);
                let effectiveStartLine = startLine;
                if (startLine.number > 1) {
                    const prevLine = state.doc.line(startLine.number - 1);
                    if (prevLine.text.match(/^<!--\s*table-widths:/)) effectiveStartLine = prevLine;
                }
                if (effectiveStartLine.number > 1) {
                    const lineAbove = state.doc.line(effectiveStartLine.number - 1);
                    if (lineAbove.length > 0) changes.push({ from: effectiveStartLine.from, insert: "\n" });
                }
                if (tableTo > 0) {
                    const lastTableLine = state.doc.lineAt(tableTo - 1);
                    if (lastTableLine.number < state.doc.lines) {
                        const lineBelow = state.doc.line(lastTableLine.number + 1);
                        if (lineBelow.length > 0) changes.push({ from: lineBelow.from, insert: "\n" });
                    }
                }
            }
        }
    });

    if (changes.length > 0) {
        setTimeout(() => { view.dispatch({ changes, userEvent: 'table-fixup' }); }, 0);
    }
});

const tableStyles = EditorView.baseTheme({
    ".cm-table-widget-container": {
        margin: "0 0 0 24px",
        padding: "4px 0",
        overflowX: "auto",
        overflowY: "hidden",
        display: "block",
        width: "auto",
        maxWidth: "calc(100% - 40px)",
        outline: "none"
    },
    ".cm-table-widget-container:focus": { outline: "none" },
    ".cm-table-widget-wrapper": {
        display: "grid",
        gridTemplateColumns: "max-content 24px",
        gridTemplateRows: "max-content 24px",
        width: "fit-content",
        outline: "none !important"
    },
    ".cm-table": {
        gridColumn: "1 / 2",
        gridRow: "1 / 2",
        borderCollapse: "collapse",
        width: "max-content",
        minWidth: "100px",
        fontSize: "var(--editor-font-size)",
        tableLayout: "fixed",
        color: "inherit",
        userSelect: "none",
        textAlign: "left"
    },
    ".cm-table th, .cm-table td": {
        border: "1px solid var(--cb-border-color, #e0e0e0)",
        padding: "0",
        verticalAlign: "top",
        position: "relative",
        textAlign: "left"
    },
    ".cm-table th": {
        backgroundColor: "var(--cb-header-bg, #f7f7f5)",
        fontWeight: "600",
        color: "#787774",
        textAlign: "left"
    },
    ".cm-table-cell": { cursor: "default" },
    ".cm-table-cell.selected": {
        backgroundColor: "rgba(35, 131, 226, 0.15)",
        position: "relative",
        zIndex: 1
    },
    ".cm-table-cell.selected::after": {
        content: '""',
        position: "absolute",
        top: 0, left: 0, right: 0, bottom: 0,
        border: "1px solid #2383e2",
        pointerEvents: "none",
        zIndex: 2
    },
    ".cm-table-drag-handle": {
        position: "absolute",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "grab",
        color: "#999",
        opacity: 0,
        transition: "opacity 0.2s, background-color 0.2s",
        zIndex: 10,
        borderRadius: "3px",
        fontSize: "12px",
        userSelect: "none"
    },
    ".cm-table-drag-handle:hover": { backgroundColor: "rgba(0, 0, 0, 0.05)", color: "#666" },
    ".cm-table-cell:hover .cm-table-drag-handle": { opacity: 1 },
    ".col-drag-handle": {
        top: "-8px", left: "50%", transform: "translateX(-50%)",
        width: "16px", height: "12px", lineHeight: "12px",
        background: "var(--cb-header-bg, #f7f7f5)"
    },
    ".row-drag-handle": {
        top: "50%", left: "-8px", transform: "translateY(-50%)",
        width: "12px", height: "16px", lineHeight: "16px",
        writingMode: "vertical-rl"
    },
    ".drag-target-left": { borderLeft: "2px solid #2383e2 !important" },
    ".drag-target-right": { borderRight: "2px solid #2383e2 !important" },
    ".drag-target-top": { borderTop: "2px solid #2383e2 !important" },
    ".drag-target-bottom": { borderBottom: "2px solid #2383e2 !important" },
    ".cm-table-cell-content": {
        padding: "5px 8px",
        outline: "none",
        minHeight: "1.5em",
        lineHeight: "1.5",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
    },
    ".cm-table-cell-content.view-mode": { pointerEvents: "none" },
    ".cm-table-cell-content.editing": {
        cursor: "text",
        backgroundColor: "#fff",
        boxShadow: "0 0 0 2px rgba(35, 131, 226, 0.4) inset",
        userSelect: "text"
    },
    ".cm-table-resize-handle": {
        position: "absolute",
        right: "-3px",
        top: "0",
        bottom: "0",
        width: "5px",
        cursor: "col-resize",
        zIndex: 10,
        transition: "background-color 0.2s"
    },
    ".cm-table-resize-handle:hover": { backgroundColor: "#2383e2" },
    ".cm-table-resize-handle.active": { backgroundColor: "#2383e2", opacity: 1 },
    ".cm-table-add-col-btn": {
        gridColumn: "2 / 3", gridRow: "1 / 2",
        width: "100%", height: "100%",
        border: "1px solid var(--cb-border-color, #e0e0e0)", borderLeft: "none",
        backgroundColor: "var(--cb-header-bg, #f7f7f5)",
        color: "#666", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        borderTopRightRadius: "4px", borderBottomRightRadius: "4px",
        fontSize: "14px", lineHeight: "1",
        transition: "opacity 0.2s, background-color 0.2s", opacity: 0
    },
    ".cm-table-add-col-btn:hover": { opacity: 1, backgroundColor: "#e0e0e0", color: "#333" },
    ".cm-table-add-row-btn": {
        gridColumn: "1 / 2", gridRow: "2 / 3",
        width: "100%", height: "100%",
        border: "1px solid var(--cb-border-color, #e0e0e0)", borderTop: "none",
        backgroundColor: "var(--cb-header-bg, #f7f7f5)",
        color: "#666", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        borderBottomLeftRadius: "4px", borderBottomRightRadius: "4px",
        fontSize: "14px",
        transition: "opacity 0.2s, background-color 0.2s", opacity: 0
    },
    ".cm-table-add-row-btn:hover": { opacity: 1, backgroundColor: "#e0e0e0", color: "#333" },
    "&dark .cm-table-add-col-btn": { backgroundColor: "#161b22", borderColor: "#30363d", color: "#8b949e" },
    "&dark .cm-table-add-col-btn:hover": { backgroundColor: "#1f2428", color: "#c9d1d9" },
    "&dark .cm-table-add-row-btn": { backgroundColor: "#161b22", borderColor: "#30363d", color: "#8b949e" },
    "&dark .cm-table-add-row-btn:hover": { backgroundColor: "#1f2428", color: "#c9d1d9" },
    "&dark .col-drag-handle": { background: "#161b22", color: "#8b949e" },
    "&dark .cm-table-context-menu": { backgroundColor: "#2d2d2d", border: "1px solid #444", color: "#ccc" }
});

module.exports = {
    tablePlugin: [tableField, tableStyles, tableGapEnforcer]
};