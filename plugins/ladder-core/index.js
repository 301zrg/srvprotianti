'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame} = require('./entities');
const translations = require('./i18n.json');
const {createLiveAfkPenaltyConfig} = require('./afk-policy');
const {createLiveTurnTimeConfig} = require('./turn-time');
const passwordHash = require('./password-hash');
const {FixedWindowLimiter, ScryptGate, VerifyCache} = require('./password-guard');
const credentials = require('./credentials');
const departurePenaltyReasons = new Set(['${random_ban_reason_AFK}', '${random_ban_reason_flee}', '${random_ban_reason_zombie}']);
const fourLanguageMessage = key => ['zh-cn', 'en-us', 'ja-jp', 'ko-kr']
  .map(language => translations[language][key]).join(' / ');

const entities = Object.freeze({LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame});
const defaultRating = Object.freeze({
  initialPoints: 1000, useDynamic: true, minDelta: 8, maxDelta: 15,
  fixedDelta: 12, kFactor: 20, totalWeight: 0.6, monthWeight: 0.4
});

const normalizeName = value => String(value || '').trim().toLowerCase();
const monthKey = date => {
  const value = date || new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit'})
    .formatToParts(value).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
  return `${parts.year}${parts.month}`;
};

function normalizeRating(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('rating must be an object.');
  const rating = {...defaultRating, ...config};
  for (const key of ['totalWeight', 'monthWeight']) {
    if (!Number.isFinite(rating[key]) || rating[key] < 0 || rating[key] > 1) {
      throw new TypeError(`rating.${key} must be a number between 0 and 1.`);
    }
  }
  const weightSum = rating.totalWeight + rating.monthWeight;
  if (weightSum === 0) throw new TypeError('Rating weights must not both be zero.');
  rating.totalWeight /= weightSum;
  rating.monthWeight /= weightSum;
  for (const key of ['initialPoints', 'minDelta', 'maxDelta', 'fixedDelta']) {
    if (!Number.isSafeInteger(rating[key]) || rating[key] < (key === 'initialPoints' ? 1 : 0)) {
      throw new TypeError(`rating.${key} must be a valid non-negative integer (initialPoints must be positive).`);
    }
  }
  if (rating.minDelta > rating.maxDelta) throw new TypeError('rating.minDelta must not exceed maxDelta.');
  if (!Number.isFinite(rating.kFactor) || rating.kFactor <= 0) throw new TypeError('rating.kFactor must be positive.');
  if (typeof rating.useDynamic !== 'boolean') throw new TypeError('rating.useDynamic must be a boolean.');
  return Object.freeze(rating);
}

function readRatingConfig(filename) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Plugin config must be an object.');
  const rating = config.rating === undefined ? {} : config.rating;
  if (!rating || typeof rating !== 'object' || Array.isArray(rating)) throw new TypeError('rating must be an object.');
  return rating;
}

function createLiveRatingConfig(rootDir, fallback = {}, log = null) {
  let current = normalizeRating();
  const warn = error => log?.warn?.({event: 'ladder_rating_config_invalid', reason: error.code || error.name},
    'Ladder rating config reload failed; keeping last valid values.');
  try {
    current = normalizeRating(fallback);
  } catch (error) {
    warn(error);
  }
  return () => {
    try {
      // Rebuild from defaults so removing a local override restores its default.
      current = normalizeRating({
        ...readRatingConfig(path.join(rootDir, 'config.default.json')),
        ...readRatingConfig(path.join(rootDir, 'config.json'))
      });
    } catch (error) {
      warn(error);
    }
    return current;
  };
}

const ratingFormulaFile = path.join(__dirname, 'rating-formula.js');

// A hot-edited formula must pass these plausibility checks before it can
// settle a real match: integer deltas, winner never loses points, loser never
// gains, and balances stay finite and at or above the declared floor.
function checkRatingFormula(formula) {
  for (const name of ['combinedPoints', 'calculateDelta', 'settleMatch']) {
    if (typeof formula?.[name] !== 'function') throw new TypeError(`rating formula must export ${name}().`);
  }
  if (!Number.isSafeInteger(formula.MINIMUM_POINTS) || formula.MINIMUM_POINTS < 0) {
    throw new TypeError('rating formula MINIMUM_POINTS must be a non-negative integer.');
  }
  if (!Number.isFinite(formula.ELO_SCALE) || formula.ELO_SCALE <= 0) throw new TypeError('rating formula ELO_SCALE must be positive.');
  const dynamic = normalizeRating();
  const samples = [[1000, 1000, 1000, 1000], [1400, 1200, 1600, 1000], [3000, 1000, 1000, 1000], [0, 0, 1000, 1000], [5, 5, 1200, 1200]];
  for (const rating of [dynamic, normalizeRating({useDynamic: false}), normalizeRating({monthWeight: 0})]) {
    for (const [totalA, monthA, totalB, monthB] of samples) {
      for (const winnerIndex of [0, 1]) {
        const players = [{total: totalA, month: monthA}, {total: totalB, month: monthB}];
        checkSettlement(formula.settleMatch(players, winnerIndex, rating), players, winnerIndex, formula.MINIMUM_POINTS);
      }
    }
  }
  return formula;
}

// Also applied to every real settlement and preview: deltas must be plausible
// and each balance must be exactly max(floor, before + delta), so the stored
// balances can never contradict the delta written to the Match record.
function checkSettlement(result, players, winnerIndex, minimumPoints) {
  for (let index = 0; index < 2; index++) {
    const delta = result?.deltas?.[index], after = result?.after?.[index];
    const won = index === winnerIndex;
    if (!Number.isSafeInteger(delta) || (won ? delta < 0 : delta > 0)) throw new RangeError('rating formula produced an implausible delta.');
    if (!Number.isFinite(result.combined?.[index])) throw new RangeError('rating formula produced a non-finite combined rating.');
    for (const key of ['total', 'month']) {
      if (!Number.isSafeInteger(after?.[key]) || after[key] !== Math.max(minimumPoints, Number(players[index][key]) + delta)) {
        throw new RangeError('rating formula produced a balance inconsistent with its delta.');
      }
    }
  }
  return result;
}

function loadRatingFormula(filename) {
  const resolved = require.resolve(filename);
  delete require.cache[resolved];
  try {
    return checkRatingFormula(require(resolved));
  } finally {
    delete require.cache[resolved];
  }
}

// Like createLiveRatingConfig: a file edit takes effect at the next call.
// `trusted` is the last formula that produced a valid result for real input
// (initially the one loaded at startup). If a newly loaded formula throws or
// fails the check on real input, the same input is recomputed with `trusted`
// before anything is written, and the bad version stays disabled until the
// file changes again. A finished match is therefore never lost to a bad edit.
function createLiveRatingFormula(filename = ratingFormulaFile, log = null) {
  const digestOf = () => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  let digest = digestOf();
  let current = loadRatingFormula(filename);
  let trusted = current;
  const warn = (event, error) => log?.warn?.({event, reason: error.code || error.name, message: error.message},
    'Ladder rating formula rejected; keeping the last valid formula.');
  const refresh = () => {
    let next;
    try {
      next = digestOf();
    } catch (error) {
      warn('ladder_rating_formula_invalid', error);
      return current;
    }
    if (next === digest) return current;
    digest = next;
    try {
      current = loadRatingFormula(filename);
      log?.info?.({event: 'ladder_rating_formula_reloaded'}, 'Ladder rating formula reloaded.');
    } catch (error) {
      warn('ladder_rating_formula_invalid', error);
    }
    return current;
  };
  // Returns {formula, result}; throws only if even the trusted formula fails.
  refresh.run = (players, winnerIndex, rating) => {
    const formula = refresh();
    const attempt = candidate => checkSettlement(candidate.settleMatch(players, winnerIndex, rating), players, winnerIndex, candidate.MINIMUM_POINTS);
    try {
      const result = attempt(formula);
      trusted = formula;
      return {formula, result};
    } catch (error) {
      if (formula === trusted) throw error;
      warn('ladder_rating_formula_runtime_invalid', error);
      current = trusted;
      return {formula: trusted, result: attempt(trusted)};
    }
  };
  return refresh;
}

const calculateDelta = (...args) => loadRatingFormula(ratingFormulaFile).calculateDelta(...args);
const previewName = value => String(value ?? '').split('$', 1)[0].trim();

function createService(api) {
  const states = new Map();
  const settledRooms = new WeakSet();
  const classifier = api.get('deckClassifier');
  const liveRating = createLiveRatingConfig(api.rootDir, api.config.rating, api.log);
  const liveFormula = createLiveRatingFormula(api.ratingFormulaFile || ratingFormulaFile, api.log);
  const initialPoints = liveRating().initialPoints;
  const publicRules = (rating = liveRating(), formula = liveFormula()) =>
    ({...rating, initialPoints, minimumPoints: formula.MINIMUM_POINTS, eloScale: formula.ELO_SCALE});
  const repo = entity => api.dataManager.getRepository(entity);

  const ensureState = roomId => {
    let state = states.get(roomId);
    if (!state) {
      state = {matchKey: `${Date.now()}-${roomId}-${crypto.randomBytes(8).toString('hex')}`, games: new Map(), duelLogs: new Map(), coinWinner: null};
      states.set(roomId, state);
    }
    return state;
  };

  // ---- Credentials (design 2.1, 2.3, 2.5, 6.2, 6.3) ----------------------
  const security = credentials.createLiveSecurityConfig(api.rootDir, api.config, api.log);
  const {config: tuning, invalid: invalidTuning} = credentials.normalizePasswordSecurity(api.config.passwordSecurity,
    {paramsAllowed: passwordHash.paramsAllowed});
  if (invalidTuning.length) {
    api.log.warn({event: 'ladder_password_security_invalid', fields: invalidTuning}, 'Invalid passwordSecurity fields; using defaults for them.');
  }
  const hashParams = api.passwordHashParams || tuning.scrypt;
  const gate = api.scryptGate || new ScryptGate({slots: tuning.slots, webSlots: tuning.webSlots, webQueue: tuning.webQueue,
    webWaitMs: tuning.webWaitMs, joinQueue: tuning.joinQueue, joinWaitMs: tuning.joinWaitMs});
  const minute = 60 * 1000;
  const webIpLimiter = new FixedWindowLimiter({limit: tuning.webPerIpPerMinute, windowMs: minute});
  const webAccountLimiter = new FixedWindowLimiter({limit: tuning.webPerAccountPerMinute, windowMs: minute});
  const failureWindow = tuning.changeFailureWindowMinutes * minute;
  const changeIpFailures = new FixedWindowLimiter({limit: tuning.changeFailuresPerIp, windowMs: failureWindow});
  const changeAccountFailures = new FixedWindowLimiter({limit: tuning.changeFailuresPerAccount, windowMs: failureWindow});
  const verifyCache = new VerifyCache();
  let inflightWrites = 0;
  let lastMode = null;
  let awaitingQuiesce = false;
  const userManager = () => repo(LadderUser).manager;

  const checkQuiesced = () => {
    if (awaitingQuiesce && inflightWrites === 0) {
      awaitingQuiesce = false;
      api.log.warn({event: 'ladder_password_frozen_quiesced'},
        'Ladder credentials frozen: no in-process credential write remains. Make sure no conversion or reset script is still running.');
    }
  };
  const readSecurity = async () => {
    const config = await security();
    if (config.mode !== lastMode) {
      if (config.mode === 'frozen') awaitingQuiesce = true;
      if (lastMode !== null) api.log.warn({event: 'ladder_password_mode_changed', from: lastMode, to: config.mode}, 'Ladder password mode changed.');
      lastMode = config.mode;
    }
    checkQuiesced();
    return config;
  };
  // Every credential write runs inside this so frozen mode can confirm that
  // nothing started earlier is still writing.
  const trackWrite = async operation => {
    inflightWrites++;
    try {
      return await operation();
    } finally {
      inflightWrites--;
      checkQuiesced();
    }
  };
  const verifyIn = (lane, stored, password) => passwordHash.needsScrypt(stored)
    ? gate.run(lane, () => passwordHash.verifyPassword(stored, password))
    : passwordHash.verifyPassword(stored, password);

  // Refuses a return to legacy once the table holds hashes, even after a restart.
  async function checkStoredHashes() {
    if (await credentials.anyHashedCredential(userManager())) security.raiseFloor('hashed');
  }

  // Room entry. One scrypt at most; the result is what the seat is bound to.
  // {ok, key, credentialVersion, temporary} or {ok: false, reason}.
  async function authenticateAccount(displayName, password) {
    const key = normalizeName(displayName);
    // No password, no account: never create or accept a password-less login,
    // whatever a leftover requirePassword setting says (design 2.3, B7).
    if (!key) return {ok: false, reason: 'mismatch'};
    if (typeof password !== 'string' || !password) {
      // A PC player typing "name＄password" sends no ASCII separator, so the
      // server sees a nickname with "＄" and no password. Explain the
      // separator instead of a bare mismatch (found in lab testing 11-27).
      return {ok: false, reason: passwordHash.containsLookalikeDollar(displayName) ? 'lookalike_dollar' : 'mismatch'};
    }
    const existing = await repo(LadderUser).findOne(key);
    const check = async user => {
      if (!user.pass) return {ok: false, reason: 'no_password_account'};
      const result = await verifyIn('join', user.pass, password);
      return result.ok ? {ok: true, key, credentialVersion: user.pass, temporary: result.kind === 'temp'} : {ok: false, reason: 'mismatch'};
    };
    if (existing) return check(existing);
    // Plan C: a full-width or small dollar sign is a mistyped separator.
    // Refuse to create such an account; existing ones keep working.
    if (passwordHash.containsLookalikeDollar(displayName)) return {ok: false, reason: 'lookalike_dollar'};
    const {mode} = await readSecurity();
    if (mode === 'frozen') return {ok: false, reason: 'registration_paused'};
    const stored = mode === 'hashed' ? await gate.run('join', () => passwordHash.hashPassword(password, {params: hashParams})) : password;
    const created = await trackWrite(() => credentials.insertAccount(userManager(), {
      name: key,
      displayName: String(displayName).trim(),
      pass: stored,
      createdAt: new Date(),
      currentWinStreak: 0,
      duelPoints: initialPoints,
      monthDuelPoints: initialPoints
    }));
    if (created) return {ok: true, key, credentialVersion: stored, temporary: false};
    // A simultaneous first login won the insert: check against its row.
    const winner = await repo(LadderUser).findOne(key);
    return winner ? check(winner) : {ok: false, reason: 'mismatch'};
  }

  async function authenticate(displayName, password) {
    return (await authenticateAccount(displayName, password)).ok;
  }

  const tooMany = () => Object.assign(new Error('Too many attempts. Please wait a minute.'), {statusCode: 429, code: 'too_many_attempts'});

  // Data site. Never creates an account. Only a request that is about to run
  // scrypt is counted against the budgets: cache hits and legacy plaintext
  // checks cost nothing, so a player paging through their own stats is never
  // throttled (maintainer decision 11-27). Slot exhaustion surfaces as 503.
  async function verifyExisting(displayName, password, context = {}) {
    const key = normalizeName(displayName);
    if (!key || typeof password !== 'string' || !password) return false;
    const user = await repo(LadderUser).findOne(key);
    if (!user || !user.pass) return false;
    if (verifyCache.hit(key, password, user.pass)) return true;
    if (passwordHash.needsScrypt(user.pass)) {
      const ip = String(context.ip || 'unknown');
      if (!webIpLimiter.take(ip) || !webAccountLimiter.take(key)) throw tooMany();
    }
    const result = await verifyIn('web', user.pass, password);
    if (result.ok) verifyCache.remember(key, password, user.pass);
    return result.ok;
  }

  // Current stored credential, used to re-check a reconnect at takeover.
  async function credentialVersionOf(key) {
    const user = await repo(LadderUser).findOne(key);
    return user ? user.pass ?? null : null;
  }

  // POST /api/ladder/account/password. Returns {status, body}.
  async function changePassword(input = {}, context = {}) {
    const reply = (status, error) => ({status, body: error ? {error} : {ok: true}});
    const {mode, passwordChangeEnabled} = await readSecurity();
    if (!passwordChangeEnabled) return reply(404, 'not_found');
    if (mode !== 'hashed') return reply(503, 'password_change_unavailable');
    const player = typeof input.player === 'string' ? input.player.trim() : '';
    const {oldPassword, newPassword} = input;
    const key = normalizeName(player);
    const ip = String(context.ip || 'unknown');
    if (changeIpFailures.exhausted(ip) || (key && changeAccountFailures.exhausted(key))) return reply(429, 'too_many_attempts');
    if (!webIpLimiter.take(ip) || (key && !webAccountLimiter.take(key))) return reply(429, 'too_many_attempts');
    if (!key || player.length > 64 || typeof oldPassword !== 'string' || !oldPassword || typeof newPassword !== 'string') {
      return reply(400, 'invalid_request');
    }
    const rule = passwordHash.validateNewPassword(player, newPassword);
    if (rule) return reply(400, rule);
    if (newPassword === oldPassword) return reply(400, 'password_unchanged');
    const fail = () => {
      changeIpFailures.take(ip);
      changeAccountFailures.take(key);
      // Unknown account and wrong old password are indistinguishable.
      return reply(403, 'credentials_invalid');
    };
    const user = await repo(LadderUser).findOne(key);
    if (!user || !user.pass) return fail();
    const expected = user.pass;
    if (!(await verifyIn('web', expected, oldPassword)).ok) return fail();
    const next = await gate.run('web', () => passwordHash.hashPassword(newPassword, {params: hashParams}));
    // The mode may have been switched to frozen while hashing.
    if ((await readSecurity()).mode !== 'hashed') return reply(503, 'password_change_unavailable');
    const changed = await trackWrite(() => credentials.compareAndSetPass(userManager(), key, expected, next));
    if (!changed) return reply(409, 'credentials_changed');
    api.log.info({event: 'ladder_password_changed', account: key}, 'Ladder password changed by its owner.');
    return reply(200);
  }

  async function getMonthlyProfile(displayName) {
    const key = normalizeName(displayName);
    const [record, user] = await Promise.all([
      repo(LadderMonthRecord).findOne({where: {name: key, monthKey: monthKey()}}),
      repo(LadderUser).findOne(key)
    ]);
    return {
      points: Number(record?.duelPoints ?? initialPoints),
      wins: Number(record?.wins || 0),
      losses: Number(record?.losses || 0),
      currentWinStreak: Number(user?.currentWinStreak || 0)
    };
  }

  function captureGame(event) {
    if (!event || event.randomType !== api.config.mode || event.players.length !== 2) return;
    const immutable = {
      ...event,
      players: event.players.map(player => ({
        ...player,
        name: normalizeName(player.name),
        displayName: player.name,
        main: player.main.slice(),
        side: player.side.slice(),
        deckTypeId: classifier.classify(player.main)
      }))
    };
    ensureState(event.roomId).games.set(Number(event.duelCount), immutable);
  }

  function linkDuelLog(event) {
    if (!event || event.randomType !== api.config.mode || event.duelLogId == null) return;
    ensureState(event.roomId).duelLogs.set(Number(event.duelCount), event.duelLogId);
  }

  function captureRpsWinner(event) {
    if (!event || event.randomType !== api.config.mode || !event.playerName) return;
    // RPS happens once before G1. SELECT_TP is sent only to its winner, so the
    // host event is more reliable than reimplementing rock-paper-scissors.
    const state = ensureState(event.roomId);
    if (!state.coinWinner) state.coinWinner = normalizeName(event.playerName);
  }

  // Design 2.2 / 6.1: identity is bound to the seat when the match starts.
  // Each seat remembers the host's score key (the connection's name_vpass at
  // start, which the host carries over on reconnect) and the account that was
  // verified when that connection joined. Settlement trusts only this table.
  function registerSeats(roomId, players) {
    const state = ensureState(roomId);
    state.seats = (players || []).filter(Boolean).map(player => ({
      scoreKey: String(player.name_vpass ?? player.name ?? ''),
      pos: player.pos,
      key: player.account_binding?.key || null
    }));
    return state.seats;
  }

  // Is any started TT seat bound to this account? Cheap, in memory.
  const hasBoundSeat = key => [...states.values()].some(state => (state.seats || []).some(seat => seat.key === key));

  const unbound = (room, cause) => api.log.warn({event: 'ladder_settlement_unbound', roomId: room.process_pid, cause},
    'Ladder settlement skipped because a seat has no verified account.');

  async function settle(room, scores, outcome) {
    if (!room || room.random_type !== api.config.mode || !Array.isArray(scores) || scores.length !== 2) return;
    if (settledRooms.has(room)) return;
    const terminal = !!outcome && (!!outcome.matchCompleted || !!outcome.explicitForfeit);
    if (!terminal) {
      states.delete(room.process_pid);
      api.log.warn({
        event: 'ladder_settlement_skipped',
        roomId: room.process_pid,
        cause: outcome?.cause || 'missing_terminal_outcome',
        duelEndSeen: !!outcome?.duelEndSeen
      }, 'Ladder settlement skipped because the room had no confirmed terminal result.');
      return;
    }
    const scoreA = Number(scores[0].score);
    const scoreB = Number(scores[1].score);
    if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB) return;
    const state = ensureState(room.process_pid);
    if (state.settled || state.settling) return;
    const seatForms = scores.map(form => {
      const seat = (state.seats || []).find(item => item.scoreKey === String(form.name_vpass ?? form.name ?? ''));
      return seat && seat.key ? {key: seat.key, displayName: String(form.name || '').trim(), score: Number(form.score)} : null;
    });
    if (seatForms.some(form => !form)) return unbound(room, state.seats ? 'seat_not_bound' : 'seats_not_registered');
    if (seatForms[0].key === seatForms[1].key) return unbound(room, 'same_account');
    const orderedGames = [...state.games.values()].sort((a, b) => a.duelCount - b.duelCount);
    // For an ordinary completed Match, the host scoreboard and immutable
    // per-game WIN events must describe exactly the same result. Refuse to
    // award points if an upstream protocol regression makes them disagree.
    // Negative disconnect penalties and MATCH_KILL's sentinel score are not
    // ordinary game-win counters, so they are intentionally excluded.
    if (scoreA >= 0 && scoreA <= 3 && scoreB >= 0 && scoreB <= 3) {
      const capturedWins = new Map();
      for (const game of orderedGames) {
        const winner = normalizeName(game.winnerName);
        capturedWins.set(winner, (capturedWins.get(winner) || 0) + 1);
      }
      const expectedScores = scores.map(form => capturedWins.get(normalizeName(form.name)) || 0);
      // Drawn games legitimately make orderedGames longer than scoreA+scoreB.
      if (expectedScores[0] !== scoreA || expectedScores[1] !== scoreB) {
        throw new Error(`Ladder settlement rejected: scoreboard ${scoreA}-${scoreB} disagrees with captured games ${expectedScores[0]}-${expectedScores[1]}.`);
      }
    }
    state.settling = true;
    let committedMatch = null;
    try {
      await api.dataManager.pluginTransaction(async manager => {
        // The unique matchKey makes a repeated room cleanup idempotent.
        if (await manager.findOne(LadderMatch, {where: {matchKey: state.matchKey}})) return;
        // Accounts come from the seats bound at start. No password is compared
        // here and no scrypt runs inside the transaction: a password changed
        // during the match does not affect this result (design 2.2).
        const forms = seatForms;
        const now = new Date();
        const month = monthKey(now);
        const users = [];
        const monthRows = [];
        const driver = api.dataManager.getConnection().options.type;
        let lockedUsers = [];
        if (driver !== 'sqlite' && driver !== 'sqljs') {
          // Serialize simultaneous matches that update the same account so an
          // older points value cannot overwrite a just-committed result.
          lockedUsers = await manager.getRepository(LadderUser).createQueryBuilder('u')
            .where('u.name IN (:...names)', {names: forms.map(form => form.key).sort()})
            .setLock('pessimistic_write').getMany();
        }
        for (const form of forms) {
          const user = lockedUsers.find(item => item.name === form.key) || await manager.findOne(LadderUser, form.key);
          // The account was created when the seat was verified. Never rebuild
          // it from a stale snapshot; a missing row means something is wrong.
          if (!user) throw Object.assign(new Error('Ladder account missing at settlement.'), {code: 'ladder_account_missing'});
          if (!user.displayName) user.displayName = form.displayName;
          user.duelPoints = Number(user.duelPoints ?? initialPoints);
          user.wins = Number(user.wins || 0);
          user.losses = Number(user.losses || 0);
          let record = await manager.findOne(LadderMonthRecord, {where: {name: form.key, monthKey: month}});
          if (!record) record = manager.create(LadderMonthRecord, {name: form.key, monthKey: month, duelPoints: initialPoints, wins: 0, losses: 0, scoreDiff: 0});
          users.push(user);
          monthRows.push(record);
        }

        const winnerIndex = scoreA > scoreB ? 0 : 1;
        const before = users.map(user => Number(user.duelPoints ?? initialPoints));
        // Both players use one settlement-time config and pre-match month snapshot.
        // Combined points only estimate win probability; Match records retain total points.
        // The formula lives in rating-formula.js so the web calculator's
        // preview runs exactly the same code as this settlement.
        const rating = liveRating();
        const outcome = liveFormula.run(before.map((points, index) => ({
          total: points, month: Number(monthRows[index].duelPoints ?? initialPoints)
        })), winnerIndex, rating).result;
        const deltas = outcome.deltas;
        for (let index = 0; index < 2; index++) {
          const won = index === winnerIndex;
          users[index].duelPoints = outcome.after[index].total;
          users[index].wins += won ? 1 : 0;
          users[index].losses += won ? 0 : 1;
          users[index].currentWinStreak = won ? Number(users[index].currentWinStreak || 0) + 1 : 0;
          monthRows[index].duelPoints = outcome.after[index].month;
          monthRows[index].wins = Number(monthRows[index].wins || 0) + (won ? 1 : 0);
          monthRows[index].losses = Number(monthRows[index].losses || 0) + (won ? 0 : 1);
          monthRows[index].scoreDiff = monthRows[index].wins - monthRows[index].losses;
          // Keep compatibility fields current; historical ranking reads the month table.
          Object.assign(users[index], {monthKey: month, monthDuelPoints: monthRows[index].duelPoints, monthWins: monthRows[index].wins, monthLosses: monthRows[index].losses});
        }
        await manager.save(LadderMonthRecord, monthRows);

        const firstGame = orderedGames[0];
        const deckFor = key => {
          const player = firstGame && firstGame.players.find(item => item.name === key);
          return player ? player.deckTypeId : classifier.otherDeckTypeId;
        };
        const match = await manager.save(LadderMatch, manager.create(LadderMatch, {
          matchKey: state.matchKey,
          roomId: room.process_pid,
          monthKey: month,
          winnerName: forms[winnerIndex].key,
          loserName: forms[1 - winnerIndex].key,
          playerAName: forms[0].key,
          playerBName: forms[1].key,
          playerADisplayName: forms[0].displayName,
          playerBDisplayName: forms[1].displayName,
          playerADeckTypeId: deckFor(forms[0].key),
          playerBDeckTypeId: deckFor(forms[1].key),
          playerADuelPointsBefore: before[0], playerBDuelPointsBefore: before[1],
          playerADuelPointsDelta: deltas[0], playerBDuelPointsDelta: deltas[1],
          playerADuelPointsAfter: users[0].duelPoints, playerBDuelPointsAfter: users[1].duelPoints,
          g1FirstPlayer: firstGame ? firstGame.players.find(player => player.isFirst)?.name || null : null,
          coinWinner: state.coinWinner,
          duelLogId: state.duelLogs.get(1) || null,
          createTime: now
        }));
        committedMatch = match;
        for (const user of users) user.lastMatchId = match.id;
        await manager.save(LadderUser, users);

        const gameRows = [];
        for (const game of orderedGames) {
          const winner = normalizeName(game.winnerName);
          for (let index = 0; index < 2; index++) {
            const player = game.players[index];
            const opponent = game.players[1 - index];
            gameRows.push(manager.create(LadderMatchGame, {
              matchId: match.id,
              duelLogId: state.duelLogs.get(Number(game.duelCount)) || null,
              playerName: player.name,
              playerDisplayName: player.displayName,
              opponentName: opponent.name,
              opponentDisplayName: opponent.displayName,
              // A deck's type is defined by its pre-side G1 list. G2/G3 side
              // changes must not change either player's archetype.
              deckTypeId: deckFor(player.name),
              opponentDeckTypeId: deckFor(opponent.name),
              winnerName: winner,
              duelCount: Number(game.duelCount),
              isFirst: player.isFirst ? 1 : 0,
              isMain: Number(game.duelCount) === 1 ? 1 : 0,
              createTime: game.capturedAt || now
            }));
          }
        }
        if (gameRows.length) await manager.save(LadderMatchGame, gameRows);
      });
      state.settled = true;
      settledRooms.add(room);
      if (committedMatch) await api.emit('ladder_match_committed', {matchId: committedMatch.id, monthKey: committedMatch.monthKey});
    } catch (error) {
      if (error.code !== 'ladder_account_missing') throw error;
      unbound(room, 'account_missing');
    } finally {
      state.settling = false;
      if (state.settled) states.delete(room.process_pid);
    }
  }

  // Read-only what-if for the web calculator: same balances, config snapshot
  // and formula as settle(), but nothing is written and no account is created.
  async function previewMatch(names) {
    const inputs = Array.isArray(names) ? names.slice(0, 3).map(previewName) : [];
    const invalid = code => Object.assign(new Error('Invalid rating preview request.'), {statusCode: 400, code});
    if (inputs.length !== 2 || inputs.some(name => !name || name.length > 64)) throw invalid('invalid_player');
    const keys = inputs.map(normalizeName);
    if (keys[0] === keys[1]) throw invalid('same_player');
    const month = monthKey();
    const players = await Promise.all(keys.map(async (key, index) => {
      const [user, record] = await Promise.all([
        repo(LadderUser).findOne(key),
        repo(LadderMonthRecord).findOne({where: {name: key, monthKey: month}})
      ]);
      return {
        name: user ? user.displayName || user.name : inputs[index],
        found: !!user,
        total: Number(user?.duelPoints ?? initialPoints),
        month: Number(record?.duelPoints ?? initialPoints)
      };
    }));
    const rating = liveRating();
    const balances = players.map(player => ({total: player.total, month: player.month}));
    const runs = [0, 1].map(winnerIndex => liveFormula.run(balances, winnerIndex, rating));
    const results = runs.map(run => run.result);
    return {
      rules: publicRules(rating, runs[1].formula),
      players: players.map((player, index) => ({...player, combined: results[0].combined[index]})),
      outcomes: results.map((result, winnerIndex) => ({winnerIndex, deltas: result.deltas, after: result.after}))
    };
  }

  // Room cleanup: early returns inside settle() must not leave state behind
  // (review B2), so the state is dropped here whatever settle() did.
  async function finishRoom(room, scores, outcome) {
    try {
      await settle(room, scores, outcome);
    } finally {
      if (room && room.random_type === api.config.mode) states.delete(room.process_pid);
    }
  }

  // ---- TT reconnect (design 6.1) ---------------------------------------
  // Step 1, at JOIN_GAME: if this nickname belongs to an account bound to a
  // started TT seat, verify the CURRENT stored credential. Returns null when
  // not applicable, {grant} on success, {error} on failure. Throws on a
  // database or slot failure; the host treats that as a refusal.
  async function authorizeReconnect(displayName, password) {
    const key = normalizeName(displayName);
    if (!key || !hasBoundSeat(key)) return null;
    const user = await repo(LadderUser).findOne(key);
    if (!user || !user.pass || typeof password !== 'string' || !password) return {error: 'mismatch'};
    const result = await verifyIn('join', user.pass, password);
    return result.ok ? {grant: {account: key, credentialVersion: user.pass}} : {error: 'mismatch'};
  }

  // Step 2, at the final takeover (UPDATE_DECK): the grant is still for the
  // seat's account and the stored credential has not changed since step 1.
  async function confirmReconnect(grant, target) {
    if (!grant || !target?.account_binding?.key || grant.account !== target.account_binding.key) return false;
    return (await credentialVersionOf(grant.account)) === grant.credentialVersion;
  }

  return {
    authenticate, authenticateAccount, verifyExisting, changePassword, checkStoredHashes, readSecurity,
    authorizeReconnect, confirmReconnect, registerSeats, finishRoom,
    getMonthlyProfile, captureGame, captureRpsWinner, linkDuelLog, settle, ensureState, initialPoints,
    previewMatch,
    hasRoomState: roomId => states.has(roomId),
    _inflightWrites: () => inflightWrites,
    // Tests only: the per-minute budgets are real, a test run is not.
    _resetAdmissionForTests() {
      for (const limiter of [webIpLimiter, webAccountLimiter, changeIpFailures, changeAccountFailures]) limiter.buckets.clear();
      verifyCache.clear();
    },
    ratingRules: () => publicRules(),
    entities,
    getRepository(name) {
      const entity = entities[name];
      if (!entity) throw new Error(`Unknown ladder entity: ${name}`);
      return repo(entity);
    }
  };
}

let enabled = false;
module.exports.register = api => {
  api.registerTranslations(translations);
  enabled = !!api.settings.modules.mysql?.enabled;
  if (!enabled) return;
  [LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame].forEach(api.registerEntity);
  const readTurnTime = createLiveTurnTimeConfig(api.rootDir, api.config.turnTimeLimitSeconds, api.log);
  api.hook('random_room_time_limit', type => type === api.config.mode ? readTurnTime() : null);
  api.hook('random_mode', type => type === api.config.mode ? {
    type: api.config.mode,
    max_player: 2,
    name_prefix: 'M#',
    no_rematch_check: !api.config.preventSameIpRematch,
    // The host never matches a player into a waiting room holding the same
    // account (for example a stale connection of a backgrounded tab).
    exclusive_names: true,
    separate_restricted_players: !!api.config.separateRestrictedPlayers,
    welcome: api.config.welcome == null || api.config.welcome === '${ladder_welcome}' || api.config.welcome === translations['zh-cn'].ladder_welcome
      ? fourLanguageMessage('ladder_welcome') : api.config.welcome
  } : null);
};

const authFailureMessages = Object.freeze({
  mismatch: 'ladder_auth_mismatch',
  no_password_account: 'ladder_auth_no_password',
  registration_paused: 'ladder_registration_paused',
  lookalike_dollar: 'ladder_fullwidth_dollar'
});

module.exports.init = async api => {
  if (!enabled || !api.dataManager) return;
  const service = createService(api);
  api.provide('ladderCore', service);
  if (Object.prototype.hasOwnProperty.call(api.config, 'requirePassword')) {
    api.log.info({event: 'ladder_require_password_ignored'},
      'Ladder config key requirePassword is ignored: a password is always required.');
  }
  const readAfkPenalty = createLiveAfkPenaltyConfig(api.rootDir, api.config.countAfkPenalty, api.log);
  api.hook('random_duel_afk_penalty', room =>
    room?.random_type === api.config.mode ? readAfkPenalty() : null);
  api.hook('random_duel_flee_penalty', room =>
    room?.random_type === api.config.mode ? readAfkPenalty() : null);
  api.hook('random_duel_zombie_penalty', room =>
    room?.random_type === api.config.mode ? readAfkPenalty() : null);
  api.hook('random_duel_penalty_history', async (type, record) => {
    if (type !== api.config.mode || !Array.isArray(record?.reasons) || !record.reasons.length || await readAfkPenalty()) return null;
    // Legacy records share one total count. Hide exempt reasons without changing
    // the stored history or guessing how many violations belonged to each reason.
    const reasons = record.reasons.filter(reason => !departurePenaltyReasons.has(reason));
    return reasons.length ? {reasons} : {ignore: true};
  });
  api.hook('resolve_room_join', async (client, room, requestedRoom) => {
    if (room?.random_type !== api.config.mode || String(requestedRoom).toUpperCase() === api.config.mode) return false;
    // A concrete TT room name is spectator-only. It cannot be used to bypass
    // random matchmaking and choose an opponent.
    if (room.duel_stage === global.ygopro.constants.DUEL_STAGE.BEGIN) {
      global.ygopro.stoc_die(client, fourLanguageMessage('ladder_direct_join_denied'));
    } else {
      await room.join_post_watch(client);
    }
    return true;
  });
  api.hook('before_join_room', async (client, room) => {
    if (!room || room.random_type !== api.config.mode) return null;
    if ((room.players || []).some(player => player && normalizeName(player.name) === normalizeName(client.name))) {
      return {error: fourLanguageMessage('ladder_duplicate_seat')};
    }
    let result;
    try {
      result = await service.authenticateAccount(client.name, client.vpass || null);
    } catch (error) {
      // Never log the raw error: driver errors carry SQL parameters (2.11).
      api.log.warn({event: 'ladder_auth_failed', code: credentials.safeErrorCode(error), roomId: room.process_pid},
        'Ladder authentication failed unexpectedly.');
      return {error: fourLanguageMessage('ladder_auth_unavailable')};
    }
    if (!result.ok) return {error: fourLanguageMessage(authFailureMessages[result.reason] || 'ladder_auth_mismatch')};
    // Every accepted login now proves the password, so every TT account is
    // held to one live match.
    client.exclusive_account = true;
    // The seat binding (design 2.2). credentialVersion is the stored value,
    // never the plaintext. Not written to room state until the match starts,
    // so a waiting room that is cancelled leaves nothing behind.
    client.account_binding = {key: result.key, credentialVersion: result.credentialVersion};
    client.ladder_temporary_password = !!result.temporary;
    room.policy_overrides ||= {};
    // Checked by the host synchronously just before the seat is taken.
    room.policy_overrides.exclusiveSeats = {
      duplicateError: fourLanguageMessage('ladder_duplicate_seat'),
      inMatchError: fourLanguageMessage('ladder_account_in_match')
    };
    room.policy_overrides.hideNamesBeforeStart = !!api.config.hideNamesBeforeStart;
    room.policy_overrides.allowEarlySurrender = !!api.config.allowEarlySurrender;
    room.policy_overrides.opponentLeaveTipSuffix = '${ladder_opponent_leave_tip_suffix}';
    // Only TT opts into concurrent reconnect windows. Other room types retain
    // the host's legacy behavior when more than one player disconnects.
    room.policy_overrides.allowConcurrentReconnects = true;
    room.policy_overrides.neutralOnAllReconnectTimeout = true;
    return null;
  });
  api.hook('room_started', (room, playingPlayers) => {
    if (room?.random_type !== api.config.mode) return;
    const seats = service.registerSeats(room.process_pid, playingPlayers || room.dueling_players || []);
    if (seats.some(seat => !seat.key)) {
      api.log.warn({event: 'ladder_seat_unbound', roomId: room.process_pid}, 'A TT seat started without a verified account; it will not be settled.');
    }
  });
  // Fail-closed reconnect checks; the host refuses on throw or missing result.
  api.hook('reconnect_authorize', async client => {
    const result = await service.authorizeReconnect(client?.name, client?.vpass || null);
    if (!result) return null;
    if (result.error) return {error: fourLanguageMessage('ladder_auth_mismatch')};
    return {grant: result.grant};
  });
  api.hook('reconnect_commit', async (client, room, target, grant) => {
    if (room?.random_type !== api.config.mode) return null;
    return await service.confirmReconnect(grant, target) ? {ok: true} : {error: fourLanguageMessage('ladder_reconnect_credentials_changed')};
  });
  const sendMonthlyProfile = async (client, room) => {
    if (room?.random_type !== api.config.mode) return;
    const profile = await service.getMonthlyProfile(client.name);
    const total = profile.wins + profile.losses;
    const winRate = total ? ((profile.wins / total) * 100).toFixed(2) : '0.00';
    const message = client.name + '${ladder_profile_points}' + profile.points + '${ladder_profile_wins}' +
      profile.wins + '${ladder_profile_diff}' + (profile.wins - profile.losses) + '${ladder_profile_rate}' + winRate + '%' +
      (profile.currentWinStreak > 0 ? '${ladder_profile_streak_prefix}' + profile.currentWinStreak + '${ladder_profile_streak_suffix}' :
        '${ladder_profile_no_streak}');
    global.ygopro.stoc_send_chat(client, message, global.ygopro.constants.COLORS.PINK);
  };
  const sendLanguageSwitchTip = (client, room) => {
    if (room?.random_type !== api.config.mode) return;
    global.ygopro.stoc_send_chat(client, '${ladder_language_switch_tip}', global.ygopro.constants.COLORS.BABYBLUE);
  };
  const sendTemporaryPasswordTip = (client, room) => {
    if (room?.random_type !== api.config.mode || !client.ladder_temporary_password) return;
    global.ygopro.stoc_send_chat(client, fourLanguageMessage('ladder_temporary_password_tip'), global.ygopro.constants.COLORS.RED);
  };
  api.hook('client_joined_game', sendMonthlyProfile);
  api.hook('client_joined_game', sendLanguageSwitchTip);
  api.hook('client_joined_game', sendTemporaryPasswordTip);
  api.hook('client_language_changed', sendMonthlyProfile);
  api.hook('duel_result', event => service.captureGame(event));
  api.hook('rps_winner', event => service.captureRpsWinner(event));
  api.hook('duel_log_saved', event => service.linkDuelLog(event));
  api.hook('room_deleted', (room, scores, outcome) => service.finishRoom(room, scores, outcome));
  if (!api.settings.modules.reconnect?.enabled) {
    api.log.warn('Ladder plugin: reconnect is disabled in the host configuration; TT cannot provide disconnect recovery.');
  }
  // Last, after every hook is registered: refuse a return to legacy mode if
  // the table already holds hashes (design 6.2).
  try {
    await service.checkStoredHashes();
    const {mode} = await service.readSecurity();
    api.log.info({event: 'ladder_password_mode', mode}, 'Ladder password mode.');
  } catch (error) {
    api.log.warn({event: 'ladder_password_mode_check_failed', code: credentials.safeErrorCode(error)},
      'Could not check stored credentials at startup.');
  }
};

module.exports._test = {normalizeName, monthKey, calculateDelta, normalizeRating, createLiveRatingConfig, createLiveRatingFormula,
  checkRatingFormula, createService};
