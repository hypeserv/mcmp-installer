#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runInstaller, InstallerOptions } from './main.js';
import { Provider } from './getModpackInfo.js';

interface CliArgs {
    provider?: string;
    'modpack-id'?: string;
    'modpack-version': string | false;
    wings: boolean;
    'clean-scripts': boolean;
    update: boolean;
    'folder-name': string | false;
    'working-path': string | false;
    'manifest-api-key': string | false;
    'wget-mode': boolean;
}

async function main(): Promise<void> {
    const argv = (await yargs(hideBin(process.argv))
        .scriptName('mcmp-installer')
        .usage('$0 -provider <provider> -modpack-id <id> [options]')
        .option('provider', {
            type: 'string',
            describe: 'curse | technic | ftb | modrinth | direct',
            demandOption: false
        })
        .option('modpack-id', {
            type: 'string',
            describe: 'Project ID / slug / URL depending on provider',
            demandOption: false
        })
        .option('modpack-version', {
            type: 'string',
            describe: 'Version/build identifier (not used for direct)',
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
        .option('manifest-api-key', {
            describe: 'API key for hypeserv manifest mod downloads',
            type: 'string',
            default: false as const
        })
        .option('wget-mode', {
            describe: 'Skip provider parsing — treat --modpack-id as a direct zip URL (HEAD-resolved), download and install it',
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
        manifestApiKey: argv['manifest-api-key'] || false,
        wgetMode: argv['wget-mode'] || false
    };

    await runInstaller(opts);
}

main().catch((err: unknown) => {
    if (err instanceof Error) {
        console.error(err.stack || err.message);
    } else {
        console.error(err);
    }
    process.exit(1);
});
