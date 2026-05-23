# mcmp-installer

> This is being used at [HypeServ](https://hypeserv.com).

A TypeScript/Node.js installer that pulls a Minecraft modpack from a URL or provider, unpacks it, installs the right loader (Forge / NeoForge / Fabric), and leaves the server ready to start.

Works with serverpacks from **Curseforge**, **Modrinth**, **FTB**, **Technic**, **direct URL**, and the **serverpack-creator** output format (manifest.json / variables.txt).

## Install
```bash
npm install
npm run build
```

## Usage
```bash
npm start -- --provider <provider> --modpack-id <id> [flags]
# or for a direct serverpack zip URL
npm start -- --wget-mode --modpack-id https://example.com/pack.zip
```

Pass arguments to npm scripts after `--`:
```bash
npm run dev -- --wget-mode --modpack-id https://example.com/pack.zip
```

### npm scripts
| script | what it does |
|---|---|
| `npm run build` | compile TS to `dist/` |
| `npm start` | run compiled CLI |
| `npm run dev` | run sources via `tsx` (no build) |
| `npm run typecheck` | type-check, no emit |
| `npm run clean` | remove `dist/` |

## Flags
| flag | description |
|---|---|
| `--provider` | `curse` \| `technic` \| `ftb` \| `modrinth` \| `direct`. Required unless `--wget-mode`. |
| `--modpack-id` | Project ID / slug / URL. In `--wget-mode` this is a direct zip URL. |
| `--modpack-version` | Specific version/build to install. Latest if omitted. Not used for `direct`. |
| `--wget-mode` | Skip provider parsing — treat `--modpack-id` as a direct zip URL (HEAD redirect resolved). |
| `--wings` | Flatten install into the working dir instead of a modpack subfolder. Use with panel daemons (e.g. [Pterodactyl Wings](https://github.com/pterodactyl/wings)). |
| `--working-path <dir>` | Directory to install into. Defaults to CWD. |
| `--folder-name <name>` | Explicit output folder name (ignored in `--wings`). |
| `--clean-scripts` | Remove `.sh` / `.bat` startup scripts after install. |
| `--update` | Remove `/mods`, `/.fabric`, `/libraries`, `/coremods` before installing. |
| `--manifest-api-key <key>` | API key for the hypeServ manifest mod download API (Curse manifest packs). |

## What it handles
- Standard Curseforge serverpacks (with/without bundled loader)
- Modrinth `.mrpack` (mods + overrides + dependencies)
- FTB binary installers (run directly)
- serverpack-creator output (manifest.json **or** variables.txt)
- Nested folder zips (auto-flattens one level)
- Forge / NeoForge / Fabric installer download + run via Java
- Copies `unix_args.txt` / `win_args.txt` + loader server jars to modpack root so start scripts always find them

## Requirements
- Node.js 18+ (and npm)
- Java 11+ (for Forge / NeoForge / Fabric server installers)

## Project structure
```
src/
  cli.ts                       CLI entrypoint (yargs)
  main.ts                      Orchestrator
  downloadFile.ts              HTTP download + progress bar
  downloadManifestMods.ts      Curse manifest mod downloader (hypeServ API)
  downloadModrinthMods.ts      Modrinth index + overrides + server jar
  getForgeOrFabricVersion.ts   Parse loader info from Curse manifest
  getModpackInfo.ts            Resolve modpack name/urls per provider
  installLoader.ts             Run Forge/NeoForge/Fabric installer (java)
  parseVariablesTxt.ts         serverpack-creator variables.txt parser
  serverstarter.ts             ServerStarter YAML rewriter
  unzipModpack.ts              Archive extraction
  util/                        Logger, fs helpers
```

---
&copy; onesrv — HypeServ
