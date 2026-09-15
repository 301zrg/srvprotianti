'use strict';

const fs = require('fs');
const path = require('path');
const assetContentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8'
};

const json = (response, value) => {
  response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(value));
};
const safelySendJson = async (api, response, operation) => {
  try {
    json(response, await operation());
  } catch (error) {
    api.log.warn({err: error}, 'Ladder web request failed');
    response.writeHead(500, {'Content-Type': 'application/json; charset=utf-8'});
    response.end(JSON.stringify({error: 'Request failed.'}));
  }
};
const readJsonBody = (request, limit = 4096) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  request.on('data', chunk => {
    size += chunk.length;
    if (size > limit) {
      reject(Object.assign(new Error('Request body is too large.'), {statusCode: 413}));
      request.destroy();
    } else chunks.push(chunk);
  });
  request.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
    catch (error) { reject(Object.assign(new Error('Invalid JSON body.'), {statusCode: 400})); }
  });
  request.on('error', reject);
});
const loadExampleDecks = filename => {
  const source = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const groups = (source.groups || []).map(group => ({
    id: String(group.id || ''),
    name: group.name || {},
    decks: (group.decks || []).map(deck => {
      const configured = String(deck.file || '');
      const safe = path.basename(configured);
      if (!safe || safe !== configured || !safe.toLowerCase().endsWith('.ydk')) {
        throw new Error(`Invalid example deck filename: ${configured}`);
      }
      return {file: safe, name: deck.name || {}};
    })
  }));
  return {version: source.version || null, lastUpdated: source.lastUpdated || null, groups};
};

module.exports.init = api => {
  const analytics = api.get('ladderAnalytics');
  const usage = api.get('ladderUsageAnalytics');
  const classifier = api.get('deckClassifier');
  const routes = JSON.parse(fs.readFileSync(path.resolve(api.rootDir, api.config.routesFile), 'utf8'));
  const webRoot = path.join(api.rootDir, 'web');
  const assetRoot = path.join(webRoot, 'assets');
  api.hook('http_request', async (request, response, url) => {
    if (request.method === 'POST' && (url.pathname === '/api/ladder/player' || url.pathname === '/api/ladder/player/deck')) {
      try {
        const body = await readJsonBody(request);
        const query = {player: body.player, month: body.month, page: body.page, matchId: body.matchId, side: body.side};
        if (url.pathname.endsWith('/deck')) {
          const deck = await analytics.profileDeck(query, body.password);
          if (!deck) {
            response.writeHead(404, {'Content-Type': 'application/json; charset=utf-8'});
            response.end(JSON.stringify({error: 'Deck is unavailable.'}));
          } else {
            response.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(deck.filename)}`,
              'Cache-Control': 'no-store'
            });
            response.end(deck.contents);
          }
        } else {
          const result = await analytics.profile(query, body.password);
          response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
          response.end(JSON.stringify(result));
        }
      } catch (error) {
        api.log.warn({err: error}, 'Player statistics request failed');
        response.writeHead(error.statusCode || 500, {'Content-Type': 'application/json; charset=utf-8'});
        response.end(JSON.stringify({error: error.statusCode ? error.message : 'Request failed.'}));
      }
      return true;
    }
    if (request.method !== 'GET') return false;
    if (url.pathname.startsWith('/assets/')) {
      let requested;
      try { requested = decodeURIComponent(url.pathname.slice('/assets/'.length)); }
      catch (error) { requested = ''; }
      const filename = path.basename(requested);
      const contentType = assetContentTypes[path.extname(filename).toLowerCase()];
      if (!filename || filename !== requested || !contentType) {
        response.writeHead(400, {'Content-Type': 'text/plain; charset=utf-8'});
        response.end('Bad asset filename.');
        return true;
      }
      try {
        const contents = await fs.promises.readFile(path.join(assetRoot, filename));
        response.writeHead(200, {'Content-Type': contentType});
        response.end(contents);
      } catch (error) {
        response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        response.end('Asset not found.');
      }
      return true;
    }
    if (url.pathname === '/api/ladder') {
      await safelySendJson(api, response, () => analytics.ranking(url.query));
      return true;
    }
    if (url.pathname === '/api/ladder-config') {
      json(response, {rankingBasis: analytics ? analytics.rankingBasis() : 'points'});
      return true;
    }
    if (url.pathname === '/api/example-decks') {
      await safelySendJson(api, response, () => loadExampleDecks(path.resolve(api.rootDir, api.config.exampleDecksFile)));
      return true;
    }
    if (url.pathname === '/api/ladder-deck-stats') {
      await safelySendJson(api, response, () => analytics.deckStats(url.query));
      return true;
    }
    if (url.pathname === '/api/ladder/usage/cards') {
      await safelySendJson(api, response, () => usage.cardUsage(url.query));
      return true;
    }
    if (url.pathname === '/api/ladder/usage/decks') {
      await safelySendJson(api, response, () => usage.deckUsage(url.query));
      return true;
    }
    if (url.pathname === '/api/ladder/deck-search') {
      json(response, {decks: usage.searchDecks(url.query)});
      return true;
    }
    if (url.pathname === '/api/ladder/deck-detail') {
      await safelySendJson(api, response, () => usage.deckDetail(url.query));
      return true;
    }
    if (url.pathname === '/api/ladder/deck-template') {
      const template = classifier?.getTemplate?.(url.query.deckTypeId);
      if (!template) {
        response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        response.end('Deck template not found.');
      } else {
        response.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${template.filename}"`,
          'Cache-Control': 'public, max-age=300'
        });
        response.end(template.contents);
      }
      return true;
    }
    const page = routes[url.pathname];
    if (page) {
      const filename = path.resolve(api.rootDir, page);
      try {
        // Read first so a missing/misconfigured file can still return a clean
        // 404 instead of attempting to replace headers already sent as 200.
        const contents = await fs.promises.readFile(filename);
        response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        response.end(contents);
      } catch (error) {
        response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        response.end(`Web page not found: ${path.basename(filename)}`);
      }
      return true;
    }
    if (url.pathname.startsWith('/example_decks/')) {
      const filename = path.basename(decodeURIComponent(url.pathname.slice('/example_decks/'.length)));
      if (!filename.toLowerCase().endsWith('.ydk')) return false;
      try {
        response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment'});
        response.end(await fs.promises.readFile(path.join(webRoot, 'example_decks', filename)));
      } catch (error) {
        response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        response.end('Deck not found.');
      }
      return true;
    }
    return false;
  });
};

module.exports._test = {loadExampleDecks, readJsonBody};
