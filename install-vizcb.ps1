# install-vizcb.ps1 - 一键安装 vizcb-codeblock-visualizer 到 DSH profile
# 用法:  powershell -ExecutionPolicy Bypass -File install-vizcb.ps1
#        powershell -ExecutionPolicy Bypass -File install-vizcb.ps1 -ProfileName web
# 说明: 按 package.json files 白名单复制插件（排除 .git / test / .github 等开发文件）
#       -> 写入 dsh.profile.bundles -> 缺依赖时 npm install -> 校验
# 兼容两种布局：完整包（插件在 vizcb-codeblock-visualizer/ 子目录，自带 node_modules）
#               与 git 克隆（插件在仓库根目录，无 node_modules）。
param(
  [string]$ProfileName = "desktop",
  [string]$SourceDir = ""
)
$ErrorActionPreference = "Stop"
$enc = New-Object System.Text.UTF8Encoding($false)   # 无 BOM，避免应用 JSON 解析崩溃

if ([string]::IsNullOrEmpty($SourceDir)) {
  $sub = Join-Path $PSScriptRoot "vizcb-codeblock-visualizer"
  if (Test-Path (Join-Path $sub "package.json")) { $SourceDir = $sub }
  else { $SourceDir = $PSScriptRoot }
}

$profileRoot = Join-Path $HOME (".dsh\profiles\" + $ProfileName)
if (-not (Test-Path $profileRoot)) { Write-Error "找不到 profile: $profileRoot"; exit 1 }
if (-not (Test-Path (Join-Path $SourceDir "package.json"))) { Write-Error "找不到插件源目录: $SourceDir"; exit 1 }

$dest = Join-Path $profileRoot "node_modules\vizcb-codeblock-visualizer"
Write-Host "[1/4] 复制插件 -> $dest"

# 按 package.json 的 files 白名单复制；读不到就退回固定清单。
$files = @("lib/index.js", "lib/client.js", "lib/mermaid-worker.mjs", "cordis.patch.yml", "README.md", "package.json")
try {
  $pj = Get-Content (Join-Path $SourceDir "package.json") -Raw | ConvertFrom-Json
  if ($pj.files -is [array] -and @($pj.files).Count -gt 0) { $files = @($pj.files) }
} catch { Write-Warning "读取 package.json 失败，使用默认白名单" }

New-Item -ItemType Directory -Path $dest -Force | Out-Null
Get-ChildItem $dest -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
foreach ($f in $files) {
  $src = Join-Path $SourceDir $f
  if (-not (Test-Path $src)) { Write-Warning "  跳过缺失文件: $f"; continue }
  $tgt = Join-Path $dest $f
  New-Item -ItemType Directory -Path (Split-Path $tgt) -Force | Out-Null
  Copy-Item $src $tgt -Recurse -Force
}

# 完整包布局自带 node_modules 时一并复制；否则走 npm install。
$srcNM = Join-Path $SourceDir "node_modules"
$copiedNM = $false
if (Test-Path $srcNM) {
  Write-Host "  复制随包 node_modules..."
  Copy-Item $srcNM (Join-Path $dest "node_modules") -Recurse -Force
  $copiedNM = $true
}

Write-Host "[2/4] 检查依赖"
if ($copiedNM -and (Test-Path (Join-Path $dest "node_modules\mermaid"))) {
  Write-Host "  随包依赖已就位，跳过"
} elseif (-not (Test-Path (Join-Path $dest "node_modules\mermaid"))) {
  Write-Host "  node_modules 缺失，执行 npm install（需要本机有 npm）..."
  Push-Location $dest
  try { npm install --no-audit --no-fund } finally { Pop-Location }
  if (-not (Test-Path (Join-Path $dest "node_modules\mermaid"))) { Write-Error "npm install 失败，请检查网络或手动安装依赖"; exit 1 }
} else {
  Write-Host "  依赖已存在，跳过"
}

Write-Host "[3/4] 写入 bundles 清单"
$pjPath = Join-Path $profileRoot "package.json"
if (-not (Test-Path $pjPath)) { Write-Error "找不到 $pjPath"; exit 1 }
$raw = [System.IO.File]::ReadAllText($pjPath)
$pj = $raw | ConvertFrom-Json
$bundles = @($pj.dsh.profile.bundles)
if ($bundles -notcontains "vizcb-codeblock-visualizer") {
  $bundles += "vizcb-codeblock-visualizer"
  $pj.dsh.profile.bundles = $bundles
  [System.IO.File]::WriteAllText($pjPath, ($pj | ConvertTo-Json -Depth 8), $enc)
  Write-Host "  已添加 vizcb-codeblock-visualizer"
} else {
  Write-Host "  已存在，跳过"
}

Write-Host "[4/4] 校验"
$check = [System.IO.File]::ReadAllText($pjPath)
if ($check.Length -gt 0 -and $check[0] -eq [char]0xFEFF) { Write-Error "写入带 BOM，安装中止"; exit 1 }
$null = $check | ConvertFrom-Json
Write-Host "  package.json 校验通过"

Write-Host ""
Write-Host "OK 安装完成，重启 DeepSeek Harness 生效。"
Write-Host "卸载：删除 bundles 里的 vizcb-codeblock-visualizer 条目 + 删除插件目录后重启。"
