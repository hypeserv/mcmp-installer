import fs from 'fs-extra';
import YAML from 'yaml';

interface ServerStarterConfig {
    install?: {
        baseInstallPath?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export async function changeInstallPath(
    yamlFile: string,
    installPath: string
): Promise<void> {
    const raw = await fs.readFile(yamlFile, 'utf8');
    const data = (YAML.parse(raw) as ServerStarterConfig) || {};
    if (!data.install) data.install = {};
    data.install.baseInstallPath = installPath;
    const out = YAML.stringify(data);
    await fs.writeFile(yamlFile, out, 'utf8');
}
