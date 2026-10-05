/** Request-origin checks for local servers (SPEC §9.3). */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** The host part of a `Host` header or an `Origin` URL, lower-cased, without port or brackets. */
export function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  const raw = value.includes('://') ? value.slice(value.indexOf('://') + 3).split('/')[0]! : value;
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
  if (bracket) return bracket[1]!.toLowerCase();
  const plain = /^([^:]+)(?::\d+)?$/.exec(raw);
  return plain ? plain[1]!.toLowerCase() : null;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase().replace(/^\[|\]$/g, ''));
}

/**
 * Whether a request may be served. Loopback names are always allowed; a server listening on another
 * address also accepts that address and any `extra` names. Anything else, including a missing
 * `Host`, is refused: this stops a web page reaching a local service through DNS rebinding, where the
 * browser connects to 127.0.0.1 but sends the attacker's name as `Host`. A present `Origin` must name
 * an allowed host as well.
 */
export function requestAllowed(
  headers: { host?: string | undefined; origin?: string | undefined },
  listenHost: string,
  extra: readonly string[] = [],
): boolean {
  const allowed = new Set([...LOOPBACK, ...extra.map((h) => h.toLowerCase())]);
  if (!isLoopbackHost(listenHost)) allowed.add(listenHost.toLowerCase());
  const host = hostOf(headers.host);
  if (host === null || !allowed.has(host)) return false;
  if (headers.origin === undefined) return true;
  // `Origin: null` comes from sandboxed frames and file:// pages: not a trusted origin.
  const origin = hostOf(headers.origin);
  return origin !== null && allowed.has(origin);
}
