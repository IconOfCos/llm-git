# 前置き

ClaudeCode + Claude Sonnet 4で作成 指示出しだけで1行も書いていません  
以下AI生成文

# GitHubリポジトリQA Chatbot

GitHubリポジトリをローカルでインデックス化し、OpenAIのGPTと埋め込みモデルを使用してコードベースに関する質問に答えるTypeScriptベースのチャットボットです。

## 機能

- 📥 GitHubリポジトリのローカルクローン・インデックス化
- ✂️ オーバーラップ付きインテリジェントテキストチャンク化
- 🧠 OpenAI APIを使用したベクトル埋め込み
- 💾 効率的な類似性検索のためのSQLiteデータベース
- 🤖 コンテキスト認識機能付き対話型QAインターフェース
- 📊 リポジトリサマリーと統計情報

## セットアップ

1. **依存関係のインストール:**
   ```bash
   npm install
   ```

2. **環境設定:**
   ```bash
   cp .env.example .env
   # .envファイルを編集してOpenAI APIキーを追加
   ```

3. **プロジェクトのビルド:**
   ```bash
   npm run build
   ```

## 使用方法

### リポジトリのインデックス化

```bash
npm run dev index <リポジトリURL> <リポジトリ名> [ローカルパス]
```

例:
```bash
npm run dev index https://github.com/microsoft/vscode vscode ./repos/vscode
```

### チャットインターフェースの開始

```bash
npm run dev chat [リポジトリ名]
```

例:
```bash
# 特定のリポジトリとチャット
npm run dev chat vscode

# 全てのインデックス化されたリポジトリを対象にチャット
npm run dev chat
```

### 統計情報の表示

```bash
npm run dev stats
```

### チャット内コマンド

- コードベースに関する質問を入力
- `summary` - リポジトリサマリーの生成
- `quit` または `exit` - チャットの終了

## 設定

`.env`ファイルの環境変数:

| 変数名 | デフォルト値 | 説明 |
|--------|-------------|------|
| `OPENAI_API_KEY` | - | OpenAI APIキー（必須） |
| `DATABASE_PATH` | `./data/chatbot.db` | SQLiteデータベースのパス |
| `EMBEDDING_MODEL` | `text-embedding-ada-002` | OpenAI埋め込みモデル |
| `CHAT_MODEL` | `gpt-4-turbo-preview` | OpenAIチャットモデル |
| `MAX_CHUNK_SIZE` | `1000` | チャンクあたりの最大トークン数 |
| `CHUNK_OVERLAP` | `200` | チャンク間のオーバーラップ |

## アーキテクチャ

システムは以下の主要モジュールで構成されています:

- **GitLoader** (`src/gitLoader.ts`) - リポジトリのクローンとファイル抽出
- **Chunker** (`src/chunker.ts`) - テキストを管理可能なチャンクに分割
- **Embedder** (`src/embedder.ts`) - OpenAI APIによるベクトル埋め込み生成
- **VectorStore** (`src/store.ts`) - ベクトル類似性検索機能付きSQLiteデータベース
- **Chatbot** (`src/chatbot.ts`) - 質問応答とチャットロジックの処理

## 使用例ワークフロー

1. **リポジトリのインデックス化:**
   ```bash
   npm run dev index https://github.com/facebook/react react
   ```

2. **チャットの開始:**
   ```bash
   npm run dev chat react
   ```

3. **質問の実行:**
   ```
   ❓ Question: Reactはコンポーネントライフサイクルをどのように処理しますか？
   ❓ Question: useStateフックの目的は何ですか？
   ❓ Question: summary
   ```

## ライセンス

MIT