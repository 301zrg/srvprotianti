'use strict';

function validateReleaseOptions(manifest) {
  const {validateDeckReclassification} = require('./deck-maintenance.cjs');
  const {validateNotifications, validateReleaseNotes} = require('./discord-notifications.cjs');
  const deckReclassification = validateDeckReclassification(manifest.deckReclassification);
  const notifications = validateNotifications(manifest.notifications);
  const releaseNotes = validateReleaseNotes(manifest.releaseNotes);
  if ((deckReclassification || notifications) && !manifest.files.some(file => file.phase === 'backend')) {
    throw Error('maintenance_requires_backend');
  }
  return {deckReclassification, notifications, releaseNotes};
}

module.exports = {validateReleaseOptions};
