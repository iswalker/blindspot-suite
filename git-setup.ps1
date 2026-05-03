# Finance Suite — Git Setup & Push to GitHub
$ProjDir = "C:\Users\isaac\Desktop\Finance Suite"
$Remote  = "https://github.com/iswalker/finance-suite.git"

Set-Location $ProjDir

Write-Host ""
Write-Host "=========================================="
Write-Host "  Finance Suite  ->  GitHub Setup"
Write-Host "=========================================="

# 1. Clean up any partial .git folder
if (Test-Path ".git") {
    Write-Host ""
    Write-Host "[1/4] Removing partial .git folder..."
    Remove-Item -Recurse -Force ".git"
    Write-Host "  Done."
} else {
    Write-Host ""
    Write-Host "[1/4] No existing .git folder — starting fresh."
}

# 2. Init repo on 'main' branch
Write-Host ""
Write-Host "[2/4] Initialising git repository..."
git init -b main
git config user.name  "Isaac Walker"
git config user.email "isaacalexanderwalker@gmail.com"
Write-Host "  Done."

# 3. Stage everything and commit
Write-Host ""
Write-Host "[3/4] Staging files and creating initial commit..."
git add .
git status --short
git commit -m "Initial commit"
Write-Host "  Done."

# 4. Add remote and push
Write-Host ""
Write-Host "[4/4] Adding remote and pushing to GitHub..."
git remote add origin $Remote
git push -u origin main

Write-Host ""
Write-Host "=========================================="
Write-Host "  All done! Repo is live at:"
Write-Host "  https://github.com/iswalker/finance-suite"
Write-Host "=========================================="
