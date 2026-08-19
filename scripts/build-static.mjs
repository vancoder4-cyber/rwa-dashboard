import { copyFile, mkdir, rm } from 'node:fs/promises';

const outputDirectory = new URL('../public/', import.meta.url);
const staticFiles = ['index.html', 'i18n.js'];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const filename of staticFiles) {
  await copyFile(new URL(`../${filename}`, import.meta.url), new URL(filename, outputDirectory));
}

console.log(`[static-build] copied ${staticFiles.length} files to public/`);
