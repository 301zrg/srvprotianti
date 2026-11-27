'use strict';

// Ladder credential primitives shared by the plugin runtime and the offline
// scripts (bulk conversion, admin reset). Nothing here touches the database.
//
// Stored `ladder_user.pass` values come in two shapes:
//   * a scrypt hash: scrypt$N$r$p$<salt b64>$<key b64>   (temporary: scrypt-temp$...)
//   * anything else: a legacy plaintext password
// Only a value that matches the strict grammar AND has parameters inside the
// accepted bounds is a hash. A legacy password that merely starts with
// "scrypt" therefore stays plaintext and is still converted.

const crypto = require('crypto');
const {promisify} = require('util');

const scryptAsync = promisify(crypto.scrypt);

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const DEFAULT_PARAMS = Object.freeze({N: 1 << 14, r: 8, p: 1});
const LIMITS = Object.freeze({maxN: 1 << 16, maxR: 16, maxP: 4});
const HASH_PATTERN = /^scrypt(-temp)?\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=)$/;
// Anything that looks like it was meant to be one of our hashes. Used only by
// scripts to report damaged rows instead of silently treating them as plaintext.
const HASH_LIKE_PATTERN = /^scrypt(-temp)?\$/;

// Characters that cannot appear in a password typed as `name$password`.
const FORBIDDEN_PASSWORD_CHARS = /[$＄﹩\0\r\n\\]/;
// Full-width and small dollar signs that some mobile keyboards produce instead
// of the ASCII separator. New accounts may not contain them (design 6.3, plan C).
const LOOKALIKE_DOLLARS = /[＄﹩]/;
const MAX_LOGIN_LENGTH = 19;

const isPowerOfTwo = value => value > 1 && (value & (value - 1)) === 0;

function paramsAllowed({N, r, p}) {
  return Number.isSafeInteger(N) && isPowerOfTwo(N) && N <= LIMITS.maxN &&
    Number.isSafeInteger(r) && r >= 1 && r <= LIMITS.maxR &&
    Number.isSafeInteger(p) && p >= 1 && p <= LIMITS.maxP;
}

// Returns null for any value that is not a well-formed, in-bounds hash.
function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const match = HASH_PATTERN.exec(stored);
  if (!match) return null;
  const params = {N: Number(match[2]), r: Number(match[3]), p: Number(match[4])};
  if (!paramsAllowed(params)) return null;
  const salt = Buffer.from(match[5], 'base64');
  const key = Buffer.from(match[6], 'base64');
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES) return null;
  return {temporary: !!match[1], ...params, salt, key};
}

// 'empty' | 'hash' | 'temp' | 'legacy' | 'damaged'
// 'damaged' means the prefix claims to be a hash but the value is not one.
// Runtime treats damaged like legacy (it can only ever match the identical
// string); scripts must report it and refuse to skip it silently.
function classifyStored(stored) {
  if (stored == null || stored === '') return 'empty';
  const parsed = parseHash(stored);
  if (parsed) return parsed.temporary ? 'temp' : 'hash';
  return HASH_LIKE_PATTERN.test(String(stored)) ? 'damaged' : 'legacy';
}

const isLegacyPlaintext = stored => ['legacy', 'damaged'].includes(classifyStored(stored));

function scryptMaxmem({N, r}) {
  // Node rejects the call unless maxmem exceeds 128*N*r; leave headroom.
  return 128 * N * r * 2 + 1024 * 1024;
}

async function derive(password, salt, params) {
  return scryptAsync(Buffer.from(String(password), 'utf8'), salt, KEY_BYTES,
    {N: params.N, r: params.r, p: params.p, maxmem: scryptMaxmem(params)});
}

async function hashPassword(password, {temporary = false, params = DEFAULT_PARAMS} = {}) {
  if (typeof password !== 'string' || !password) throw new TypeError('password must be a non-empty string.');
  if (!paramsAllowed(params)) throw new RangeError('scrypt parameters are outside the accepted bounds.');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `${temporary ? 'scrypt-temp' : 'scrypt'}$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Fixed-length comparison so legacy plaintext checks do not leak the length or
// common prefix of the stored password through timing.
function constantTimeStringEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(left, right) && String(a) === String(b);
}

// Does `stored` need an scrypt computation to check `password`?
const needsScrypt = stored => !!parseHash(stored);

// {ok, kind} where kind is classifyStored(stored). Never rewrites anything:
// upgrading a legacy row on login is intentionally not done (design 2.1/2.8).
async function verifyPassword(stored, password) {
  const kind = classifyStored(stored);
  if (kind === 'empty' || typeof password !== 'string' || !password) return {ok: false, kind};
  if (kind === 'hash' || kind === 'temp') {
    const parsed = parseHash(stored);
    const candidate = await derive(password, parsed.salt, parsed);
    return {ok: crypto.timingSafeEqual(candidate, parsed.key), kind};
  }
  return {ok: constantTimeStringEqual(stored, password), kind};
}

const utf16Length = value => String(value).length;

// Rules for a password a player chooses (self-service change). Returns an
// error code or null.
function validateNewPassword(displayName, password) {
  if (typeof password !== 'string' || !password) return 'password_empty';
  if (FORBIDDEN_PASSWORD_CHARS.test(password)) return 'password_invalid_chars';
  if (utf16Length(String(displayName).trim()) + 1 + utf16Length(password) > MAX_LOGIN_LENGTH) return 'password_too_long';
  return null;
}

const containsLookalikeDollar = value => LOOKALIKE_DOLLARS.test(String(value || ''));

// Lowercase letters and digits without easily confused glyphs (0/o, 1/l/i).
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

// Temporary passwords must fit the 19-code-unit login field together with the
// nickname and separator: min(8, 19 - len(name) - 1), at least 3. A shorter
// explicit length is allowed for very long nicknames (the caller warns).
function temporaryPasswordLength(displayName, explicit = null) {
  const room = MAX_LOGIN_LENGTH - utf16Length(String(displayName).trim()) - 1;
  if (explicit != null) {
    if (!Number.isSafeInteger(explicit) || explicit < 1) throw new RangeError('length must be a positive integer.');
    if (explicit > room) throw new RangeError(`length ${explicit} does not fit: at most ${Math.max(room, 0)} characters are available.`);
    return explicit;
  }
  const length = Math.min(8, room);
  if (length < 3) throw new RangeError(`nickname leaves room for ${Math.max(room, 0)} characters; pass an explicit length.`);
  return length;
}

function generateTemporaryPassword(length) {
  let output = '';
  while (output.length < length) {
    output += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
  }
  return output;
}

module.exports = {
  DEFAULT_PARAMS, LIMITS, KEY_BYTES, SALT_BYTES, MAX_LOGIN_LENGTH,
  parseHash, classifyStored, isLegacyPlaintext, needsScrypt, hashPassword, verifyPassword,
  constantTimeStringEqual, validateNewPassword, containsLookalikeDollar,
  temporaryPasswordLength, generateTemporaryPassword, paramsAllowed
};
