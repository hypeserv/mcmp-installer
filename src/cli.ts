#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runInstaller, InstallerOptions } from './main.js';
import { Provider, PROVIDERS } from './getModpackInfo.js';
import { DEFAULT_RESOLVER_URL } from './resolveModpack.js';

interface CliArgs {
    provider?: string;
    'modpack-id'?: string;
    'modpack-version': string | false;
    wings: boolean;
    'clean-scripts': boolean;
    update: boolean;
    'folder-name': string | false;
    'working-path': string | false;
    'wget-mode': boolean;
    'resolver-url': string | false;
    'preserve-world': boolean;
    'resolver-token': string | false;
}

async function main(): Promise<void> {
    const argv = (await yargs(hideBin(process.argv))
        .scriptName('mcmp-installer')
        .usage('$0 -provider <provider> -modpack-id <id> [options]')
        .option('provider', {
            type: 'string',
            choices: PROVIDERS as Provider[],
            describe: 'curseforge (alias curse) | modrinth | ftb (alias feed-the-beast) | direct. technic is not supported yet.',
            demandOption: false
        })
        .option('modpack-id', {
            type: 'string',
            describe: 'Project ID / slug / URL depending on provider',
            demandOption: false
        })
        .option('modpack-version', {
            type: 'string',
            describe: 'Version/file id to install. Latest release if omitted. Not used for direct.',
            default: false as const
        })
        .option('wings', {
            describe: 'Wings mode (install directly into working path, no modpack subfolder)',
            type: 'boolean',
            default: false
        })
        .option('clean-scripts', {
            describe: 'Remove .sh / .bat startup scripts after install',
            type: 'boolean',
            default: false
        })
        .option('update', {
            describe: 'Remove /mods, /.fabric, /libraries etc before installing',
            type: 'boolean',
            default: false
        })
        .option('folder-name', {
            describe: 'Explicit output folder name (ignored in wings mode)',
            type: 'string',
            default: false as const
        })
        .option('working-path', {
            describe: 'Directory to work in (default: script directory)',
            type: 'string',
            default: false as const
        })
        .option('wget-mode', {
            describe: 'Skip provider parsing — treat --modpack-id as a direct zip URL (HEAD-resolved), download and install it',
            type: 'boolean',
            default: false
        })
        .option('resolver-url', {
            describe: `modpack-magic base URL used to resolve packs and look up CurseForge manifest files (env MODPACK_MAGIC_URL, default ${DEFAULT_RESOLVER_URL})`,
            type: 'string',
            default: false as const
        })
        .option('resolver-token', {
            describe: 'Bearer token for modpack-magic (env MODPACK_MAGIC_TOKEN). Prefer the env var: CLI args are visible in the process list.',
            type: 'string',
            default: false as const
        })
        .option('preserve-world', {
            describe: 'Wings mode: keep existing world dirs and server.properties instead of overwriting them with the pack\'s copies',
            type: 'boolean',
            default: false
        })
        .check((args) => {
            if (!args['wget-mode'] && !args.provider) {
                throw new Error('--provider is required unless --wget-mode is set.');
            }
            if (!args['modpack-id']) {
                throw new Error('--modpack-id is required.');
            }
            return true;
        })
        .help()
        .alias('h', 'help')
        .parseAsync()) as unknown as CliArgs;

    const opts: InstallerOptions = {
        provider: argv.provider ? (argv.provider as Provider) : undefined,
        modpackId: argv['modpack-id'] as string,
        modpackVersion: argv['modpack-version'] || false,
        wings: argv.wings,
        cleanScripts: argv['clean-scripts'],
        update: argv.update,
        folderName: argv['folder-name'] || false,
        workingPath: argv['working-path'] || false,
        wgetMode: argv['wget-mode'] || false,
        resolverUrl: argv['resolver-url'] || false,
        preserveWorld: argv['preserve-world'],
        resolverToken: argv['resolver-token'] || false
    };

    await runInstaller(opts);
}

main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MCI][ERROR] Modpack installation failed: ${msg}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
});
