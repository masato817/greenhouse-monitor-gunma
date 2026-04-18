@echo off
REM Windows タスク スケジューラ用: ビルド済み dist を 1 回だけ実行（--scrape）
REM 事前: npm ci または npm install、npm run build、.env 配置
setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%" || exit /b 1
node dist\app.js --scrape
exit /b %ERRORLEVEL%
