'use strict';

const fs = require('fs');
const path = require('path');

function validate(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError('turnTimeLimitSeconds must be an integer between 1 and 65535.');
  }
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

function createLiveTurnTimeConfig(rootDir, fallback = 300, log = null) {
  let current = 300;
  const warn = error => log?.warn?.({event: 'ladder_turn_time_config_invalid', reason: error.code || error.name},
    'Ladder turn time config reload failed; keeping last valid value.');
  try {
    current = validate(fallback);
  } catch (error) {
    warn(error);
  }
  return async () => {
    try {
      const defaults = await readConfig(path.join(rootDir, 'config.default.json'));
      const local = await readConfig(path.join(rootDir, 'config.json'));
      current = validate({turnTimeLimitSeconds: 300, ...defaults, ...local}.turnTimeLimitSeconds);
    } catch (error) {
      warn(error);
    }
    return current;
  };
}

module.exports = {createLiveTurnTimeConfig};
