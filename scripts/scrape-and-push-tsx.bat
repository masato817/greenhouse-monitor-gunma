@echo off
REM 24h稼働PC用: スクレイプ → public 更新 → 変更があれば git push（GitHub Pages 反映）
REM 前提: このPCで一度「git config user.name / user.email」と「git push」成功済みであること。
setlocal EnableExtensions EnableDelayedExpansion
set "REPO_ROOT=%~dp0.."
cd /d "%REPO_ROOT%" || exit /b 1

set "LOG_DIR=%REPO_ROOT%\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul
set "LOGFILE=%LOG_DIR%\task-scrape-push.log"

echo.>> "%LOGFILE%"
echo ===== %date% %time% SCRAPE START =====>> "%LOGFILE%"
echo cwd=%CD%>> "%LOGFILE%"
call npx tsx src/app.ts --scrape >> "%LOGFILE%" 2>&1
set "SCRAPE_EC=!ERRORLEVEL!"
echo ===== SCRAPE END code=!SCRAPE_EC! =====>> "%LOGFILE%"
if not "!SCRAPE_EC!"=="0" (
  echo Scrape failed, skip git push. Log: %LOGFILE%
  exit /b 1
)

echo ----- git status public ----- >> "%LOGFILE%"
git status --short public >> "%LOGFILE%" 2>&1

git add public/index.html public/gunma.html >> "%LOGFILE%" 2>&1
git diff --cached --quiet
set "DIFF_EC=!ERRORLEVEL!"
REM git diff --cached --quiet: 差分なし=0 / 差分あり=1
if "!DIFF_EC!"=="0" (
  echo No staged diff for index.html or gunma.html. Nothing to push.>> "%LOGFILE%"
  echo Hint: If dashboards were skipped, check combined.log for 0件 or Sheets errors.>> "%LOGFILE%"
  exit /b 0
)

echo ===== GIT COMMIT/PUSH =====>> "%LOGFILE%"
git commit -m "chore: update dashboards from scheduled scrape" >> "%LOGFILE%" 2>&1
set "COMMIT_EC=!ERRORLEVEL!"
if not "!COMMIT_EC!"=="0" (
  echo git commit failed code=!COMMIT_EC!. Set: git config --global user.name / user.email>> "%LOGFILE%"
  exit /b 1
)
git push origin main >> "%LOGFILE%" 2>&1
set "PUSH_EC=!ERRORLEVEL!"
if not "!PUSH_EC!"=="0" (
  echo git push failed code=!PUSH_EC!. Check credential or network.>> "%LOGFILE%"
  exit /b 1
)
git log -1 --oneline >> "%LOGFILE%" 2>&1
echo ===== PUSH OK =====>> "%LOGFILE%"
exit /b 0
