[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+(\.\d+){1,2}$')]
  [string]$Version,
  [switch]$SkipBuild,
  [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSCommandPath
$serverRoot = Join-Path $projectRoot 'server'
$updatesRoot = Join-Path $serverRoot 'public\updates'
$dependenciesRoot = Join-Path $updatesRoot 'dependencies'
$sourceFile = Join-Path $projectRoot 'gui_main.cpp'
$buildFile = Join-Path $projectRoot 'build.ps1'

if (-not (Test-Path -LiteralPath $serverRoot)) { throw "Servidor nao encontrado: $serverRoot" }
if (-not (Test-Path -LiteralPath $sourceFile)) { throw "Fonte nao encontrado: $sourceFile" }

$source = [System.IO.File]::ReadAllText($sourceFile)
$versionPattern = 'const std::string CURRENT_VERSION = [\x22][^\x22]+[\x22];'
if (-not [regex]::IsMatch($source, $versionPattern)) { throw 'Nao foi possivel localizar CURRENT_VERSION no codigo.' }
$replacement = 'const std::string CURRENT_VERSION = ' + [char]34 + $Version + [char]34 + [char]59
$updated = ([regex]$versionPattern).Replace($source, $replacement, 1)
[System.IO.File]::WriteAllText($sourceFile, $updated, [Text.UTF8Encoding]::new($false))

if (-not $SkipBuild) {
  & $buildFile
  if ($LASTEXITCODE -ne 0) { throw 'A compilacao falhou.' }
}

New-Item -ItemType Directory -Force -Path $updatesRoot, $dependenciesRoot | Out-Null
# Edições Web/Chrome foram descontinuadas. Seus nomes permanecem como aliases
# para atualizar instalações antigas diretamente para o binário Desktop atual.
$executables = @(
  @{ Target = 'DiscordUnlock.exe'; Source = 'DiscordUnlock.exe' },
  @{ Target = 'DiscordUnlock_Special.exe'; Source = 'DiscordUnlock_Special.exe' },
  @{ Target = 'DiscordUnlock_Web.exe'; Source = 'DiscordUnlock.exe' },
  @{ Target = 'DiscordUnlock_Web_Special.exe'; Source = 'DiscordUnlock_Special.exe' },
  @{ Target = 'DiscordUnlock_Chrome.exe'; Source = 'DiscordUnlock.exe' },
  @{ Target = 'DiscordUnlock_Chrome_Special.exe'; Source = 'DiscordUnlock_Special.exe' }
)
foreach ($entry in $executables) {
  $name = $entry.Target
  $sourcePath = Join-Path $projectRoot $entry.Source
  if (-not (Test-Path -LiteralPath $sourcePath)) { throw "Executavel ausente: $sourcePath" }
  $targetPath = Join-Path $updatesRoot $name
  Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
  (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLowerInvariant() | Set-Content -LiteralPath ($targetPath + '.sha256') -NoNewline -Encoding ascii
}
$Version | Set-Content -LiteralPath (Join-Path $updatesRoot 'version.txt') -NoNewline -Encoding ascii
# Compatibilidade com atualizadores que ainda consultam um único hash para a
# edição padrão antes de entenderem o manifesto por artefato.
([IO.File]::ReadAllText((Join-Path $updatesRoot 'DiscordUnlock.exe.sha256'))).Trim().ToLowerInvariant() |
  Set-Content -LiteralPath (Join-Path $updatesRoot 'version_sha256.txt') -NoNewline -Encoding ascii

# Manifesto unico: o executavel e o instalador usam este mesmo formato.
$publicUpdatesUrl = 'https://discord-unlock-api.st4rs.workers.dev/updates'
$manifestArtifacts = [ordered]@{}
foreach ($entry in $executables) {
  $name = $entry.Target
  $hash = ([IO.File]::ReadAllText((Join-Path $updatesRoot ($name + '.sha256')))).Trim().ToLowerInvariant()
  $manifestArtifacts[$name] = [ordered]@{
    url = "$publicUpdatesUrl/$name"
    sha256 = $hash
  }
}
$manifest = [ordered]@{
  schema = 1
  version = $Version
  artifacts = $manifestArtifacts
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $updatesRoot 'update-manifest.json') -Encoding utf8
foreach ($asset in @('motd.txt','servers.json','themes_catalog.json')) {
  $sourcePath = Join-Path $projectRoot $asset
  if (Test-Path -LiteralPath $sourcePath) { Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $updatesRoot $asset) -Force }
}
foreach ($asset in @('wiresock.zip','protonvpn-wg-confgen.exe','protonvpn-wg-confgen.zip')) {
  $sourcePath = Join-Path $projectRoot (Join-Path 'bin' $asset)
  if (-not (Test-Path -LiteralPath $sourcePath)) { throw "Dependencia ausente: $sourcePath" }
  Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $dependenciesRoot $asset) -Force
}

if (-not $SkipDeploy) {
  $nodeDir = 'C:\Users\Stefany\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
  if (Test-Path -LiteralPath $nodeDir) { $env:Path = "$nodeDir;$env:Path" }
  # Credenciais nunca ficam no repositório. O Wrangler usa a sessão local ou
  # CLOUDFLARE_API_TOKEN fornecido pelo ambiente de CI/publicação.
  Push-Location $serverRoot
  try {
    npx wrangler deploy
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao publicar a API.' }
    npx wrangler deploy -c wrangler.admin.jsonc
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao publicar o painel administrativo.' }
  } finally { Pop-Location }
}

Write-Host "Versao $Version preparada no Cloudflare em: $updatesRoot"
