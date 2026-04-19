@echo off
REM スクレイプ後に GitHub Pages へ反映するため public の HTML を push する
setlocal
set "REPO_ROOT=%~dp0.."
cd /d "%REPO_ROOT%" || exit /b 1

git add public/index.html public/gunma.html
git diff --cached --quiet
if %ERRORLEVEL% equ 0 (
  echo No changes in public dashboards. Nothing to push.
  exit /b 0
)
git commit -m "chore: update dashboards from local scrape"
git push origin main
exit /b %ERRORLEVEL%
