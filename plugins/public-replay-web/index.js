'use strict';

const fs = require('fs');
const path = require('path');
const {decodeDeck} = require('../../data-manager/DeckEncoder');

// Resolve the host entity by metadata name after DataManager initializes. A
// top-level require here would evaluate its decorators before the selected
// database driver has configured portable date/primary-key types.
const DuelLog = 'DuelLog';
const LadderMatchGame = 'LadderMatchGame';

const contentDisposition = filename => {
  // Node HTTP headers are Latin-1 only. Keep the legacy filename parameter
  // ASCII-safe and let modern browsers recover the original Unicode name from
  // the RFC 5987 filename* parameter.
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

module.exports.init = api => {
  if (!api.dataManager) return;
  const replayRoot = path.resolve(process.cwd(), api.settings.modules.tournament_mode.replay_path);
  const logs = () => api.dataManager.getRepository(DuelLog);
  const games = () => api.dataManager.getRepository(LadderMatchGame);
  const classifier = api.get('deckClassifier');
  const usage = api.get('ladderUsageAnalytics');
  const filterCache = new Map();

  const classifyPlayer = player => {
    if (!player?.startDeckBuffer) return null;
    try {
      const deck = decodeDeck(Buffer.from(player.startDeckBuffer, 'base64'));
      const deckTypeId = classifier.classify((deck.main || []).concat(deck.extra || []));
      return {deckTypeId, deckNames: usage.getDeckMetadata(deckTypeId)?.names || {zh: String(deckTypeId)}};
    } catch (error) {
      return null;
    }
  };

  const replayNamesForDeck = async deckTypeId => {
    const cached = filterCache.get(deckTypeId);
    if (cached && Date.now() - cached.time < 60000) return cached.names;
    // Filtering is opt-in. It reuses the already stored G1 classification and
    // does not parse every historical deck buffer or change the schema.
    const rows = await games().createQueryBuilder('game')
      .innerJoin(DuelLog, 'log', 'log.id = game.duelLogId')
      .select('log.replayFileName', 'replayFileName')
      .where('game.deckTypeId = :deckTypeId', {deckTypeId})
      .andWhere('game.duelLogId IS NOT NULL')
      .distinct(true)
      .getRawMany();
    const names = new Set(rows.map(row => path.basename(row.replayFileName ?? row.replayfilename ?? '')));
    filterCache.set(deckTypeId, {time: Date.now(), names});
    return names;
  };

  api.hook('ladder_match_committed', () => filterCache.clear());

  api.hook('http_request', async (request, response, url) => {
    if (request.method !== 'GET') return false;
    if (url.pathname === api.config.listEndpoint) {
      try {
      const page = Math.max(1, Number(url.query.page) || 1);
      const pageSize = Math.min(Number(api.config.maxPageSize) || 100, Math.max(1, Number(url.query.pageSize) || Number(api.config.defaultPageSize) || 20));
      const search = String(url.query.search || '').trim().toLowerCase();
      const requestedDeckTypeId = Number(url.query.deckTypeId);
      const deckTypeId = Number.isInteger(requestedDeckTypeId) && requestedDeckTypeId > 0 ? requestedDeckTypeId : null;
      const matchingReplayNames = deckTypeId ? await replayNamesForDeck(deckTypeId) : null;
      // The replay directory is authoritative for downloads. DuelLog only
      // enriches files with duel number, winner and deck buffers; historical
      // files must remain visible even when their database link is incomplete.
      const filenames = (await fs.promises.readdir(replayRoot))
        .filter(filename => filename.toLowerCase().endsWith('.yrp') && (!search || filename.toLowerCase().includes(search)) && (!matchingReplayNames || matchingReplayNames.has(filename)))
        .sort().reverse();
      const total = filenames.length;
      const pageFilenames = filenames.slice((page - 1) * pageSize, page * pageSize);
      let rows = [];
      if (pageFilenames.length) {
        rows = await logs().createQueryBuilder('log')
          .leftJoinAndSelect('log.players', 'player')
          .where('log.replayFileName IN (:...filenames)', {filenames: pageFilenames})
          .getMany();
      }
      const rowsByFilename = new Map(rows.map(row => [path.basename(row.replayFileName), row]));
      const replays = [];
      for (const filename of pageFilenames) {
        try {
          const stat = await fs.promises.stat(path.join(replayRoot, filename));
          const row = rowsByFilename.get(filename);
          const players = (row?.players || []).filter(player => player.pos < 2).sort((a, b) => a.pos - b.pos);
          replays.push({
            name: filename,
            size: stat.size,
            mtime: stat.mtime,
            duelCount: Number(row?.duelCount) || 1,
            winner: players.find(player => Number(player.winner) === 1)?.name || null,
            players: players.map(player => ({id: player.name, deckbuffer: player.currentDeckBuffer || null, ...classifyPlayer(player)}))
          });
        } catch (error) {
          // A missing file is expected to stay absent from the download list;
          // its ladder result remains safely stored in ladder_match_game.
        }
      }
      response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      response.end(JSON.stringify({replays, total, page, pageSize, deckTypeId, deckTypes: usage.listDeckMetadata()}));
      return true;
      } catch (error) {
        api.log.warn({err: error}, 'Public replay list failed');
        response.writeHead(500, {'Content-Type': 'application/json; charset=utf-8'});
        response.end(JSON.stringify({error: 'Replay list failed.'}));
        return true;
      }
    }

    if (url.pathname.startsWith(api.config.downloadPrefix)) {
      let requested;
      try { requested = decodeURIComponent(url.pathname.slice(api.config.downloadPrefix.length)); }
      catch (error) { requested = ''; }
      const filename = path.basename(requested);
      if (!filename || filename !== requested || !filename.toLowerCase().endsWith('.yrp')) {
        response.writeHead(400); response.end('Bad filename.'); return true;
      }
      try {
        const buffer = await fs.promises.readFile(path.join(replayRoot, filename));
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': contentDisposition(filename)
        });
        response.end(buffer);
      } catch (error) {
        response.writeHead(404); response.end('Replay not found.');
      }
      return true;
    }
    return false;
  });
};
