'use strict';

const fail = (statusCode, code) => Object.assign(new Error(code), {statusCode, code});

// Runs ad-hoc statistics in one bounded, read-only snapshot so a slow query
// cannot hold locks or worker memory on the live ladder database.
async function runReadOnly(dataManager, work) {
  const connection = dataManager.getConnection(), postgres = connection.options.type === 'postgres';
  const placeholder = index => postgres ? `$${index}` : '?';
  const runner = connection.createQueryRunner();
  try {
    await runner.connect();
    if (postgres) {
      await runner.startTransaction('REPEATABLE READ');
      await runner.query('SET TRANSACTION READ ONLY');
      await runner.query("SET LOCAL statement_timeout = '3s'");
      await runner.query("SET LOCAL lock_timeout = '500ms'");
      await runner.query("SET LOCAL work_mem = '4MB'");
      await runner.query('SET LOCAL max_parallel_workers_per_gather = 0');
    }
    const result = await work((sql, params) => runner.query(sql, params), placeholder);
    if (postgres) await runner.commitTransaction();
    return result;
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    if (error.code === '57014' || error.code === '55P03') throw fail(503, 'statistics_unavailable');
    throw error;
  } finally { await runner.release(); }
}

// Caches serialized aggregates so callers receive private copies. Identical
// requests share one query; a generation counter keeps in-flight results from
// repopulating the cache after invalidation.
function createAggregateCache({maxKeys = 16, maxBytes = 2 * 1024 * 1024, ttl = 30000, maxActive = 2} = {}) {
  const cache = new Map(), pending = new Map();
  let cacheBytes = 0, active = 0, generation = 0;
  const remove = key => {
    const entry = cache.get(key);
    if (entry) cacheBytes -= entry.bytes;
    cache.delete(key);
  };
  const invalidate = () => { generation++; cache.clear(); cacheBytes = 0; pending.clear(); };

  async function get(key, compute) {
    for (const [id, entry] of cache) if (Date.now() - entry.time >= ttl) remove(id);
    let json = cache.get(key)?.json;
    if (!json) {
      let work = pending.get(key);
      if (!work) {
        if (active >= maxActive) throw fail(429, 'statistics_busy');
        const version = generation;
        active++;
        work = compute().then(value => {
          const result = JSON.stringify(value), bytes = Buffer.byteLength(result);
          if (version === generation && bytes <= maxBytes) {
            while (cache.size && (cache.size >= maxKeys || cacheBytes + bytes > maxBytes)) remove(cache.keys().next().value);
            cache.set(key, {json:result,bytes,time:Date.now()}); cacheBytes += bytes;
          }
          return result;
        }).finally(() => { if (pending.get(key) === work) pending.delete(key); active--; });
        pending.set(key, work);
      }
      json = await work;
    }
    return JSON.parse(json);
  }

  return {get, invalidate};
}

// Shared validation for the public period/month query parameters.
function validatePeriod(input) {
  if (input.period && !['today','week','month','all'].includes(input.period)) throw fail(400, 'invalid_period');
  if ((input.period || 'month') === 'month' && input.month != null && input.month !== '') {
    const month = String(input.month);
    if (!/^\d{4}(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0,4)) < 1000 || Number(month.slice(0,4)) >= 9999) throw fail(400, 'invalid_month');
  }
}

module.exports = {fail, runReadOnly, createAggregateCache, validatePeriod};
