# Discord Unlock - instalador e atualizador com Cloudflare + GitHub Releases
# Uso opcional: .\install.ps1 -GithubManifestUrl 'https://github.com/USUARIO/REPOSITORIO/releases/latest/download/update-manifest.json'
[CmdletBinding()]
param(
  [string]$GithubManifestUrl = 'https://github.com/stefystars-one/dc-unlcok-/releases/latest/download/update-manifest.json',
  [string]$LicenseKey = '',
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$cloudManifestUrl = 'https://discord-unlock-api.st4rs.workers.dev/updates/update-manifest.json'
$cloudLegacyBaseUrl = 'https://discord-unlock-api.st4rs.workers.dev/updates'
$installDir = 'C:\DiscordUnlock'
$appPath = Join-Path $installDir 'DiscordUnlock.exe'
$tempPath = Join-Path $installDir 'DiscordUnlock.download'
$backupPath = Join-Path $installDir 'DiscordUnlock.exe.previous'
$configPath = Join-Path $installDir 'update_sources.json'

function Get-Text([string]$Url) {
  try {
    $body = (Invoke-WebRequest -UseBasicParsing -Uri $Url -MaximumRedirection 8 -TimeoutSec 25).Content
    # Drive serves binary content as byte[] and may include a UTF-8 BOM before JSON.
    if ($body -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($body).TrimStart([char]0xFEFF) }
    return ([string]$body).TrimStart([char]0xFEFF)
  } catch {
    return $null
  }
}

function Test-Sha256([string]$Value) {
  return $Value -match '^[a-fA-F0-9]{64}$'
}

function Get-Artifact([object]$Manifest, [string]$Name) {
  if ($null -eq $Manifest.artifacts) { return $null }
  $artifact = $Manifest.artifacts.$Name
  if ($null -eq $artifact -and $Name -ne 'DiscordUnlock.exe') {
    $artifact = $Manifest.artifacts.'DiscordUnlock.exe'
  }
  if ($null -eq $artifact -or -not $artifact.url -or -not (Test-Sha256 ([string]$artifact.sha256))) {
    return $null
  }
  return $artifact
}

function Get-ManifestCandidate([string]$Url, [string]$Source) {
  $text = Get-Text $Url
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  try {
    $manifest = $text | ConvertFrom-Json
    $artifact = Get-Artifact $manifest 'DiscordUnlock.exe'
    $version = [version]([string]$manifest.version)
    if ($null -eq $artifact) { return $null }
    return [pscustomobject]@{
      Version = $version
      Url = [string]$artifact.url
      Sha256 = ([string]$artifact.sha256).ToLowerInvariant()
      Source = $Source
    }
  } catch {
    return $null
  }
}

function Get-CloudLegacyCandidate {
  try {
    $versionText = (Get-Text "$cloudLegacyBaseUrl/version.txt").Trim().Replace(',', '.')
    $hash = (Get-Text "$cloudLegacyBaseUrl/DiscordUnlock.exe.sha256").Trim().ToLowerInvariant()
    if (-not (Test-Sha256 $hash)) { return $null }
    return [pscustomobject]@{
      Version = [version]$versionText
      Url = "$cloudLegacyBaseUrl/DiscordUnlock.exe"
      Sha256 = $hash
      Source = 'Cloudflare (legado)'
    }
  } catch {
    return $null
  }
}

function Remove-LegacyInstallArtifacts {
  param([string]$InstallPath)

  # Mantem somente o executavel instalado, a configuracao de fontes e atalhos.
  # Dados pessoais (licenca, sons, temas e configuracoes) ficam fora desta pasta.
  $legacyFiles = @(
    'DiscordUnlock.download',
    'DiscordUnlock.exe.previous',
    'DiscordUnlock.exe.old',
    'DiscordUnlock.exe.bak',
    'DiscordUnlock_old.exe',
    'DiscordUnlock_updated.exe',
    'DiscordUnlock_Web.exe',
    'DiscordUnlock_Chrome.exe',
    'DiscordUnlock_beta.exe',
    'DiscordUnlock_recorder_test.exe',
    'DiscordUnlock_nativecrosshair.exe',
    'DiscordUnlock.exe.new',
    'DiscordUnlock.exe.new.cmd',
    'DiscordUnlock.exe.update-pending',
    'DiscordUnlock.exe.rollback.cmd',
    'DiscordUnlock.exe.failed',
    'DiscordUnlock.exe.update.log'
  )
  $removed = 0
  foreach ($name in $legacyFiles) {
    $candidate = Join-Path $InstallPath $name
    if (Test-Path -LiteralPath $candidate) {
      Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
      $removed++
    }
  }

  foreach ($folder in @('.update', 'update-temp', 'temp-update', 'old-version')) {
    $candidate = Join-Path $InstallPath $folder
    if (Test-Path -LiteralPath $candidate) {
      Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
      $removed++
    }
  }

  if ($removed -gt 0) {
    Write-Host ("Removidos " + $removed + " arquivo(s) temporario(s) ou de versoes antigas.") -ForegroundColor DarkGray
  }
}

try {
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  $running = @(Get-Process -Name 'DiscordUnlock' -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -eq $appPath } catch { $false }
  })
  foreach ($process in $running) {
    Write-Host 'Fechando a instância instalada para aplicar a atualização...' -ForegroundColor DarkGray
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
    try { Wait-Process -Id $process.Id -Timeout 12 -ErrorAction Stop } catch {}
  }

  if ([string]::IsNullOrWhiteSpace($GithubManifestUrl) -and (Test-Path -LiteralPath $configPath)) {
    try {
      $savedConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
      $GithubManifestUrl = [string]$savedConfig.github_release_manifest_url
    } catch {}
  }

  # As duas consultas sempre sao feitas antes de escolher qualquer arquivo.
  $candidates = @()
  $cloud = Get-ManifestCandidate $cloudManifestUrl 'Cloudflare'
  if ($null -eq $cloud) { $cloud = Get-CloudLegacyCandidate }
  if ($null -ne $cloud) { $candidates += $cloud }

  if (-not [string]::IsNullOrWhiteSpace($GithubManifestUrl)) {
    $drive = Get-ManifestCandidate $GithubManifestUrl 'GitHub Releases'
    if ($null -ne $drive) { $candidates += $drive }
  }

  if ($candidates.Count -eq 0) {
    throw 'Nenhuma fonte respondeu com um manifesto de atualizacao valido.'
  }

  $selected = $null
  foreach ($candidate in ($candidates | Sort-Object -Property Version -Descending)) {
    Write-Host ("Baixando Discord Unlock " + $candidate.Version + " via " + $candidate.Source + "...") -ForegroundColor Cyan
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $candidate.Url -OutFile $tempPath -MaximumRedirection 12 -TimeoutSec 900
      $actual = (Get-FileHash -LiteralPath $tempPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -eq $candidate.Sha256) {
        $selected = $candidate
        break
      }
    } catch {}
  }
  if ($null -eq $selected) {
    throw 'Nenhum espelho entregou um arquivo com SHA-256 valido.'
  }

  Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $appPath) { Move-Item -LiteralPath $appPath -Destination $backupPath -Force }
  Move-Item -LiteralPath $tempPath -Destination $appPath -Force
  Remove-LegacyInstallArtifacts -InstallPath $installDir

  @{
    cloudflare_manifest_url = $cloudManifestUrl
    github_release_manifest_url = $GithubManifestUrl
  } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8

  $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Discord Unlock.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $appPath
  $shortcut.WorkingDirectory = $installDir
  $shortcut.IconLocation = "$appPath,0"
  $shortcut.Description = 'Discord Unlock'
  $shortcut.Save()

  $startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $startMenuShortcut = Join-Path $startMenuDir 'Discord Unlock.lnk'
  $startMenu = $shell.CreateShortcut($startMenuShortcut)
  $startMenu.TargetPath = $appPath
  $startMenu.WorkingDirectory = $installDir
  $startMenu.IconLocation = "$appPath,0"
  $startMenu.Description = 'Discord Unlock'
  $startMenu.Save()

  if ([string]::IsNullOrWhiteSpace($LicenseKey)) {
    $LicenseKey = Read-Host 'Cole sua chave agora, ou pressione Enter para ativar depois'
  }
  if ($LicenseKey.Trim()) {
    Set-Clipboard -Value $LicenseKey.Trim()
    Write-Host 'Chave copiada. Cole-a na tela de ativacao.' -ForegroundColor Yellow
  }

  Write-Host ('Atualizacao aplicada: versao ' + $selected.Version + '.') -ForegroundColor Green
  Write-Host 'Instalacao concluida em C:\DiscordUnlock.' -ForegroundColor Green
  Write-Host 'Abra pelo atalho Discord Unlock na Area de Trabalho ou no Menu Iniciar.' -ForegroundColor Cyan
  if (-not $NoLaunch) { Start-Process -FilePath $appPath }
} catch {
  Write-Host ("Instalacao nao concluida: " + $_.Exception.Message) -ForegroundColor Red
} finally {
  Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
}


