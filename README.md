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
| `rw bootstrap` | Inicializa el repo de una sola vez (git init si hace falta, escribe `agents.config.json`, primer commit y `configure`) |
| `rw scaffold` | Detecta el stack y genera `agents.config.json` |
| `rw configure` | Provisiona ramas, worktrees, bases de datos y el tablero |
| `rw adapters [--worktrees] [--user]` | Escribe la config del agente (MCP + hooks), los adaptadores (`.claude`/`.opencode`) y skills de rw. `--user` instala a nivel usuario (ver [rw en toda sesión](#rw-en-toda-sesión-instalar-a-nivel-usuario)) |
| `rw roles` | Lista los roles y su estado (libre/ocupado) |
| `rw init` | Elige y reclama un rol (interactivo si no pasas `--role`) |
| `rw claim <rol>` | Reclama un rol específico sin interacción |
| `rw whoami` | Muestra el rol asociado a tu `RW_TOKEN` |
| `rw release` | Libera el rol que tienes reclamado |
| `rw finish [sesión]` | Integra la sesión y rota su rama |
| `rw add-session` | Agrega una nueva sesión a la configuración |
| `rw archive <id>` | Archiva una sesión |
| `rw check` | Analiza la integración y detecta conflictos/invasiones |
| `rw lane <ruta>` | Verifica si una ruta cae dentro de las áreas de tu sesión (sale 0 si está permitida, 3 si es invasión) |
| `rw lane-guard` | Hook `PreToolUse` para agentes: lee el payload por stdin y bloquea escrituras fuera de carril (no es para uso manual) |
| `rw session-start` | Hook `SessionStart` para agentes: al abrir la sesión, surface rw y OFRECE `rw_bootstrap` si el repo no está configurado (no es para uso manual) |
| `rw sessions` | Lista los jobs de Claude Code de la máquina (el store en `~/.claude/jobs`, distinto de las sesiones git de rw) |
| `rw tokens [rutas...]` | Estima tokens y costo del contenido (`--model <id>`, `--online` para conteo exacto) |

Opciones globales: `-v`/`--version` muestra la versión, `-h`/`--help` muestra la ayuda completa.

> **`pricing.json` es editable.** `rw tokens` lee los precios por modelo desde `pricing.json` (USD por cada 1.000.000 de tokens). Los valores que trae el paquete son **solo indicativos**: debes verificarlos y actualizarlos contra la lista de precios vigente de Anthropic antes de confiar en los montos. Sin conexión el conteo es una **estimación** (~4 caracteres por token); usa `--online` con `ANTHROPIC_API_KEY` para un conteo exacto vía la API de Anthropic.

### `rw scaffold` en detalle

```bash
rw scaffold [--sessions <n>] [--stacks <a,b>] [--db <docker|local|supabase|none>] [--base-branch <rama>] [--force]
```

- `--sessions <n>` — cuántas sesiones configurar (por defecto 2).
- `--stacks <a,b>` — fuerza los stacks en lugar de detectarlos (`node`, `android`, `dotnet`, separados por coma).
- `--db <estrategia>` — fuerza la estrategia de base de datos en lugar de detectarla.
- `--base-branch <rama>` — fuerza la rama base en lugar de detectarla.
- `--force` — sobrescribe un `agents.config.json` existente.

`rw scaffold` detecta la rama base real del repo en vez de asumir `main`: usa `main` si existe, si no `master`, y si no la rama en la que estás parado. Así `git.baseBranch` apunta a una rama que **existe** y `rw configure` no falla en el paso de la rama de integración. Si tu repo usa otra convención, pásala con `--base-branch <rama>`.

Si ya existe una configuración, `rw scaffold` no la pisa: te avisa y te pide `--force` para reemplazarla.

## Adaptadores para agentes

`rw adapters` cablea el modelo completo **"dentro del agente"** con un solo comando, de forma **no destructiva** e **idempotente** (vuelve a correrlo cuando quieras: solo reescribe lo que cambió). Córrelo una vez que el repo esté configurado. Escribe:

1. **Skills y comandos** (`.claude`/`.opencode`): el mismo contexto y las mismas convenciones para Claude Code y opencode al trabajar con `rw-ai`.
2. **El servidor MCP** para que el agente use rw como herramientas nativas (`rw_status`, `rw_check`, `rw_claim`, `rw_finish`, `rw_lane_check`, `rw_roles`, `rw_whoami`, `rw_release`) en vez de parsear la salida de la shell.
3. **El hook de carril** (`PreToolUse`) que bloquea escrituras fuera del carril de tu sesión (ver la sección de abajo).

### Qué archivos escribe

**Claude Code** — dos archivos de config, fusionados sin pisar lo tuyo:

- `.mcp.json` — agrega el servidor MCP `rw-ai` bajo `mcpServers` (preserva cualquier otro servidor y clave):

  ```json
  { "mcpServers": { "rw-ai": { "command": "rw", "args": ["mcp"] } } }
  ```

- `.claude/settings.json` — agrega dos hooks (preserva cualquier otro hook y clave; no duplica un grupo al re-correr, deduplicado por el string del comando): un grupo `PreToolUse` que corre el guard de carril y un grupo `SessionStart` que corre `rw session-start` para surface/ofrecer rw al abrir la sesión:

  ```json
  {
    "hooks": {
      "PreToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command", "command": "rw lane-guard" } ] } ],
      "SessionStart": [ { "hooks": [ { "type": "command", "command": "rw session-start" } ] } ]
    }
  }
  ```

  > El grupo `SessionStart` va **sin `matcher`** a propósito: en Claude Code el matcher de `SessionStart` filtra por fuente (`startup|resume|clear|compact`) y omitirlo hace que el hook dispare en TODA apertura de sesión, que es justo lo que rw quiere. El hook **falla en abierto** (siempre sale 0) para no romper nunca el arranque de la sesión, y en un repo sin configurar OFRECE `rw_bootstrap` sin ejecutar nada por su cuenta.

**OpenCode** — `opencode.json`, fusionado sin pisar lo tuyo, con el servidor MCP `rw-ai`:

```json
{ "mcp": { "rw-ai": { "type": "local", "command": ["rw", "mcp"], "enabled": true } } }
```

> **El hook de carril para OpenCode queda pendiente de verificación.** OpenCode sí tiene un hook pre-escritura (`tool.execute.before`), pero **solo** vía un plugin TypeScript (`.opencode/plugin/*.ts`), no una entrada JSON fusionable; además ese hook recibe el payload propio de OpenCode, no el payload `PreToolUse` de Claude Code que `rw lane-guard` lee por stdin. Cablear eso bien requiere un adaptador de payload que todavía no existe, así que **no se inventa**: por ahora `rw adapters` solo escribe el servidor MCP de OpenCode y este hueco queda documentado. Honestidad sobre completitud: una config equivocada es peor que un hueco documentado.

Si un archivo de config existente **no es JSON válido**, `rw adapters` **no lo sobrescribe**: sale con error nombrándolo para que lo arregles a mano.

### `--worktrees` (modelo de despliegue)

Por defecto la config se escribe **solo en la raíz compartida** del repo. Con `--worktrees`, `rw adapters` **también** escribe `.mcp.json` y `.claude/settings.json` (misma lógica de fusión) dentro de **cada worktree de sesión activa**, para que un agente arrancado por worktree quede cableado ahí también. El hook y el servidor MCP resuelven la sesión desde el cwd, así que funcionan igual dentro de un worktree.

```bash
rw adapters              # solo la raíz compartida
rw adapters --worktrees  # además, cada worktree de sesión activa
```

## rw en toda sesión (instalar a nivel usuario)

Por defecto `rw adapters` cablea rw **por proyecto**. Con `rw adapters --user` instalas el servidor MCP y los hooks de rw **a nivel usuario**, para que rw aparezca en **TODAS** tus sesiones de Claude Code y OpenCode en la máquina, sin tener que configurar cada repo.

```bash
rw adapters --user
```

Es una instalación **global**: no necesita un repo configurado (ni siquiera un repo), así que puedes correrlo desde cualquier carpeta. **No escribe nada en el proyecto**; solo toca tu directorio de usuario, de forma **no destructiva** e **idempotente** (fusiona: preserva todo lo que ya tengas y no duplica nada al re-correr).

### Qué archivos escribe a nivel usuario

Las ubicaciones son las que documenta Claude Code / OpenCode y son **distintas** a las del proyecto:

- **`~/.claude.json`** — el servidor MCP `rw-ai` bajo la clave `mcpServers` (es el mismo archivo donde Claude Code guarda los servidores de `claude mcp add --scope user`). Este archivo también guarda tus proyectos e historial: la fusión los **preserva intactos** y solo agrega/actualiza la clave `rw-ai`.

  ```json
  { "mcpServers": { "rw-ai": { "command": "rw", "args": ["mcp"] } } }
  ```

- **`~/.claude/settings.json`** — los hooks de usuario (aplican a todo proyecto): el grupo `PreToolUse` (`rw lane-guard`) y el grupo `SessionStart` (`rw session-start`).

  ```json
  {
    "hooks": {
      "PreToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command", "command": "rw lane-guard" } ] } ],
      "SessionStart": [ { "hooks": [ { "type": "command", "command": "rw session-start" } ] } ]
    }
  }
  ```

- **`~/.config/opencode/opencode.json`** — el servidor MCP `rw-ai` global de OpenCode (bajo `mcp`), que aplica a todas tus sesiones de OpenCode.

  ```json
  { "mcp": { "rw-ai": { "type": "local", "command": ["rw", "mcp"], "enabled": true } } }
  ```

El comando imprime exactamente **qué archivos escribió** para que sepas qué cambió en tu directorio de usuario.

### El hook SessionStart (ofrecer, nunca actuar)

Con rw a nivel usuario, cada vez que abres una sesión el hook `SessionStart` (`rw session-start`) le dice al agente que rw está disponible:

- En un directorio **sin configurar** (no es un repo git, o es un repo sin `agents.config.json`), el hook **OFRECE** `rw_bootstrap` (o `rw bootstrap`) para inicializar git + sesiones aisladas — pero **NO ejecuta nada automáticamente**. La decisión es tuya; el hook nunca muta tu repo por su cuenta.
- Dentro del **worktree de una sesión**, te recuerda tu rol (sesión, rama, áreas) y que el guard de carril está activo.
- En la **raíz compartida** de un repo rw, te dice cuántas sesiones activas hay y qué herramientas (`rw_status`, `rw_check`, `rw_roles`) puedes usar.

El hook **falla en abierto**: pase lo que pase (payload vacío o inválido, error de git) siempre sale con código 0 para no romper jamás el arranque de una sesión.

### Huecos documentados a nivel usuario

- **El hook de carril de OpenCode sigue pendiente de verificación**, igual que a nivel proyecto: su guard pre-escritura (`tool.execute.before`) solo existe vía un plugin TypeScript, no una entrada JSON fusionable. A nivel usuario `rw adapters --user` escribe el **servidor MCP** de OpenCode pero **no** su hook de carril, para no inventar una config equivocada.
- Los **skills y comandos** (`.claude`/`.opencode`) NO se instalan a nivel usuario: son contenido derivado de la config del proyecto (por ejemplo la tabla de sesiones activas), así que siguen viviendo por repo vía `rw adapters` (sin `--user`).

## Aplicación de carriles (hook)

Cada sesión declara sus **áreas** (`areas`) en `agents.config.json`: los globs, relativos a la raíz del repo, que le corresponden (por ejemplo `src/api/**`). `rw check` ya detecta *después* del hecho cuando una sesión escribió fuera de su carril; el hook `rw lane-guard` lo convierte en **prevención en tiempo real** y bloquea la escritura antes de que ocurra.

1. **Estrecha las áreas de cada sesión.** Por defecto una sesión abarca `**/*` (todo el repo), así que no hay nada que hacer cumplir. Edita `agents.config.json` y dale a cada sesión solo los globs que le tocan:

   ```json
   {
     "sessions": [
       { "id": "s1", "areas": ["src/api/**"], "...": "..." },
       { "id": "s2", "areas": ["src/web/**"], "...": "..." }
     ],
     "sharedZones": ["package.json", "src/shared/**"]
   }
   ```

   Lo que cae en `sharedZones` se permite desde cualquier sesión (son puntos de colaboración deliberados); todo lo demás fuera de las áreas de la sesión es una **invasión**.

2. **Enlaza el hook `PreToolUse`.** El hook lee el payload de la herramienta por stdin y, si la escritura sale del carril de la sesión, la bloquea (sale con código 2 y explica el motivo por stderr, que Claude Code le muestra al agente). En cualquier otro caso deja pasar la operación —falla en abierto: nunca bloquea por un error propio, ni fuera de una sesión de rw—.

   Ya no lo enlaces a mano: **`rw adapters` lo cablea automáticamente** en `.claude/settings.json` (y de paso registra el servidor MCP). Mira la sección [Adaptadores para agentes](#adaptadores-para-agentes). El grupo que agrega es:

   ```json
   { "hooks": { "PreToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command", "command": "rw lane-guard" } ] } ] } }
   ```

   El equivalente en opencode queda **pendiente de verificación**: su hook pre-escritura (`tool.execute.before`) solo existe vía un plugin TypeScript, no una entrada JSON, y recibe un payload distinto al de Claude Code. `rw adapters` escribe el servidor MCP de opencode pero **no** el hook, para no inventar una config equivocada.

Para una comprobación puntual desde la terminal o un script, usa `rw lane <ruta>` (sale 0 si está permitida, 3 si es invasión). Ambos comandos solo tienen sentido **dentro del worktree de una sesión**.
