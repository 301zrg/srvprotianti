'use strict';
// Structured JSON edits for the Windows installer. The request arrives on stdin so values
// (including passwords) never appear in a command line. Key order and other fields are kept.
// Request: {"file": "...", "replacePrefix": {"from": "...", "to": "..."}?,
//           "set": [{"path": ["a", "b"], "value": ...}]?, "show": [["a","b"], ...]?}
// Output: {"changedStrings": n, "show": {...}}; values of password keys are never printed.
const fs = require('fs');

function read(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

function walkStrings(node, visit) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => { if (typeof v === 'string') node[i] = visit(v); else walkStrings(v, visit); });
    return;
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (typeof node[key] === 'string') node[key] = visit(node[key]); else walkStrings(node[key], visit);
    }
  }
}

function lookup(root, path) {
  let node = root;
  for (const key of path) {
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

async function main() {
  // Node's JSON.parse messages quote the input, which may hold a password: replace them.
  let request;
  let data;
  try { request = JSON.parse(await read(process.stdin)); } catch (error) { throw new Error('request is not valid JSON'); }
  const raw = fs.readFileSync(request.file, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try { data = JSON.parse(text); } catch (error) { throw new Error('target file is not valid JSON'); }
  let changed = 0;
  if (request.replacePrefix) {
    const { from, to } = request.replacePrefix;
    walkStrings(data, value => {
      if (value.startsWith(from)) { changed++; return to + value.slice(from.length); }
      return value;
    });
  }
  for (const item of request.set || []) {
    const parent = lookup(data, item.path.slice(0, -1));
    const key = item.path[item.path.length - 1];
    if (!parent || typeof parent !== 'object' || !Object.prototype.hasOwnProperty.call(parent, key)) {
      throw new Error('Field not present: ' + item.path.join('.'));
    }
    parent[key] = item.value;
  }
  if (request.replacePrefix || (request.set || []).length) {
    fs.writeFileSync(request.file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8' });
  }
  const show = {};
  for (const path of request.show || []) {
    const value = lookup(data, path);
    const last = String(path[path.length - 1]).toLowerCase();
    show[path.join('.')] = last.includes('password') || last === 'pass'
      ? (typeof value === 'string' && value.length > 0 ? '<set>' : '<empty>')
      : value;
  }
  process.stdout.write(JSON.stringify({ changedStrings: changed, show }) + '\n');
}

main().catch(error => {
  // The message names a field or says the JSON is invalid; it never echoes a value.
  process.stderr.write('json-edit failed: ' + error.message + '\n');
  process.exitCode = 1;
});
