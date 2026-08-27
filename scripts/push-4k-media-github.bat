@echo off
REM Push full-quality 4K theme media to GitHub (requires Git + Git LFS).
setlocal
cd /d "%~dp0.."

where git >nul 2>&1 || (
  echo Git is not installed. Install from https://git-scm.com/download/win then re-run.
  exit /b 1
)

git lfs version >nul 2>&1 || (
  echo Git LFS is not installed. Run: git lfs install
  exit /b 1
)

if not exist .git (
  git init -b main
  git lfs install
  git lfs track "github-media/4k/videos/**"
  git lfs track "github-media/4k/screenshots/**"
)

git add .gitattributes github-media/4k/ scripts/capture-4k-theme-media.js package.json
git status

echo.
echo If remote is not set, create a GitHub repo then:
echo   git remote add origin https://github.com/YOUR_USER/ronkbonk-4k-media.git
echo   git commit -m "Add 4K theme screenshots and walkthrough videos"
echo   git push -u origin main
echo.
echo Or set GITHUB_REPO=owner/repo and run with gh:
echo   gh repo create ronkbonk-4k-media --public --source=. --push
