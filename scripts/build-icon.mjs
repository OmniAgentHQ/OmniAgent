import fs from 'node:fs/promises';
import path from 'node:path';
import pngToIco from 'png-to-ico';

const pngPath = path.resolve('build', 'icon.png');
const icoPath = path.resolve('build', 'icon.ico');

await fs.writeFile(icoPath, await pngToIco(pngPath));
process.stdout.write(`Created ${path.relative(process.cwd(), icoPath)} from the OmniAgent app icon.\n`);
