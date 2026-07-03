# install.ps1 — instalador global de rw-ai para Windows (PowerShell)
#
# Uso rapido (una linea):
#   irm https://raw.githubusercontent.com/Hosivi/rw-ai/main/install.ps1 | iex
#
# Clona el repo, instala dependencias, compila y deja el comando `rw` disponible
# desde cualquier carpeta. Volver a correrlo actualiza a la ultima version.

$ErrorActionPreference = 'Stop'

Write-Host 'Instalando rw-ai...' -ForegroundColor Cyan

# 1) Node >= 20 es obligatorio.
$nodeVersion = $null
try { $nodeVersion = (& node --version) } catch {}
if (-not $nodeVersion) {
  Write-Error 'No se encontro Node.js. Instala Node >= 20 desde https://nodejs.org y vuelve a correr esto.'
  return
}
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 20) {
  Write-Error "rw-ai necesita Node >= 20 (tienes $nodeVersion). Actualiza Node y reintenta."
  return
}

# 2) git es obligatorio.
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error 'No se encontro git. Instalalo desde https://git-scm.com y reintenta.'
  return
}

# 3) Clonar (o actualizar) en ~/.rw-ai.
$dest = Join-Path $HOME '.rw-ai'
if (Test-Path (Join-Path $dest '.git')) {
  Write-Host "Actualizando el repo en $dest..." -ForegroundColor Cyan
  & git -C $dest pull --ff-only
} else {
  Write-Host "Clonando en $dest..." -ForegroundColor Cyan
  & git clone --depth 1 https://github.com/Hosivi/rw-ai.git $dest
}
if ($LASTEXITCODE -ne 0) { Write-Error 'Fallo el clone/pull del repo.'; return }

# 4) Instalar dependencias (compila dist/ via el script prepare) e instalar el binario global.
Push-Location $dest
try {
  Write-Host 'Instalando dependencias y compilando...' -ForegroundColor Cyan
  & npm install
  if ($LASTEXITCODE -ne 0) { throw 'npm install fallo.' }
  Write-Host 'Instalando el binario global rw...' -ForegroundColor Cyan
  & npm install -g .
  if ($LASTEXITCODE -ne 0) { throw 'npm install -g . fallo.' }
} finally {
  Pop-Location
}

# 5) Verificar que 'rw' quedo en el PATH.
$rwCmd = Get-Command rw -ErrorAction SilentlyContinue
if ($rwCmd) {
  Write-Host "Listo. rw instalado: $(& rw --version)" -ForegroundColor Green
  Write-Host 'Prueba:  rw --help' -ForegroundColor Green
} else {
  $prefix = (& npm config get prefix)
  Write-Warning 'rw se instalo pero la carpeta de binarios de npm no esta en tu PATH.'
  Write-Host "Agrega esta carpeta a tu PATH y abre una terminal NUEVA:" -ForegroundColor Yellow
  Write-Host "  $prefix" -ForegroundColor Yellow
  Write-Host 'Luego corre:  rw --version' -ForegroundColor Yellow
}
