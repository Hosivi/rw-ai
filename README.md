# rw-ai

`rw-ai` es una CLI escrita en TypeScript funcional que orquesta **varias sesiones de trabajo en paralelo** sobre un mismo repositorio: cada sesión vive en su propio git worktree, con su rama, sus puertos y su base de datos aislados, y un tablero compartido coordina quién trabaja en qué. Está pensada para equipos donde humanos y agentes de IA (Claude Code, opencode) reclaman roles, trabajan sin pisarse y integran su avance de forma controlada. Todo el estado vive en un solo archivo versionable, `agents.config.json`.

## Requisitos

- Node.js `>=20`
- `git >=2.38` (usa `git merge-tree` para simular integraciones sin tocar tu working tree)
- `pnpm` (gestor de paquetes del proyecto)

## Instalación

### Global (recomendado) — deja el comando `rw` disponible en cualquier carpeta

Una sola línea en PowerShell (Windows). Clona, compila e instala el binario `rw`:

```powershell
irm https://raw.githubusercontent.com/Hosivi/rw-ai/main/install.ps1 | iex
```

Abre una terminal **nueva** y verifica:

```bash
rw --version
```

> Si al escribir `rw` te dice que no lo reconoce, la carpeta de binarios globales de npm no está en tu PATH. Corre `npm config get prefix`, agrega esa carpeta al PATH y abre una terminal nueva.

### Manual (Windows, macOS o Linux)

Los tres pasos que hace el instalador, a mano:

```bash
git clone https://github.com/Hosivi/rw-ai.git
cd rw-ai
npm install          # trae las dependencias y compila dist/
npm install -g .     # deja el binario `rw` en tu PATH
```

> `npm install` es necesario **antes** de `npm install -g .`: el build (`tsc`) corre en ese paso y necesita las dependencias de desarrollo.

### Para desarrollar el propio rw-ai

```bash
pnpm install
pnpm build
node dist/cli.js <comando>   # o `pnpm link --global` para tener `rw`
```

Los ejemplos de abajo usan `rw`.

## Flujo de principio a fin

1. **Genera la configuración.** En un repo nuevo todavía no existe `agents.config.json`. Corre `rw scaffold`: detecta tu stack (node, android, dotnet) y tu base de datos, y escribe una configuración por defecto lista para editar.

   ```bash
   rw scaffold
   ```

2. **Provisiona el repo.** Con la configuración en su lugar, `rw configure` crea las ramas, los worktrees, las bases de datos por sesión y el tablero compartido.

   ```bash
   rw configure
   ```

3. **Reclama un rol.** Cada agente reclama una sesión para trabajar. `rw init` te deja elegir un rol de forma interactiva; `rw claim <rol>` reclama uno específico sin interacción. Ambos imprimen dos líneas `export` con tu identidad: `RW_SESSION` y `RW_TOKEN`. Evalúalas en tu shell para adoptarla.

   ```bash
   eval "$(rw init --role s1)"
   # exporta RW_SESSION=s1 y RW_TOKEN=...
   ```

4. **Trabaja en tu worktree.** Cada sesión tiene su propio directorio bajo `.worktrees/`, con su rama y sus puertos. Trabaja ahí como en cualquier checkout de git.

5. **Pasa la compuerta.** Antes de integrar, `rw check` analiza la integración: detecta conflictos simulados, invasiones de carril y zonas compartidas tocadas. Es tu compuerta de calidad.

   ```bash
   rw check
   ```

6. **Integra y rota.** `rw finish` integra el avance de tu sesión y rota su rama para el siguiente ciclo.

   ```bash
   rw finish
   ```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `rw scaffold` | Detecta el stack y genera `agents.config.json` |
| `rw configure` | Provisiona ramas, worktrees, bases de datos y el tablero |
| `rw adapters` | Escribe los adaptadores (`.claude`/`.opencode`) y skills de rw |
| `rw roles` | Lista los roles y su estado (libre/ocupado) |
| `rw init` | Elige y reclama un rol (interactivo si no pasas `--role`) |
| `rw claim <rol>` | Reclama un rol específico sin interacción |
| `rw whoami` | Muestra el rol asociado a tu `RW_TOKEN` |
| `rw release` | Libera el rol que tienes reclamado |
| `rw finish [sesión]` | Integra la sesión y rota su rama |
| `rw add-session` | Agrega una nueva sesión a la configuración |
| `rw archive <id>` | Archiva una sesión |
| `rw check` | Analiza la integración y detecta conflictos/invasiones |
| `rw sessions` | Lista los jobs de Claude Code de la máquina (el store en `~/.claude/jobs`, distinto de las sesiones git de rw) |

Opciones globales: `-v`/`--version` muestra la versión, `-h`/`--help` muestra la ayuda completa.

### `rw scaffold` en detalle

```bash
rw scaffold [--sessions <n>] [--stacks <a,b>] [--db <docker|local|supabase|none>] [--force]
```

- `--sessions <n>` — cuántas sesiones configurar (por defecto 2).
- `--stacks <a,b>` — fuerza los stacks en lugar de detectarlos (`node`, `android`, `dotnet`, separados por coma).
- `--db <estrategia>` — fuerza la estrategia de base de datos en lugar de detectarla.
- `--force` — sobrescribe un `agents.config.json` existente.

Si ya existe una configuración, `rw scaffold` no la pisa: te avisa y te pide `--force` para reemplazarla.

## Adaptadores para agentes

`rw adapters` escribe los adaptadores multi-agente (`.claude` y `.opencode`) y las skills de rw en tu repo, para que Claude Code y opencode compartan el mismo contexto y las mismas convenciones al trabajar con `rw-ai`. Córrelo una vez que el repo esté configurado.
