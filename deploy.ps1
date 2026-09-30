# 3Dtravelmap deploy: commit + asset-version stamp + push + Pages deploy.
# Usage (repo root):  .\deploy.ps1 "commit message"
$ErrorActionPreference = "Stop"

$msg = ($args -join " ").Trim()
if (-not $msg) { $msg = Read-Host "commit message" }
if (-not $msg) { throw "commit message required" }

git add -A
git commit -m $msg
$sha = (git rev-parse --short HEAD).Trim()
(Get-Content frontend/index.html) -replace "\?v=[0-9a-f]+", ("?v=" + $sha) | Set-Content frontend/index.html
git add frontend/index.html
git commit --amend --no-edit
git push origin master
$split = (git subtree split --prefix frontend master | Select-Object -Last 1).Trim()
git push origin "${split}:gh-pages" --force
git log --oneline -n 1 origin/gh-pages
