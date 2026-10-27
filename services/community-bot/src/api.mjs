export function shanghaiDay(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return {date: `${parts.year}-${parts.month}-${parts.day}`, month: `${parts.year}${parts.month}`,
    hour: Number(parts.hour), minute: Number(parts.minute)};
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class GameApi {
  constructor(config, fetchImpl = fetch) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '') + '/';
    this.timeoutMs = config.timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(route, options = {}) {
    const url = new URL(route.replace(/^\/+/, ''), this.baseUrl);
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      const signal = AbortSignal.timeout(this.timeoutMs);
      try {
        const response = await this.fetch(url, {cache: 'no-store', signal, ...options});
        if (!response.ok) {
          const error = new Error(`Game API HTTP ${response.status}`);
          error.status = response.status;
          if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
            await delay(300);
            continue;
          }
          throw error;
        }
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt > 0 || error.status && error.status < 500 && error.status !== 429) break;
        await delay(300);
      }
    }
    throw lastError;
  }

  async getRooms() {
    const result = await this.request('api/public/rooms');
    if (!Array.isArray(result?.rooms)) throw new Error('Game API returned invalid rooms data');
    return result.rooms;
  }

  async getMonthlyTop10(month) {
    const result = await this.request(`api/ladder?type=month&month=${encodeURIComponent(month)}&page=1&pageSize=10`);
    if (!Array.isArray(result?.ladder)) throw new Error('Game API returned invalid ranking data');
    return result;
  }

  async getPublicPlayer(player, month) {
    const result = await this.request('api/ladder/player', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({player, month, page: 1, password: ''})
    });
    if (typeof result?.found !== 'boolean' || result.authenticated === true) {
      throw new Error('Game API returned invalid public player data');
    }
    return result;
  }
}
