@echo off
REM タスクスケジューラ用: npx tsx で --scrape を1回実行（ビルド不要）
REM 配置: リポジトリの scripts\ フォルダに置く（親フォルダを REPO として cd する）
setlocal
set "REPO_ROOT=%~dp0.."
cd /d "%REPO_ROOT%" || exit /b 1

set "LOG_DIR=%REPO_ROOT%\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul

set "LOGFILE=%LOG_DIR%\task-scrape-last.log"
echo ===== %date% %time% START =====>> "%LOGFILE%"
call npx tsx src/app.ts --scrape >> "%LOGFILE%" 2>&1
set "EC=%ERRORLEVEL%"
echo ===== %date% %time% END code=%EC% =====>> "%LOGFILE%"
exit /b %EC%
