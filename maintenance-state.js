'use strict';

// Track detached persistence callbacks without delaying the protocol queues.
// A maintenance snapshot is only permission to stop writers; it is not a backup.
class MaintenanceState {
  constructor() {
    this.pending = new Map();
  }

  begin(kind) {
    this.pending.set(kind, (this.pending.get(kind) || 0) + 1);
    let completed = false;
    return () => {
      if (completed) return;
      completed = true;
      const count = this.pending.get(kind) - 1;
      if (count) this.pending.set(kind, count);
      else this.pending.delete(kind);
    };
  }

  async run(kind, task) {
    const complete = this.begin(kind);
    try {
      return await task();
    } finally {
      complete();
    }
  }

  snapshot(stop, rooms) {
    // Include starting and deleting rooms: neither is visible in public lists.
    const roomCount = rooms.filter(room => room && !room.deleted).length;
    const pendingWork = Object.fromEntries(this.pending);
    const pendingPersistence = Object.fromEntries([...this.pending].filter(([kind]) => !kind.endsWith('_protocol')));
    const pendingCount = [...this.pending.values()].reduce((sum, count) => sum + count, 0);
    return {
      maintenanceEnabled: Boolean(stop),
      rooms: roomCount,
      pendingWork,
      pendingPersistence,
      pendingCount,
      readyToStop: Boolean(stop) && roomCount === 0 && pendingCount === 0
    };
  }
}

function basicCredentials(header) {
  if (typeof header !== 'string' || !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0 || /[\r\n\0]/.test(decoded)) return null;
  return {name: decoded.slice(0, colon), pass: decoded.slice(colon + 1)};
}

function neosForwardedIp(config, headers) {
  // Legacy explicit field takes precedence, including an empty string to opt out.
  const name = config.trusted_proxy_header ?? config.ip_header;
  if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name)) return undefined;
  const value = headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

function hostEnvironmentKeys(environment) {
  // The PostgreSQL adapter owns these values. Generic host migration would
  // otherwise log its password and copy it into the main configuration file.
  return Object.keys(environment).filter(key => key.startsWith('SRVPRO_') && !key.startsWith('SRVPRO_LADDER_PG_'));
}

module.exports = {MaintenanceState, basicCredentials, neosForwardedIp, hostEnvironmentKeys};
