'use strict';

const CLEANUP_FIELDS = ['pm2EnvironmentKeys', 'configTopLevelKeys'];

function validateRuntimeCleanup(value) {
  if (value === undefined) return null;
  // Names only: values never appear in a manifest. Uppercase-only top-level
  // config keys cannot collide with the host's lowercase configuration tree.
  const names = (list, pattern) => list === undefined || Array.isArray(list) && list.length > 0 && list.length <= 16 &&
    new Set(list).size === list.length && list.every(key => typeof key === 'string' && pattern.test(key));
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !CLEANUP_FIELDS.includes(key)) ||
      !CLEANUP_FIELDS.some(key => value[key] !== undefined) ||
      !names(value.pm2EnvironmentKeys, /^SRVPRO_[A-Z0-9_]{1,64}$/) || !names(value.configTopLevelKeys, /^[A-Z][A-Z0-9_]{0,63}$/)) {
    throw Error('runtime_cleanup_invalid');
  }
  return {pm2EnvironmentKeys: value.pm2EnvironmentKeys || [], configTopLevelKeys: value.configTopLevelKeys || []};
}

function validateReleaseOptions(manifest) {
  const {validateDeckReclassification} = require('./deck-maintenance.cjs');
  const {validateNotifications, validateReleaseNotes} = require('./discord-notifications.cjs');
  const deckReclassification = validateDeckReclassification(manifest.deckReclassification);
  const notifications = validateNotifications(manifest.notifications);
  const releaseNotes = validateReleaseNotes(manifest.releaseNotes);
  const runtimeCleanup = validateRuntimeCleanup(manifest.runtimeCleanup);
  if ((deckReclassification || notifications || runtimeCleanup) && !manifest.files.some(file => file.phase === 'backend')) {
    throw Error('maintenance_requires_backend');
  }
  return {deckReclassification, notifications, releaseNotes, runtimeCleanup};
}

module.exports = {validateReleaseOptions, validateRuntimeCleanup};
