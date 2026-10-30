import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const services = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  if (!['--platform', '--output'].includes(key) || !args[index + 1] || options[key]) {
    throw new Error('Usage: build-release.mjs [--platform discord|qq] [--output directory]');
  }
  options[key] = args[index + 1];
}
if (options['--platform'] && !['discord', 'qq'].includes(options['--platform'])) throw new Error('Unknown platform');
const releaseRoot = path.resolve(options['--output'] || path.join(services, 'releases'));
const serviceNames = options['--platform'] ? [options['--platform'] + '-bot'] : ['bot-core', 'qq-bot', 'discord-bot'];

async function copyFiles(source, target, coreImportPath = null) {
  await fs.mkdir(target, {recursive: true});
  for (const name of await fs.readdir(source)) {
    const file = path.join(source, name), stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to package a symlink: ${file}`);
    if (stat.isDirectory()) { await copyFiles(file, path.join(target, name), coreImportPath); continue; }
    const data = await fs.readFile(file);
    await fs.writeFile(path.join(target, name), coreImportPath && name.endsWith('.mjs') ? data.toString('utf8').replaceAll('../../bot-core/src/', coreImportPath) : data);
  }
}

for (const serviceName of serviceNames) {
  const source = path.join(services, serviceName);
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const ownLock = await fs.readFile(path.join(source, 'package-lock.json'), 'utf8')
    .then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const lockedDependencies = ownLock?.packages?.['']?.dependencies || {};
  const declaredDependencies = pkg.dependencies || {};
  // Each service ships its own reviewed npm lock; a stale lock is a build error, never regenerated here.
  if (!ownLock || Object.keys(lockedDependencies).length !== Object.keys(declaredDependencies).length ||
      !Object.entries(declaredDependencies).every(([name, version]) => lockedDependencies[name] === version)) {
    throw new Error(`${serviceName}/package-lock.json does not match package.json; update it with npm install in ${serviceName}`);
  }
  if (serviceName === 'bot-core') continue;
  const release = path.resolve(releaseRoot, serviceName);
  if (path.relative(releaseRoot, release) !== serviceName) throw new Error('Release path escaped the workspace');
  for (const candidate of [releaseRoot, release]) {
    const stat = await fs.lstat(candidate).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) throw new Error(`Refusing to replace symlink: ${candidate}`);
  }
  const previous = await fs.readdir(release).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const generatedNames = new Set(['src', 'test', 'package.json', 'package-lock.json', 'config.default.json', 'README.md']);
  if (serviceName === 'qq-bot') generatedNames.add('LANGUAGE_AND_DELIVERY.md');
  if (serviceName === 'discord-bot') generatedNames.add('ops');
  const runtimeFiles = previous.filter(name => !generatedNames.has(name));
  if (runtimeFiles.length) throw new Error(`Refusing to overwrite deployment data in ${release}: ${runtimeFiles.join(', ')}`);
  await fs.rm(release, {recursive: true, force: true});
  await copyFiles(path.join(source, 'src'), path.join(release, 'src'), './core/');
  await copyFiles(path.join(source, 'test'), path.join(release, 'test'), '../src/core/');
  await copyFiles(path.join(services, 'bot-core/src'), path.join(release, 'src/core'));
  if (serviceName === 'discord-bot') await copyFiles(path.join(source, 'ops'), path.join(release, 'ops'));
  for (const name of ['package.json', 'package-lock.json', 'config.default.json']) {
    const data = await fs.readFile(path.join(source, name), 'utf8');
    await fs.writeFile(path.join(release, name), data);
  }
  await fs.copyFile(path.join(source, 'DEPLOYMENT.md'), path.join(release, 'README.md'));
  if (serviceName === 'qq-bot') await fs.copyFile(path.join(source, 'LANGUAGE_AND_DELIVERY.md'), path.join(release, 'LANGUAGE_AND_DELIVERY.md'));
  process.stdout.write(`${serviceName} release ready: ${release}\n`);
}
