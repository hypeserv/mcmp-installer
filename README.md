![mcmp-logo](https://raw.githubusercontent.com/hypeserv/mcmp-installer/refs/heads/main/.github/mcmp-installer-logo.webp)

> This is being used at [HypeServ](https://hypeserv.com).

A TypeScript/Node.js installer that pulls a Minecraft modpack from a URL or provider, unpacks it, installs the right loader (Forge / NeoForge / Fabric), and leaves the server ready to start.

Works with serverpacks from **Curseforge**, **Modrinth**, **FTB**, **Technic**, **direct URL**, and the **serverpack-creator** output format (manifest.json / variables.txt).

## Quick start (npx)

No install required — run the latest published version directly:

```bash
npx -y @hypeserv/mcmp-installer --provider modrinth --modpack-id <slug>
```

Direct zip URL:

```bash
npx -y @hypeserv/mcmp-installer --wget-mode --modpack-id https://example.com/pack.zip
```

Pin a specific version (recommended in Dockerfiles):

```bash
npx -y @hypeserv/mcmp-installer@1.1.0 --provider curse --modpack-id 456789
```

## Global install

```bash
npm install -g @hypeserv/mcmp-installer
mcmp-installer --provider modrinth --modpack-id <slug>
```

## Usage

```bash
mcmp-installer --provider <provider> --modpack-id <id> [flags]
# or for a direct serverpack zip URL
mcmp-installer --wget-mode --modpack-id https://example.com/pack.zip
```

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


## License

Source-available. See [LICENSE](./LICENSE) for terms — read/run permitted, redistribution and derivative works require written permission.

---
&copy; onesrv — HypeServ
