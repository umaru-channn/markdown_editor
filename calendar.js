// calendar.js
// Google Calendar Logic

class CalendarManager {
    constructor() {
        this.isVisible = false;
        this.containerId = 'calendar-container';
        this.headerId = 'calendar-header';
        // Googleカレンダー埋め込み用URL (日本の祝日カレンダーをデフォルトに設定)
        this.defaultUrl = "https://calendar.google.com/calendar/embed?src=ja.japanese%23holiday%40group.v.calendar.google.com&ctz=Asia%2FTokyo";
    }

    /**
     * 初期化: 右ペインにコンテナ要素を生成する
     */
    init() {
        const rightPane = document.getElementById('right-pane');
        if (!rightPane) return;

        // 既に存在すれば何もしない
        if (document.getElementById(this.containerId)) return;

        // 1. ヘッダー作成
        const header = document.createElement('div');
        header.id = this.headerId;
        header.className = 'calendar-header hidden';
        header.textContent = 'カレンダー';
        rightPane.appendChild(header);

        // 2. コンテナ作成
        const container = document.createElement('div');
        container.id = this.containerId;
        container.className = 'calendar-content hidden';
        rightPane.appendChild(container);
    }

    /**
     * 表示切り替え
     */
    toggle() {
        this.isVisible = !this.isVisible;
        this.updateView();
        return this.isVisible;
    }

    /**
     * 表示にする
     */
    show() {
        this.isVisible = true;
        this.updateView();
    }

    /**
     * 非表示にする
     */
    hide() {
        this.isVisible = false;
        this.updateView();
    }

    /**
     * 現在の表示状態を取得
     */
    getVisible() {
        return this.isVisible;
    }

    /**
     * DOMの状態を更新
     */
    updateView() {
        const header = document.getElementById(this.headerId);
        const container = document.getElementById(this.containerId);

        if (this.isVisible) {
            // iframeの遅延読み込み: 初回表示時にのみ生成する
            if (container && !container.querySelector('iframe')) {
                const iframe = document.createElement('iframe');
                iframe.src = this.defaultUrl;
                iframe.style.width = '100%';
                iframe.style.height = '100%';
                iframe.style.border = '0';
                iframe.setAttribute('frameborder', '0');
                iframe.setAttribute('scrolling', 'no');
                container.appendChild(iframe);
            }

            if (header) header.classList.remove('hidden');
            if (container) container.classList.remove('hidden');
        } else {
            if (header) header.classList.add('hidden');
            if (container) container.classList.add('hidden');
        }
    }
}

// グローバルスコープにAPIを公開して renderer.js から利用可能にする
window.calendarAPI = new CalendarManager();