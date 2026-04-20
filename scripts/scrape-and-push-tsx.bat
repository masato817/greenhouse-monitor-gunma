@echo off
REM 24h PC (task scheduler) entry: fetch+reset -> scrape -> update public -> push if changed
REM Assumption: this PC has git user.name/email set and can push.
REM Assumption: this PC is scrape-only. Do not edit sources by hand (reset --hard wipes local).
REM Set SKIP_GIT_SYNC=1 to skip fetch+reset (offline test etc).
REM Unified with v1 approach: fetch + reset --hard to prevent divergence.
setlocal EnableExtensions EnableDelayedExpansion
set "REPO_ROOT=%~dp0.."
cd /d "%REPO_ROOT%" || exit /b 1

set "LOG_DIR=%REPO_ROOT%\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul
set "LOGFILE=%LOG_DIR%\task-scrape-push.log"

echo.>> "%LOGFILE%"
echo ===== %date% %time% SESSION START cwd=%CD% =====>> "%LOGFILE%"

if "%SKIP_GIT_SYNC%"=="1" (
  echo SKIP_GIT_SYNC=1: fetch/reset skipped.>> "%LOGFILE%"
) else (
  echo ----- git fetch origin ----- >> "%LOGFILE%"
  git fetch origin >> "%LOGFILE%" 2>&1
  set "FETCH_EC=!ERRORLEVEL!"
  if not "!FETCH_EC!"=="0" (
    echo git fetch failed code=!FETCH_EC!. Check network/credential. Log: %LOGFILE%
    exit /b 1
  )
  echo ----- git reset --hard origin/main ----- >> "%LOGFILE%"
  REM Force sync with remote. Local uncommitted edits and local commits are discarded.
  git reset --hard origin/main >> "%LOGFILE%" 2>&1
  set "RESET_EC=!ERRORLEVEL!"
  if not "!RESET_EC!"=="0" (
    echo git reset failed code=!RESET_EC!. Log: %LOGFILE%
    exit /b 1
  )
)

echo ===== %date% %time% SCRAPE START =====>> "%LOGFILE%"
echo cwd=%CD%>> "%LOGFILE%"
call npm run scrape >> "%LOGFILE%" 2>&1
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
REM git diff --cached --quiet: no diff=0 / has diff=1
if "!DIFF_EC!"=="0" (
  echo No staged diff for index.html or gunma.html. Nothing to push.>> "%LOGFILE%"
  echo Hint: If dashboards were skipped, check combined.log for 0 rows or Sheets errors.>> "%LOGFILE%"
  exit /b 0
)

echo ===== GIT COMMIT/PUSH =====>> "%LOGFILE%"
git commit -m "chore: update dashboards from scheduled scrape" >> "%LOGFILE%" 2>&1
set "COMMIT_EC=!ERRORLEVEL!"
if not "!COMMIT_EC!"=="0" (
  echo git commit failed code=!COMMIT_EC!. Set: git config --global user.name / user.email>> "%LOGFILE%"
  exit /b 1
)
git push origin HEAD >> "%LOGFILE%" 2>&1
set "PUSH_EC=!ERRORLEVEL!"
if not "!PUSH_EC!"=="0" (
  echo git push failed code=!PUSH_EC!. Check credential or network.>> "%LOGFILE%"
  exit /b 1
)
git log -1 --oneline >> "%LOGFILE%" 2>&1
echo ===== PUSH OK =====>> "%LOGFILE%"
exit /b 0