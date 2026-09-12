'use strict';

const fs = require('fs');
const path = require('path');

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

module.exports.init = api => {
  const analytics = api.get('ladderAnalytics');
  const routes = JSON.parse(fs.readFileSync(path.resolve(api.rootDir, api.config.routesFile), 'utf8'));
  const webRoot = path.join(api.rootDir, 'web');
  api.hook('http_request', async (request, response, url) => {
    if (request.method !== 'GET') return false;
    if (url.pathname === '/api/ladder') {
      await safelySendJson(api, response, () => analytics.ranking(url.query));
      return true;
    }
    if (url.pathname === '/api/ladder-config') {
      json(response, {rankingBasis: analytics ? analytics.rankingBasis() : 'points'});
      return true;
    }
    if (url.pathname === '/api/ladder-deck-stats') {
      await safelySendJson(api, response, () => analytics.deckStats(url.query));
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
