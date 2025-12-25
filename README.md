# Markdown Editor

**Markdown Editor** は、ElectronとCodeMirror 6で構築された、開発者とライターのための高機能な統合執筆環境です。
Notionライクなテーブル編集、リアルタイムプレビュー、Gitクライアント、統合ターミナルを一つのウィンドウに集約。コンテキストスイッチを極限まで減らし、執筆と開発のフローを加速させます。

## ✨ 主な機能

### 📝 強力な編集機能 (Live Preview)
* **Notionライクなテーブル**: マークダウンの表をGUIで直感的に編集可能。行・列のドラッグ移動、リサイズ、右クリックメニューによる追加・削除に対応。
* **リッチなプレビュー**:
    * **数式**: KaTeX (`$$...$$`) による美しい数式レンダリング。
    * **ダイアグラム**: Mermaid記法によるフローチャートやシーケンス図の描画。
    * **Wikiリンク**: `[[ファイル名]]` でプロジェクト内のファイルへ素早くリンク＆ジャンプ（オートコンプリート対応）。
* **コード実行**: JS, Python, Bash などのコードブロックをエディタ上で直接実行し、結果を表示可能。

### 🚀 開発者向けツール
* **統合ターミナル**: `node-pty` と `xterm.js` を採用した高機能ターミナル。PowerShell, Bash, CMDなどをタブ切り替えで複数起動可能。
* **完全なGit GUI**:
    * ステータス確認、ステージング、コミット、プッシュ/プル。
    * ブランチの作成・切り替え・削除。
    * コミット履歴のグラフ表示と、ファイル単位のDiffビューアー。
* **コマンドパレット**: `Ctrl+Shift+P` でほぼ全ての機能にキーボードからアクセス可能。
* **プロジェクト内検索 (Grep)**: 高速な全文検索機能。

### ☁️ クラウド連携とエクスポート
* **クラウド同期対応**: DropboxやGoogle Driveのフォルダでプロジェクトを開くことで、シームレスな同期が可能。
* **PDFエクスポート**: 目次生成、ヘッダー/フッター、テーマ適用など詳細な設定が可能なPDF出力。

## 🛠️ インストールと実行

```bash
# リポジトリのクローン
git clone https://github.com/umaru-channn/markdown_editor.git

# 依存関係のインストール
npm install

# アプリケーションの起動 (開発モード)
npm start

# ビルド (Windows .exe / macOS .dmg 等の生成)
npm run build
```

## ⌨️ 主なショートカットキー

| アクション | Windows / Linux | macOS |
| :--- | :--- | :--- |
| **コマンドパレット** | `Ctrl` + `Shift` + `P` | `Cmd` + `Shift` + `P` |
| **サイドバー切替** | `Ctrl` + `Shift` + `B` | `Cmd` + `Shift` + `B` |
| **ターミナル表示** | `Ctrl` + `@` | `Cmd` + `@` |
| **ファイル検索** | `Ctrl` + `P` | `Cmd` + `P` |
| **検索・置換** | `Ctrl` + `F` | `Cmd` + `F` |
| **設定を開く** | `Ctrl` + `,` | `Cmd` + `,` |
| **新規タブ** | `Ctrl` + `T` | `Cmd` + `T` |
| **タブを閉じる** | `Ctrl` + `W` | `Cmd` + `W` |
| **Zenモード** | ツールバーボタン | ツールバーボタン |

## 🧩 技術スタック

* **Core**: [Electron](https://www.electronjs.org/), [Node.js](https://nodejs.org/)
* **Editor**: [CodeMirror 6](https://codemirror.net/)
* **UI/Styling**: CSS Variables, Native DOM, Preact
* **Git**: [isomorphic-git](https://isomorphic-git.org/) & Git CLI integration
* **Terminal**: [xterm.js](https://xtermjs.org/), [node-pty](https://github.com/microsoft/node-pty)
* **Markdown**: [marked](https://marked.js.org/), [katex](https://katex.org/), [mermaid](https://mermaid.js.org/)

## 📄 ライセンス

CC0-1.0