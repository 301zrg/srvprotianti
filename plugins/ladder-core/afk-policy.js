'use strict';

const fs = require('fs');
const path = require('path');

function validate(value) {
  if (typeof value !== 'boolean') throw new TypeError('countAfkPenalty must be a boolean.');
  return value;
}

async function readConfig(filename) {
  let config;
  try {
    config = JSON.parse(await fs.promises.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Plugin config must be an object.');
  return config;
}

function createLiveAfkPenaltyConfig(rootDir, fallback = false, log = null) {
  let current = false;
  const warn = error => log?.warn?.({event: 'ladder_afk_config_invalid', reason: error.code || error.name},
    'Ladder AFK config reload failed; keeping last valid value.');
  try {
    current = validate(fallback);
  } catch (error) {
    warn(error);
  }
  return async () => {
    try {
      // Read at the timeout, not room creation, so existing games see hot edits.
      const defaults = await readConfig(path.join(rootDir, 'config.default.json'));
      const local = await readConfig(path.join(rootDir, 'config.json'));
      const config = {countAfkPenalty: false, ...defaults, ...local};
      current = validate(config.countAfkPenalty);
    } catch (error) {
      warn(error);
    }
    return current;
  };
}

module.exports = {createLiveAfkPenaltyConfig};
