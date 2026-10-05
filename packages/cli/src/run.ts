import { parseArgs } from 'node:util';
import { events, forward, hooks, receive, reconcile, sessions } from './commands/capture.js';
import { central, ship } from './commands/central.js';
import { status } from './commands/status.js';
import { alertsCommand, autonomy, item, project, prune, serve } from './commands/observe.js';
import { check, reindex } from './commands/project.js';
import { newItem, type } from './commands/types.js';
import { type Io, message, UsageError, type Values } from './io.js';

export type { Io } from './io.js';
export { formatDiagnostic } from './commands/project.js';

export const USAGE = `Usage: lw <command> [arguments] [options]

Project documents:
  reindex [dir]          Rebuild the index of a project from its files
  check [dir]            Check the project's documents; exit 1 on errors
    --config <file>      Project configuration (default: <dir>/.ledgerwake/project.yaml)
    --out <dir>          Where reindex writes (default: <dir>/.ledgerwake/data)
    --history            check: also read status changes from git and flag moves that no
                         declared transition path allows (reopened or regressed items)

Process types and native documents:
  type list [dir]        Process types in force (built-in and the project's own)
  type new <name> [dir]  Create a type document: --states A,B,C --prefix KEY- [--title]
  new <type> <title> [dir]  Create a document with a new ULID and the next key
                         [--depends KEY,…]; native projects only

Projects observed by this installation:
  project add <root>     Register a project (its .ledgerwake/project.yaml, or --config)
    --worktrees <dir>    A directory holding the project's worktrees (repeatable)
  project list           List registered projects

Health and retention:
  status                 Is this installation working and safe? Exit 1 if something needs attention

  prune                  Delete stored full content older than --content-older-than <N>h|d|w
                         (reports only unless --yes; events and cost are kept)

Capture (Claude Code):
  hooks print            Print the hook settings that install the capture hook
  hooks install          Install the hook script and merge its settings into a file
    --settings <file>    Claude Code settings file to update (required)
    --hook <command>     Use this hook command instead of installing the script
  receive                Local OTLP/JSON receiver for cost and usage (--port, default 4318)
  forward                Move spooled hook and telemetry events into the local store
    --watch              Keep running; --interval <ms> between passes (default 1000)
  reconcile              Import transcripts (backfill, gap filling) and the commits
                         of registered projects
    --projects <dir>     Transcript directory (default: ~/.claude/projects)
  sessions               List captured sessions
  events <session>       Show the events of a session

Read:
  item <project>/<key>   An item with its linked sessions and commits
  alerts                 Evaluate alert rules ($LW_HOME/alerts.yaml); exit 1 if any
  autonomy <project>     Evidence for an autonomy evaluation (it does not decide)
  serve                  Read-only local API (--port, default 8754; --host, default 127.0.0.1)

Several machines (metadata only; see docs/SECURITY.md):
  central token new      Create a token: --name <machine> --team <team> [--scope ingest,read]
  central token list|revoke <id|name>
  central serve          Central server; off loopback it needs --tls-cert and --tls-key
                         (or --behind-tls-proxy); teams are isolated, one store each.
                         --storage postgres keeps them in PostgreSQL (env LW_DATABASE_URL)
  ship                   Send local events' metadata to a central server:
                         --url <https://…> --token-file <file> [--ca-file <pem>] [--watch]

Common options:
  --home <dir>           Local installation (default: $LW_HOME or ~/.ledgerwake)
  --allow-remote         Allow --host beyond loopback (the servers have no authentication)
  --json                 Print JSON
  -h, --help             Show this help`;

type Command = (args: string[], values: Values, io: Io) => number | Promise<number>;

const COMMANDS: Record<string, Command> = {
  reindex,
  check,
  project,
  hooks,
  forward,
  receive,
  reconcile,
  sessions,
  events,
  item,
  serve,
  type,
  new: newItem,
  alerts: alertsCommand,
  autonomy,
  central,
  ship,
  status,
  prune,
};

/** Runs the CLI. Exit codes: 0 success, 1 check found errors (or no events), 2 usage or configuration error. */
export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        out: { type: 'string' },
        home: { type: 'string' },
        settings: { type: 'string' },
        hook: { type: 'string' },
        projects: { type: 'string' },
        interval: { type: 'string' },
        worktrees: { type: 'string', multiple: true },
        port: { type: 'string' },
        host: { type: 'string' },
        'allow-remote': { type: 'boolean', default: false },
        storage: { type: 'string' },
        history: { type: 'boolean', default: false },
        'content-older-than': { type: 'string' },
        yes: { type: 'boolean', default: false },
        name: { type: 'string' },
        team: { type: 'string' },
        scope: { type: 'string' },
        url: { type: 'string' },
        'token-file': { type: 'string' },
        'ca-file': { type: 'string' },
        'tls-cert': { type: 'string' },
        'tls-key': { type: 'string' },
        'behind-tls-proxy': { type: 'boolean', default: false },
        states: { type: 'string' },
        prefix: { type: 'string' },
        title: { type: 'string' },
        depends: { type: 'string' },
        watch: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    io.err(message(error));
    io.err(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [name, ...args] = positionals;
  if (values.help || name === undefined) {
    (values.help ? io.out : io.err)(USAGE);
    return values.help ? 0 : 2;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.err(`Unknown command: ${name}`);
    io.err(USAGE);
    return 2;
  }
  try {
    return await command(args, values, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
