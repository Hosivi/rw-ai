# install.ps1 — instalador global de rw-ai para Windows (PowerShell)
#
# Uso rapido (una linea):
#   irm https://raw.githubusercontent.com/Hosivi/rw-ai/main/install.ps1 | iex
#
# Deja el comando `rw` disponible desde cualquier carpeta.

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

# 2) Instalar global desde GitHub. El script 'prepare' compila dist/ durante la instalacion.
Write-Host 'Instalando el paquete global (npm install -g github:Hosivi/rw-ai)...' -ForegroundColor Cyan
& npm install -g 'github:Hosivi/rw-ai'
if ($LASTEXITCODE -ne 0) {
  Write-Error 'La instalacion con npm fallo. Revisa el error de arriba (si el repo es privado, necesitas autenticarte en GitHub).'
  return
}

# 3) Verificar que 'rw' quedo en el PATH.
$rwCmd = Get-Command rw -ErrorAction SilentlyContinue
if ($rwCmd) {
  $version = (& rw --version)
  Write-Host "Listo. rw instalado: $version" -ForegroundColor Green
  Write-Host 'Prueba:  rw --help' -ForegroundColor Green
} else {
  $prefix = (& npm config get prefix)
  Write-Warning "rw se instalo pero la carpeta de binarios de npm no esta en tu PATH."
  Write-Host "Agrega esta carpeta a tu PATH y abre una terminal NUEVA:" -ForegroundColor Yellow
  Write-Host "  $prefix" -ForegroundColor Yellow
  Write-Host 'Luego corre:  rw --version' -ForegroundColor Yellow
}
