<#
  Chronicle-Gaia — dagelijkse pg_dump van de lokale database `ai_chat_archive`.

  Waarom: Kopia back-upt alleen bestanden, geen draaiende database. Dit script
  zet elke nacht een consistente dump in K:\Projects\Project Gaia\chronicle-backups,
  een map die Kopia (bron K:\Projects, 02:00) meeneemt.

  Geen wachtwoord in dit script: pg_dump leest het uit
  %APPDATA%\postgresql\pgpass.conf  (formaat: localhost:5432:*:postgres:<wachtwoord>).

  Gebruik:  powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
  Exitcode 0 = dump gelukt en gecontroleerd; anders staat de reden in backup-db.log.
#>
param(
  [string]$PgBin   = 'C:\Program Files\PostgreSQL\18\bin',
  [string]$Db      = 'ai_chat_archive',
  [string]$DbHost  = 'localhost',
  [int]   $Port    = 5432,
  [string]$DbUser  = 'postgres',
  [string]$OutDir  = 'K:\Projects\Project Gaia\chronicle-backups',
  [int]   $Keep    = 14
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $OutDir 'backup-db.log'
function Log($m) { "$(Get-Date -Format 's') $m" | Add-Content -Path $log -Encoding utf8 }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$pgpass = Join-Path $env:APPDATA 'postgresql\pgpass.conf'
if (-not (Test-Path $pgpass) -and -not $env:PGPASSWORD) {
  Log "FOUT: geen pgpass.conf ($pgpass) en geen PGPASSWORD; dump overgeslagen."
  exit 2
}

$stamp  = Get-Date -Format 'yyyyMMdd-HHmm'
$target = Join-Path $OutDir "chronicle-$stamp.dump"
$part   = "$target.part"

try {
  & "$PgBin\pg_dump.exe" -h $DbHost -p $Port -U $DbUser -d $Db -Fc --no-password -f $part
  if ($LASTEXITCODE -ne 0) { throw "pg_dump exitcode $LASTEXITCODE" }

  # Controle: de dump moet te lezen zijn en de tabel `chats` bevatten.
  $toc = & "$PgBin\pg_restore.exe" --list $part
  if ($LASTEXITCODE -ne 0 -or -not ($toc -match 'TABLE .* chats')) { throw 'dump gecontroleerd: tabel chats ontbreekt of dump onleesbaar' }

  Move-Item -Force $part $target
  $mb = [math]::Round((Get-Item $target).Length / 1MB, 1)
  Log "OK: $target ($mb MB)"
} catch {
  if (Test-Path $part) { Remove-Item -Force $part }
  Log "FOUT: $($_.Exception.Message)"
  exit 1
}

# Bewaar de laatste $Keep dumps (ook de handmatige dumps van vóór dit script blijven staan).
Get-ChildItem $OutDir -Filter 'chronicle-????????-????.dump' |
  Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep |
  ForEach-Object { Remove-Item -Force $_.FullName; Log "opgeruimd: $($_.Name)" }
exit 0
