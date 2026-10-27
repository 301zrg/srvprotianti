import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const services = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = path.resolve(services, 'releases');
const legacyLock = JSON.parse(await fs.readFile(path.join(services, 'community-bot/package-lock.json'), 'utf8'));

function findPackage(parent, name) {
  let scope = parent;
  while (true) {
    const key = `${scope ? `${scope}/` : ''}node_modules/${name}`;
    if (legacyLock.packages[key]) return key;
    if (!scope) break;
    const index = scope.lastIndexOf('/node_modules/');
    scope = index < 0 ? '' : scope.slice(0, index);
  }
  throw new Error(`Legacy lock is missing ${name} from ${parent || 'root'}`);
}

function makeLock(pkg) {
  const selected = new Set();
  const visit = (parent, name, optional = false) => {
    let key;
    try { key = findPackage(parent, name); }
    catch (error) { if (optional) return; throw error; }
    if (selected.has(key)) return;
    selected.add(key);
    const entry = legacyLock.packages[key];
    for (const dependency of Object.keys(entry.dependencies || {})) visit(key, dependency);
    for (const dependency of Object.keys(entry.optionalDependencies || {})) visit(key, dependency, true);
    for (const dependency of Object.keys(entry.peerDependencies || {})) {
      visit(key, dependency, entry.peerDependenciesMeta?.[dependency]?.optional === true);
    }
  };
  for (const name of Object.keys(pkg.dependencies)) visit('', name);
  return {
    name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
    packages: {'': {name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, engines: pkg.engines},
      ...Object.fromEntries([...selected].sort().map(key => [key, legacyLock.packages[key]]))}
  };
}

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

for (const serviceName of ['bot-core', 'qq-bot', 'discord-bot']) {
  const source = path.join(services, serviceName);
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const lock = makeLock(pkg);
  await fs.writeFile(path.join(source, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
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
  const runtimeFiles = previous.filter(name => !generatedNames.has(name));
  if (runtimeFiles.length) throw new Error(`Refusing to overwrite deployment data in ${release}: ${runtimeFiles.join(', ')}`);
  await fs.rm(release, {recursive: true, force: true});
  await copyFiles(path.join(source, 'src'), path.join(release, 'src'), './core/');
  await copyFiles(path.join(source, 'test'), path.join(release, 'test'), '../src/core/');
  await copyFiles(path.join(services, 'bot-core/src'), path.join(release, 'src/core'));
  for (const name of ['package.json', 'package-lock.json', 'config.default.json']) {
    const data = await fs.readFile(path.join(source, name), 'utf8');
    await fs.writeFile(path.join(release, name), data);
  }
  await fs.copyFile(path.join(source, 'DEPLOYMENT.md'), path.join(release, 'README.md'));
  if (serviceName === 'qq-bot') await fs.copyFile(path.join(source, 'LANGUAGE_AND_DELIVERY.md'), path.join(release, 'LANGUAGE_AND_DELIVERY.md'));
  process.stdout.write(`${serviceName} release ready: ${release}\n`);
}
