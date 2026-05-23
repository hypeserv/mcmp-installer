# Minecraft Serverpack Downloader and Installer

This is a TypeScript (Node.js) tool that automatically downloads and installs Minecraft modpacks from
Curseforge, Technicpack, FTB, Modrinth, or a direct download link as the pack was intended by the modpack author. Serverpacks provided for modpacks by their authors come in very different kinds, with many different installers. This is an attempt to unify the installation of all serverpacks (for both Forge and Fabric) as the modpack author intended them to be. [Here's the kinds of serverpack installers the tool works with](#installer-types). The tool is extensively tested and should work with all modpacks on Curseforge.

#### The tool will:
1. Download the modpacks serverpack (or non-serverpack) from the Curseforge Project ID, Technic modpack slug, FTB modpack ID, Modrinth project ID/slug, or a direct download link (url). See details below.

2. Run any provided installers through a unification attempt that come with the serverpack if needed.

3. Remove garbage files.

After the installer is done, the modpack will be fully installed in a separate folder (named after the modpack itself) and ready to be started.

## Compatibility
OS: ```Windows```, ```Linux```
Works with both Forge and Fabric modpacks.

## Usage
### 1. Clone or download this repository into any directory you want

### 2. Install dependencies
```bash
npm install
```

### 3. Build the TypeScript sources
```bash
npm run build
```

### 4. Run the installer from your terminal with specified [arguments](#arguments) like:
##### optional arguments marked in square [brackets].
```bash
npm start -- --provider PROVIDER --modpack-id MODPACK-ID [--modpack-version MODPACK-VERSION] [--wings] [--clean-scripts] [--update]
```

Or directly:
```bash
node dist/cli.js --provider PROVIDER --modpack-id MODPACK-ID [...]
```

For development without a build step:
```bash
npm run dev -- --provider PROVIDER --modpack-id MODPACK-ID
```

### Done!

## Available npm scripts
- ```npm run build``` — compile TypeScript to ```dist/```
- ```npm start``` — run the compiled CLI
- ```npm run dev``` — run directly from sources via ```tsx```
- ```npm run typecheck``` — type-check without emitting files
- ```npm run clean``` — remove ```dist/```

## Arguments
#### provider
Provider sets from where to fetch the modpack. Available modes are ```curse``` for Curseforge, ```technic``` for Technicpack, ```ftb``` for Feed The Beast, ```modrinth``` for Modrinth, and ```direct``` for a direct download link (url) to a modpack (can be from any site).
#### modpack-id
If provider is set to ```curse``` this should be the modpacks project ID found on <a href="https://www.curseforge.com/minecraft/modpacks">the Curseforge website</a> in the top right "About Project" section of your desired modpack.

If provider is set to ```technic```, this should be the modpack slug found for each modpack on <a href="https://www.technicpack.net/modpacks/official"> the Technicpack website</a>. For example, the url for the Attack of the B-Team modpack is https://www.technicpack.net/modpack/attack-of-the-bteam.552556. The slug is the last part of this url minus the dot and the numbers (i.e attack-of-the-bteam).

If provider is set to ```ftb```, this should be the modpack ID found on <a href="https://feed-the-beast.com/modpack"> the Feed The Beast website</a>. In the first part of the url for each modpack there is a numerical ID. For example, The Direwolf20 1.16 modpack's link is https://feed-the-beast.com/modpack/79_ftb_presents_direwolf20_1_16. This modpacks' ID is therefore 79.

If provider is set to ```modrinth```, this should be the modpack project ID OR the modpack slug found on <a href="https://modrinth.com/modpack"> the Modrinth website</a>. On each modpack page, the project ID is found on the bottom-left under "Technical information". The modpack slug is found in the URL after /modpack. Example: https://modrinth.com/modpack/mechanic-craft/ - the slug here is mechanic-craft.

If provider is set to ```direct```, this should be a direct download link (url), from where to fetch the modpack.
#### modpack-version (optional)
Which version of the modpack to install. Specify a version from the modpacks name. For example, <a href="https://www.curseforge.com/minecraft/modpacks/rlcraft">RLCraft</a> names their releases like "v.2.9", "v.2.8.2" etc. (as you can see by going to the "Files" section). Here, you can use "v.2.8.2" to pull that version. You can also use an exact version ID from Curseforge found in the URL of the specific pack version. For Technic, versions are labeled as "builds" instead of versions. For FTB, the version is found as an ID using the modpacks.ch api with the modpack ID. Example: https://api.modpacks.ch/public/modpack/79 for Direwolf20 1.16. For Modrinth, the modpack version is found using the Modrinth API labeled as "id". This option is not available if provider is set to ```direct```. If left unspecified, the installer will fetch the latest recommended version of the modpack.

In conjunction with Curseforges' release type system, if no "recommended" version exists, it will pull the latest "beta" serverpack. If no "beta" version exists it will pull the latest "alpha" serverpack. If the modpack has no provided serverpack at all it will pull the latest non-serverpack in the same order. For technic, all modpacks have a recommended version.
#### clean-scripts (optional)
Set to clean (remove) the provided startup scripts (.sh for linux and .bat for Windows) when installing the modpack.
#### update (optional)
Set to remove the /mods, /.fabric and /libraries folders before installing the modpack. This should be set if updating a modpack and not set if it's a first-time install.
#### folder-name (optional)
Explicit output folder name (ignored in wings mode).
#### working-path (optional)
Directory to work in (default: current working directory).
#### manifest-api-key (optional)
API key for hypeserv manifest mod downloads.
#### wget-mode (optional)
Use wget-like (HEAD redirect resolve) download behavior. Implied for ```ftb```.
#### wings (optional)
Wings mode is intended to use in conjunction with a panel daemon egg install script ([More details on this](#wings-mode)).

## Installer types
There is currently no standardization in how serverpacks are uploaded on Curseforge.
* Some serverpacks include **all** required files to run the server by default
* Some require Forge or Fabric to be installed separately with only the mods and libraries folders included
* Some require mods to be downloaded using the [ServerStarter script by BloodyMods](https://github.com/BloodyMods/ServerStarter) or the somewhat standardized manifest.json file.

This tool is compatible with all different types of installers by identifying and running them as tasks separately if needed. The advantage of using this tool over others is that it downloads and installs the serverpack as intended by the modpack author, keeping certain files that they have included which, were the mods installed in any other way, would not have been included.

The modpack author may, for example, have made modifications to the server.properties file or any mod config file. These modifications would not be carried over using another way of installing the modpack.

For technic, contrary to curse, modpacks are standardized to include all files required to start the server.

## Wings Mode
The tool can also run in the optional ```--wings``` mode. Wings mode is intended to be used in conjunction with a Game Server Panel daemon (e.g. [Pterodactyl Wings](https://github.com/pterodactyl/wings)) in an egg install script (in bash). In this mode, after install the modpack contents are flattened into the working path instead of staying inside a modpack subfolder, so the daemon finds the server files directly at the working root.

## Requirements
```Node.js 18+``` (for native ESM + fetch / modern APIs)
```npm``` (bundled with Node.js)
```Java (11 or later)``` (for Forge/Fabric installers)

## Project structure
```
src/
  cli.ts                       CLI entrypoint (yargs)
  main.ts                      Orchestrates the install flow
  downloadFile.ts              HTTP download + progress bar
  downloadManifestMods.ts      Curse manifest.json mod downloader (hypeserv API)
  downloadModrinthMods.ts      Modrinth index + overrides + server jar
  getForgeOrFabricVersion.ts   Parse loader info from Curse manifest
  getModpackInfo.ts            Resolve modpack name/urls per provider
  serverstarter.ts             ServerStarter YAML rewriter
  unzipModpack.ts              Archive extraction
  util/
    fsHelpers.ts               Small fs utilities
    logger.ts                  Console logger
```
