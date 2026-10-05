import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createToken,
  loadTokens,
  PostgresBackend,
  readTokenFile,
  revokeToken,
  ShipError,
  shipEvents,
  startCentral,
} from '@ledgerwake/central';
import { isLoopbackHost, loadRedactor, stableStringify, systemClock } from '@ledgerwake/core';
import { Store } from '@ledgerwake/store';
import { homeDir, type Io, message, paths, UsageError, type Values } from '../io.js';

const SCOPES = ['ingest', 'read'] as const;

/**
 * A reason not to use this database URL, or null. A database on another host must be reached over
 * TLS: its password and every event would otherwise cross the network in clear.
 */
export function databaseUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'LW_DATABASE_URL is not a valid URL (postgres://user:password@host:5432/database)';
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    return 'LW_DATABASE_URL must start with postgres://';
  if (isLoopbackHost(url.hostname) || url.hostname === '') return null;
  return ['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')
    ? null
    : `${url.hostname} is not this machine: add ?sslmode=verify-full (or require) to LW_DATABASE_URL so the password and the data are encrypted`;
}

/** `lw central token new|list|revoke` and `lw central serve`. */
export async function central(args: string[], values: Values, io: Io): Promise<number> {
  const [action, sub, arg] = args;
  const home = homeDir(values, io);
  if (action === 'token') {
    if (sub === 'new') {
      const name = typeof values.name === 'string' ? values.name : '';
      const team = typeof values.team === 'string' ? values.team : '';
      const scopes = (typeof values.scope === 'string' ? values.scope : 'ingest')
        .split(',')
        .map((s) => s.trim());
      if (!name || !team || !scopes.every((s) => (SCOPES as readonly string[]).includes(s)))
        throw new UsageError(
          'Usage: lw central token new --name <machine> --team <team> [--scope ingest,read]',
        );
      let created;
      try {
        created = createToken(home, {
          name,
          team,
          scopes: scopes as ('ingest' | 'read')[],
          clock: io.clock ?? systemClock,
        });
      } catch (error) {
        throw new UsageError(`Cannot create the token: ${message(error)}`);
      }
      io.out(`created token ${created.record.id} for ${name} (team ${team}, ${scopes.join(', ')})`);
      io.out('Shown once; only its hash is kept. Save it to a file readable only by you:');
      io.out(created.token);
      return 0;
    }
    if (sub === 'list') {
      const tokens = loadTokens(home).map(({ sha256: _hash, ...rest }) => rest);
      if (values.json) io.out(stableStringify(tokens));
      else
        for (const t of tokens)
          io.out(
            `${t.id}  ${t.name}  team=${t.team}  ${t.scopes.join(',')}  created ${t.created}${t.revoked ? `  REVOKED ${t.revoked}` : ''}`,
          );
      return 0;
    }
    if (sub === 'revoke') {
      if (!arg) throw new UsageError('Usage: lw central token revoke <id|name>');
      const revoked = revokeToken(home, arg, io.clock ?? systemClock);
      if (!revoked) {
        io.err(`${arg}: no active token with that id or name`);
        return 1;
      }
      io.out(`revoked ${revoked.id} (${revoked.name})`);
      return 0;
    }
    throw new UsageError('Usage: lw central token new|list|revoke');
  }
  if (action === 'serve') {
    const port = Number(values.port ?? 8760);
    const host = typeof values.host === 'string' ? values.host : '127.0.0.1';
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new UsageError('--port must be 0–65535');
    const certFile = typeof values['tls-cert'] === 'string' ? values['tls-cert'] : undefined;
    const keyFile = typeof values['tls-key'] === 'string' ? values['tls-key'] : undefined;
    if (Boolean(certFile) !== Boolean(keyFile))
      throw new UsageError('--tls-cert and --tls-key go together');
    const storage = typeof values.storage === 'string' ? values.storage : 'sqlite';
    if (storage !== 'sqlite' && storage !== 'postgres')
      throw new UsageError('--storage is sqlite (default) or postgres');
    let backend: PostgresBackend | undefined;
    if (storage === 'postgres') {
      // The connection string carries a password: it comes from the environment, never an argument.
      const databaseUrl = io.env.LW_DATABASE_URL ?? '';
      if (!databaseUrl)
        throw new UsageError(
          '--storage postgres needs the LW_DATABASE_URL environment variable (postgres://user:password@host:5432/database)',
        );
      const problem = databaseUrlProblem(databaseUrl);
      if (problem) throw new UsageError(problem);
      backend = new PostgresBackend({
        connectionString: databaseUrl,
        redactor: loadRedactor(home),
      });
    }
    let server;
    try {
      server = await startCentral({
        home,
        ...(backend ? { backend } : {}),
        clock: io.clock ?? systemClock,
        host,
        port,
        ...(certFile && keyFile
          ? {
              tls: {
                cert: readFileSync(resolve(certFile), 'utf8'),
                key: readFileSync(resolve(keyFile), 'utf8'),
              },
            }
          : {}),
        ...(values['behind-tls-proxy'] === true ? { behindTlsProxy: true } : {}),
      });
    } catch (error) {
      throw new UsageError(message(error));
    }
    const address = server.server.address();
    const actual = typeof address === 'object' && address ? address.port : port;
    io.out(
      `central server on ${certFile ? 'https' : 'http'}://${host}:${actual} (${backend ? 'teams in PostgreSQL' : `teams under ${resolve(home, 'central')}`})`,
    );
    if (loadTokens(home).filter((t) => !t.revoked).length === 0)
      io.err('no tokens yet: create one with lw central token new');
    while (io.sleep && (await io.sleep(60_000)));
    await server.close();
    return 0;
  }
  throw new UsageError('Usage: lw central serve|token');
}

/** `lw ship --url <central> --token-file <file>`: send metadata of local events to a central server. */
export async function ship(_args: string[], values: Values, io: Io): Promise<number> {
  const url = typeof values.url === 'string' ? values.url : '';
  if (!url)
    throw new UsageError(
      'Usage: lw ship --url <https://central> --token-file <file> [--ca-file <pem>] [--watch]',
    );
  const home = homeDir(values, io);
  let token: string;
  try {
    token =
      typeof values['token-file'] === 'string'
        ? readTokenFile(resolve(values['token-file']))
        : (io.env.LW_TOKEN ?? '');
  } catch (error) {
    throw new UsageError(message(error));
  }
  if (!token)
    throw new UsageError(
      'Give the token with --token-file <file> (mode 600) or the LW_TOKEN environment variable',
    );
  const ca =
    typeof values['ca-file'] === 'string'
      ? readFileSync(resolve(values['ca-file']), 'utf8')
      : undefined;
  const interval = Number(values.interval ?? 5000);
  if (!Number.isFinite(interval) || interval <= 0)
    throw new UsageError('--interval must be a positive number');
  const store = Store.open(paths(home).store, { redactor: loadRedactor(home) });
  try {
    for (;;) {
      try {
        const r = await shipEvents(store, { url, token, ...(ca ? { ca } : {}) });
        if (values.json) io.out(stableStringify(r, 0));
        else if (!values.watch || r.batches > 0)
          io.out(
            `shipped ${r.shipped} event(s) in ${r.batches} batch(es), ${r.duplicates} already there`,
          );
      } catch (error) {
        if (!(error instanceof ShipError)) throw error;
        io.err(error.message);
        if (!values.watch || !error.retryable) return error.retryable ? 1 : 2;
      }
      if (!values.watch || !io.sleep || !(await io.sleep(interval))) return 0;
    }
  } finally {
    store.close();
  }
}
