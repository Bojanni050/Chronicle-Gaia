<#
  Chronicle-Gaia — database terugzetten uit een pg_dump (zie backup-db.ps1).

  VEILIGHEID: een restore overschrijft de doeldatabase. Daarom maakt dit script
  ALTIJD eerst een veiligheidsdump van de huidige doeldatabase
  (pre-restore-<datum>.dump) en stopt als die mislukt of niet te lezen is.
  Pas daarna wordt teruggezet, in één transactie: bij een fout blijft de
  huidige database ongewijzigd.

  Sluit Chronicle (de app) vóór een restore; open verbindingen blokkeren het
  leegmaken van de tabellen.

  Gebruik:
    # Beschikbare dumps tonen
    powershell -ExecutionPolicy Bypass -File scripts\restore-db.ps1 -List

    # Terugzetten uit een bepaalde dump (vraagt om bevestiging)
    powershell -ExecutionPolicy Bypass -File scripts\restore-db.ps1 -Dump chronicle-20261104-1706.dump

    # Veilig oefenen in een aparte database (raakt ai_chat_archive niet)
    powershell -ExecutionPolicy Bypass -File scripts\restore-db.ps1 -Dump chronicle-20261104-1706.dump -TargetDb ai_chat_archive_restoretest -Force

  Wachtwoord: pg_dump/pg_restore/psql lezen %APPDATA%\postgresql\pgpass.conf.
  Exitcode 0 = gelukt; anders staat de reden in restore-db.log.
#>
param(
  [string]$Dump,
  [switch]$List,
  [string]$TargetDb = 'ai_chat_archive',
  [switch]$Force,
  [string]$PgBin   = 'C:\Program Files\PostgreSQL\18\bin',
  [string]$DbHost  = 'localhost',
  [int]   $Port    = 5432,
  [string]$DbUser  = 'postgres',
  [string]$BackupDir = 'K:\Projects\Project Gaia\chronicle-backups'
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $BackupDir 'restore-db.log'
function Log($m) { "$(Get-Date -Format 's') $m" | Add-Content -Path $log -Encoding utf8 }
function Fail($m, $code = 1) { Log "FOUT: $m"; Write-Error $m -ErrorAction Continue; exit $code }

if ($List) {
  Get-ChildItem $BackupDir -Filter '*.dump' | Sort-Object LastWriteTime -Descending |
    Select-Object Name, @{n='MB';e={[math]::Round($_.Length / 1MB, 1)}}, LastWriteTime | Format-Table -AutoSize
  exit 0
}

if (-not $Dump) { Fail 'geef -Dump <bestandsnaam> op (of gebruik -List om de dumps te zien)' 2 }
$source = if (Test-Path $Dump) { (Resolve-Path $Dump).Path } else { Join-Path $BackupDir $Dump }
if (-not (Test-Path $source)) { Fail "dump niet gevonden: $source" 2 }
if ($TargetDb -notmatch '^[A-Za-z0-9_]+$') { Fail "ongeldige databasenaam: $TargetDb" 2 }

$pgpass = Join-Path $env:APPDATA 'postgresql\pgpass.conf'
if (-not (Test-Path $pgpass) -and -not $env:PGPASSWORD) { Fail "geen pgpass.conf ($pgpass) en geen PGPASSWORD" 2 }

$psql = "$PgBin\psql.exe"
$conn = @('-h', $DbHost, '-p', $Port, '-U', $DbUser, '--no-password')

# 1. De bron-dump moet leesbaar zijn en de tabel chats bevatten.
$toc = & "$PgBin\pg_restore.exe" --list $source
if ($LASTEXITCODE -ne 0 -or -not ($toc -match 'TABLE .* chats')) { Fail 'bron-dump onleesbaar of tabel chats ontbreekt; niets aangeraakt' }

# 2. Bestaat de doeldatabase? Zo niet: aanmaken (alleen zinvol voor oefen-databases).
$exists = & $psql @conn -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$TargetDb'"
if ($LASTEXITCODE -ne 0) { Fail 'kan geen verbinding maken met Postgres' }
$isNew = -not ($exists -match '1')

if ($isNew) {
  Write-Host "Database '$TargetDb' bestaat nog niet; wordt aangemaakt."
  & $psql @conn -d postgres -c "CREATE DATABASE `"$TargetDb`"" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "kan database $TargetDb niet aanmaken" }
} else {
  # 3. Veiligheidsdump van de huidige doeldatabase — verplicht.
  $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
  $safety = Join-Path $BackupDir "pre-restore-$TargetDb-$stamp.dump"
  Write-Host "Veiligheidsdump van '$TargetDb' maken: $safety"
  & "$PgBin\pg_dump.exe" @conn -d $TargetDb -Fc -f $safety
  if ($LASTEXITCODE -ne 0) { if (Test-Path $safety) { Remove-Item -Force $safety }; Fail 'veiligheidsdump mislukt; restore afgebroken, niets gewijzigd' }
  & "$PgBin\pg_restore.exe" --list $safety | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "veiligheidsdump onleesbaar ($safety); restore afgebroken, niets gewijzigd" }
  Log "veiligheidsdump OK: $safety"
}

# 4. Bevestiging (tenzij -Force).
if (-not $Force) {
  $current = if ($isNew) { 'nieuw/leeg' } else { & $psql @conn -d $TargetDb -tAc 'SELECT count(*) FROM chats' 2>$null }
  Write-Host ''
  Write-Host "Dump:        $source"
  Write-Host "Doel:        $TargetDb  (huidige gesprekken: $current)"
  Write-Host 'Dit overschrijft de doeldatabase. De veiligheidsdump staat klaar.'
  $answer = Read-Host "Typ de databasenaam '$TargetDb' om door te gaan"
  if ($answer -ne $TargetDb) { Log "afgebroken door gebruiker (doel $TargetDb)"; Write-Host 'Afgebroken, niets gewijzigd.'; exit 3 }
}

# 5. Terugzetten, in één transactie: bij een fout blijft de huidige staat intact.
Write-Host 'Terugzetten...'
& "$PgBin\pg_restore.exe" @conn -d $TargetDb --clean --if-exists --no-owner --single-transaction $source
if ($LASTEXITCODE -ne 0) { Fail "pg_restore exitcode $LASTEXITCODE; de transactie is teruggedraaid, de database is ongewijzigd" }

$count = & $psql @conn -d $TargetDb -tAc 'SELECT count(*) FROM chats'
Log "OK: $source -> $TargetDb ($count gesprekken)"
Write-Host "Klaar: $TargetDb bevat nu $count gesprekken."
exit 0
