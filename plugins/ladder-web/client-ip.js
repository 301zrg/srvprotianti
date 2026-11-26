'use strict';

// Client address for per-IP limits on credential endpoints. Proxy headers are
// honoured only when the TCP peer itself is a trusted reverse proxy
// (modules.trusted_proxies, checked by the host's global.isTrustedProxy). The
// new Nginx template replaces X-Forwarded-For with $remote_addr, so its first
// entry is then the real client.
function clientIpOf(request, isTrustedProxy = global.isTrustedProxy) {
  const physical = String(request?.socket?.remoteAddress || request?.connection?.remoteAddress || '');
  const forwarded = request?.headers?.['x-forwarded-for'];
  let trusted = false;
  try {
    trusted = !!physical && typeof isTrustedProxy === 'function' && !!isTrustedProxy(physical);
  } catch (error) {
    trusted = false;
  }
  if (trusted && typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return physical || 'unknown';
}

module.exports = {clientIpOf};
