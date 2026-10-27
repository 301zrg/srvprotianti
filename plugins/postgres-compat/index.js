'use strict';

/** PostgreSQL deployment settings stay outside the host's main config. */
module.exports.configure = api => {
  const legacyConnection = api.runtime.databaseConfig || {};
  const usePluginConnection = !!api.config.enabled;

  // During the transition, existing installations may still keep their
  // PostgreSQL credentials in the host config. Apply the PostgreSQL safety
  // policy to that connection as well, without copying or changing secrets.
  if (!usePluginConnection && legacyConnection.type !== 'postgres') return;

  const connection = usePluginConnection
    ? {...api.config.connection, type: 'postgres'}
    : {...legacyConnection, type: 'postgres'};
  if (usePluginConnection) {
    for (const [field, variable] of Object.entries(api.config.environment || {})) {
      if (variable && process.env[variable] != null && process.env[variable] !== '') connection[field] = process.env[variable];
    }
  }
  connection.port = Number(connection.port) || 5432;
  // TypeORM synchronize performs DDL during ordinary startup. PostgreSQL
  // deployments use reviewed migration SQL instead and opt in only explicitly.
  connection.synchronize = api.config.synchronize === true;
  if (!connection.database || !connection.username) throw new Error('PostgreSQL database and username are required.');
  api.runtime.databaseConfig = connection;
  // The historical host calls its generic database switch "mysql". Enabling
  // this adapter must also turn that switch on so no main-config edit is needed.
  api.settings.modules.mysql.enabled = true;
};
