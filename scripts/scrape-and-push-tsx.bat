@echo off
REM 24h稼働PC用: スクレイプ → public 更新 → 変更があれば git push（GitHub Pages 反映）
REM タスクスケジューラで 10分毎 等にこのファイルを起動する。
setlocal
set "REPO_ROOT=%~dp0.."
cd /d "%REPO_ROOT%" || exit /b 1

set "LOG_DIR=%REPO_ROOT%\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul
set "LOGFILE=%LOG_DIR%\task-scrape-push.log"

echo.>> "%LOGFILE%"
echo ===== %date% %time% SCRAPE START =====>> "%LOGFILE%"
call npx tsx src/app.ts --scrape >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo Scrape failed, skip git push. Log: %LOGFILE%
  exit /b 1
)
echo ===== SCRAPE OK =====>> "%LOGFILE%"

git add public/index.html public/gunma.html
git diff --cached --quiet
if errorlevel 1 goto do_push
echo No HTML changes. Nothing to push.>> "%LOGFILE%"
exit /b 0

:do_push
echo ===== GIT PUSH =====>> "%LOGFILE%"
git commit -m "chore: update dashboards from scheduled scrape" >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo git commit failed.>> "%LOGFILE%"
  exit /b 1
)
git push origin main >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo git push failed.>> "%LOGFILE%"
  exit /b 1
)
echo ===== PUSH OK =====>> "%LOGFILE%"
exit /b 0
