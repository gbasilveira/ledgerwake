import { parseArgs } from 'node:util';
import { events, forward, hooks, reconcile, sessions } from './commands/capture.js';
import { item, project, serve } from './commands/observe.js';
import { check, reindex } from './commands/project.js';
import { type Io, message, UsageError, type Values } from './io.js';

export type { Io } from './io.js';
export { formatDiagnostic } from './commands/project.js';

export const USAGE = `Usage: lw <command> [arguments] [options]

Project documents:
  reindex [dir]          Rebuild the index of a project from its files
  check [dir]            Check the project's documents; exit 1 on errors
    --config <file>      Project configuration (default: <dir>/.ledgerwake/project.yaml)
    --out <dir>          Where reindex writes (default: <dir>/.ledgerwake/data)

Projects observed by this installation:
  project add <root>     Register a project (its .ledgerwake/project.yaml, or --config)
    --worktrees <dir>    A directory holding the project's worktrees (repeatable)
  project list           List registered projects

Capture (Claude Code):
  hooks print            Print the hook settings that install the capture hook
  hooks install          Install the hook script and merge its settings into a file
    --settings <file>    Claude Code settings file to update (required)
    --hook <command>     Use this hook command instead of installing the script
  forward                Move spooled hook events into the local store
    --watch              Keep running; --interval <ms> between passes (default 1000)
  reconcile              Import transcripts (backfill, gap filling) and the commits
                         of registered projects
    --projects <dir>     Transcript directory (default: ~/.claude/projects)
  sessions               List captured sessions
  events <session>       Show the events of a session

Read:
  item <project>/<key>   An item with its linked sessions and commits
  serve                  Read-only local API (--port, default 8754; --host, default 127.0.0.1)

Common options:
  --home <dir>           Local installation (default: $LW_HOME or ~/.ledgerwake)
  --json                 Print JSON
  -h, --help             Show this help`;

type Command = (args: string[], values: Values, io: Io) => number | Promise<number>;

const COMMANDS: Record<string, Command> = {
  reindex,
  check,
  project,
  hooks,
  forward,
  reconcile,
  sessions,
  events,
  item,
  serve,
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
