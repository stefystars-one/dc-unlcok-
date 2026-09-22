# Discord Unlock - instalador e atualizador com Cloudflare + Google Drive
# Uso opcional: .\install.ps1 -GoogleDriveManifestUrl 'https://drive.usercontent.google.com/download?id=SEU_ID&export=download&confirm=t'
[CmdletBinding()]
param(
  [string]$GoogleDriveManifestUrl = 'https://drive.usercontent.google.com/download?id=1kxBp8o-q4bj0gTE-Tb55qH4uT_5irC0f&export=download&confirm=t',
  [string]$LicenseKey = '',
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$cloudManifestUrl = 'https://discord-unlock-api.st4rs.workers.dev/updates/update-manifest.json'
$cloudLegacyBaseUrl = 'https://discord-unlock-api.st4rs.workers.dev/updates'
$installDir = Join-Path $env:LOCALAPPDATA 'Discord Unlock'
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

try {
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  $running = @(Get-Process -Name 'DiscordUnlock' -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -eq $appPath } catch { $false }
  })
  if ($running.Count -gt 0) { throw 'Feche o Discord Unlock antes de instalar ou atualizar.' }

  if ([string]::IsNullOrWhiteSpace($GoogleDriveManifestUrl) -and (Test-Path -LiteralPath $configPath)) {
    try {
      $savedConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
      $GoogleDriveManifestUrl = [string]$savedConfig.google_drive_manifest_url
    } catch {}
  }

  # As duas consultas sempre sao feitas antes de escolher qualquer arquivo.
  $candidates = @()
  $cloud = Get-ManifestCandidate $cloudManifestUrl 'Cloudflare'
  if ($null -eq $cloud) { $cloud = Get-CloudLegacyCandidate }
  if ($null -ne $cloud) { $candidates += $cloud }

  if (-not [string]::IsNullOrWhiteSpace($GoogleDriveManifestUrl)) {
    $drive = Get-ManifestCandidate $GoogleDriveManifestUrl 'Google Drive'
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

  @{
    cloudflare_manifest_url = $cloudManifestUrl
    google_drive_manifest_url = $GoogleDriveManifestUrl
  } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8

  $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Discord Unlock.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $appPath
  $shortcut.WorkingDirectory = $installDir
  $shortcut.IconLocation = "$appPath,0"
  $shortcut.Description = 'Discord Unlock'
  $shortcut.Save()

  if ([string]::IsNullOrWhiteSpace($LicenseKey)) {
    $LicenseKey = Read-Host 'Cole sua chave agora, ou pressione Enter para ativar depois'
  }
  if ($LicenseKey.Trim()) {
    Set-Clipboard -Value $LicenseKey.Trim()
    Write-Host 'Chave copiada. Cole-a na tela de ativacao.' -ForegroundColor Yellow
  }

  Write-Host 'Instalacao concluida.' -ForegroundColor Green
  if (-not $NoLaunch) { Start-Process -FilePath $appPath }
} catch {
  Write-Host ("Instalacao nao concluida: " + $_.Exception.Message) -ForegroundColor Red
} finally {
  Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
}


