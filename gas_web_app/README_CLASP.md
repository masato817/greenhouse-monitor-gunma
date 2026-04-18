# Claspを使ったデプロイ手順

`clasp` を使うと、ローカルのターミナルから直接GASを更新・デプロイできます。

## 前提条件
- Node.js がインストールされていること

## 手順

1. **Claspのインストール（未インストールの場合）**
   ```bash
   npm install -g @google/clasp
   ```

2. **Googleログイン**
   ```bash
   clasp login
   ```
   ブラウザが開くので、スプレッドシートへのアクセス権を持つGoogleアカウントでログインします。

3. **プロジェクトの作成**
   `gas_web_app` フォルダに移動して実行します。
   ```bash
   cd gas_web_app
   clasp create --type webapp --title "Greenhouse Monitor Web App" --rootDir .
   ```
   ※ `.clasp.json` が作成されます。

4. **コードのアップロード**
   ```bash
   clasp push
   ```

5. **デプロイ**
   ```bash
   clasp deploy --description "Initial deploy"
   ```

6. **URLの確認**
   出力されたURL、または以下コマンドで開きます。
   ```bash
   clasp open-web-app
   ```

## スクリプトプロパティの設定（必須）

デプロイ前に、スプレッドシートIDをスクリプトプロパティに設定する必要があります。

1. **GASエディタを開く**
   ```bash
   clasp open-script
   ```

2. **プロジェクト設定を開く**
   - 左側のメニューから「⚙️ プロジェクトの設定」をクリック

3. **スクリプトプロパティを追加**
   - 「スクリプトプロパティを追加」をクリック
   - プロパティ名: `SPREADSHEET_ID`
   - 値: スプレッドシートのID（URLの `/d/` と `/edit` の間の文字列）
   - 「スクリプトプロパティを保存」をクリック

## 注意点
- **初回**: 上記の「スクリプトプロパティの設定」を必ず行ってください。
- **更新時**: コードを修正したら `clasp push` -> `clasp deploy` で反映されます。
  - Webアプリの場合、**新しいバージョンを作成しないとURL先のコードが更新されない**ため、必ず `clasp deploy` (または Web UIで「デプロイを管理」>「新バージョン」) が必要です。
  - テスト用URL (`clasp open` で開くdevモード) なら `clasp push` だけで即反映されます。
