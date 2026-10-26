# GitHub Actions への切り替え手順

静岡事務所の24時間PC（タスクスケジューラで `scripts/scrape-and-push-tsx.bat` を実行）から、GitHub Actions の定期実行（`.github/workflows/update-data.yml`）へ実行役を移す手順。**上から順に**行う。

## 前提

- 作業する PC に [GitHub CLI](https://cli.github.com/)（`gh`）を入れ、`gh auth login` 済みであること
- 以下のコマンドはリポジトリのフォルダで実行する。別の場所で実行する場合は各コマンドに `--repo masato817/greenhouse-monitor-gunma` を付ける
- このリポジトリは**公開**。secret の値・URL・ID をコミット、Issue、PR、スクリーンショットに書かない

### 用語

| 用語 | 意味 |
|---|---|
| secret | GitHub に暗号化して保存する値。ワークフローからだけ読める。ログに出ても `***` で伏せられる |
| variable | GitHub に保存する公開してよい設定値（例: 定期実行の ON/OFF） |
| サービスアカウント | アプリが Google スプレッドシートを読み書きするための専用 Google アカウント。鍵は JSON ファイル |
| 実行役 | 10分毎にスクレイプして push する主体。今は24時間PC、切り替え後は GitHub Actions |

---

## 1. スプレッドシートでサービスアカウントを「編集者」に戻す

2026-05-02 以降の更新停止の原因。閲覧者のままだと行の追記が毎回失敗する。

1. 24時間PC の `credentials\service-account.json` をメモ帳で開き、`"client_email"` の値（`…@….iam.gserviceaccount.com`）を控える
2. Google スプレッドシート「群馬農場 環境モニタリング」を開き、右上の **共有** を押す
3. 控えたアドレスの権限を **閲覧者 → 編集者** に変える（一覧に無ければ追加して編集者にする）。通知メールは送らなくてよい
4. 確認: 24時間PC の次の実行（日中は10分以内）のあと、リポジトリの `public/status.json` を開き、次を確かめる
   - `"sheets"` → `"append"` → `"ok": true`
   - `"appendFailingSince": null`

> この PR のマージ後は、権限が戻る前でも取得できたデータでダッシュボードは更新される。ただし Sheets への追記失敗が3時間続くと「Freshness Check」が失敗し、通知が届く。

## 2. secrets を登録する

24時間PC の `.env` に書かれている値を GitHub に登録する。値は**コマンドに直接書かない**（PowerShell の履歴に残るため）。`gh secret set 名前` を実行すると入力待ちになるので、値を貼り付けて Enter を押す。

```powershell
gh secret set PROFINDER_URL
gh secret set PROFINDER_USER
gh secret set PROFINDER_PASS
gh secret set PROFINDER_DEVICES
gh secret set PROFARM_URL
gh secret set PROFARM_USER
gh secret set PROFARM_PASS
gh secret set PROFARM_REALTIME_URL
gh secret set SPREADSHEET_ID
gh secret set LINE_CHANNEL_ACCESS_TOKEN
gh secret set LINE_USER_ID
```

サービスアカウントの鍵は JSON ファイルの中身をそのまま登録する（PowerShell）。

```powershell
Get-Content -Raw credentials\service-account.json | gh secret set GOOGLE_SERVICE_ACCOUNT_JSON
```

| secret 名 | `.env` の項目 | 補足 |
|---|---|---|
| `PROFINDER_URL` / `PROFINDER_USER` / `PROFINDER_PASS` | 同名 | 静岡2〜4号・群馬8/9号 |
| `PROFINDER_DEVICES` | 同名 | 未登録なら既定値（全5棟）で動く |
| `PROFARM_URL` / `PROFARM_USER` / `PROFARM_PASS` | 同名 | 静岡1号。`PROFARM_URL` 未登録なら1号は取得しない |
| `PROFARM_REALTIME_URL` | 同名 | ハウスID を含む URL |
| `SPREADSHEET_ID` | 同名 | |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `GOOGLE_SERVICE_ACCOUNT_KEY` が指す JSON ファイルの**中身** | ワークフローが一時ファイルに書き出して使う |
| `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_USER_ID` | 同名 | 前後の空白・改行はアプリ側で除去する |

確認:

```powershell
gh secret list
```

12個（上の表の名前）が並べばよい。値は表示されない。

## 3. 到達性チェックを手動実行する

GitHub のランナーは海外の IP アドレスから接続する。ProFinder・ProFarm が海外 IP を拒否していないかを、ログインせずに確かめる。

```powershell
gh workflow run reachability-check.yml
gh run watch
```

（ブラウザなら: リポジトリの **Actions** → **Reachability Check** → **Run workflow**）

| 結果 | 意味 | 次の行動 |
|---|---|---|
| 両方 `OK（HTTP 200 …）` | 届く | 手順4へ |
| `HTTP 403` / `接続拒否` / `タイムアウト` | 海外 IP を拒否している可能性 | 切り替えを中止し、24時間PC を使い続ける。運用元に海外 IP からの接続可否を問い合わせる |
| `HTTP 503` | 先方のサービス停止中 | 時間を置いて再実行 |
| `secret 未登録` | 手順2の登録漏れ | 手順2をやり直す |

## 4. 定期実行を有効にする（`ACTIONS_SCRAPE_ENABLED=true`）

> **手順4と5は続けて行う。** 両方が動いている間は、Sheets に同じ時刻の行が二重に入り、push も衝突する。

```powershell
gh variable set ACTIONS_SCRAPE_ENABLED --body true
```

最初の1回を待たずに動作を見たい場合は、手順5を済ませてから手動実行する。

```powershell
gh workflow run update-data.yml
gh run watch
```

確認（定期実行は日中10分毎・夜間毎時。GitHub 側の混雑で数分〜数十分遅れることがある）:

- **Actions** → **Update Greenhouse Data** が緑（成功）
- `public/status.json` の `generatedAt` が直近の時刻、`ok: true`
- ダッシュボードのヘッダ「最終」が直近の時刻で、「データが古い」帯が出ていない

## 5. 24時間PC のタスクを止める

24時間PC で **管理者として** PowerShell を開き、タスク名を確かめてから無効にする（タスク名は環境により異なるため確認が必要）。

```powershell
# scrape-and-push-tsx.bat を実行しているタスクを探す
Get-ScheduledTask | Where-Object {
  ($_.Actions.Execute + ' ' + $_.Actions.Arguments) -like '*scrape-and-push*'
} | Select-Object TaskPath, TaskName, State

# 上で表示された TaskName / TaskPath を指定して無効にする（複数あればすべて）
Disable-ScheduledTask -TaskPath '<TaskPath>' -TaskName '<TaskName>'
```

確認: もう一度 `Get-ScheduledTask ... | Select-Object TaskName, State` を実行し、`State` が `Disabled` になっていること。

---

## 切り替え後に一度だけ行う設定

### 失敗通知メールを自分に届くようにする

定期実行（schedule）の失敗通知は、**ワークフローの cron を最後に変更した人**、または**ワークフローを最後に無効→有効にした人**に届く（[GitHub Docs: Notifications for workflow runs](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)）。この PR の作成者は自分ではないため、無効→有効を一度行って通知先を自分にする。

```powershell
gh workflow disable freshness-check.yml
gh workflow enable freshness-check.yml
gh workflow disable update-data.yml
gh workflow enable update-data.yml
```

あわせて GitHub の **Settings → Notifications → Actions** で「Email」と「Only notify for failed workflows」にチェックを入れる。

通知の試験（閾値を極端に小さくして、わざと失敗させる）:

```powershell
gh workflow run freshness-check.yml -f max_age_hours=0.01
```

数分以内に失敗メールが届けばよい（手動実行の通知は実行した本人に届く）。

### 鮮度監視の閾値を変える（任意）

既定は3時間。変える場合:

```powershell
gh variable set FRESHNESS_MAX_AGE_HOURS --body 2
```

---

## 元に戻す（24時間PC に戻す）

1. `gh variable set ACTIONS_SCRAPE_ENABLED --body false`
2. 24時間PC で `Enable-ScheduledTask -TaskPath '<TaskPath>' -TaskName '<TaskName>'`

## 運用メモ

- **鮮度監視（Freshness Check）**: 30分毎に `public/status.json` を見て、次のどちらかで失敗する。実行役が24時間PC でも Actions でも同じように働く
  - いずれのソースでも取得に成功していない状態が閾値（既定3時間）を超えた
  - Sheets への追記失敗が閾値を超えて続いている
  - 一部ソースだけの停止（例: ProFarm だけ 503）は失敗にせず警告に留める。ダッシュボードには「一部ハウスのデータが古い」と表示される
- **公開リポジトリの schedule 停止**: 公開リポジトリでは、60日間リポジトリに活動が無いと定期実行が自動で無効になる（[GitHub Docs: Disabling and enabling a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)）。更新が長く止まった後は Actions 画面で無効になっていないか確認する
- **status.json の中身**: ソース別の最終取得成功時刻、Sheets 追記の成否、ページの表示データ時刻、生成時刻。URL・ID・認証情報は含めない（エラー文中の URL・メールアドレス・長い ID は伏せ字にしている）
