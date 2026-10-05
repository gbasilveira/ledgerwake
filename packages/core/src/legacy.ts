/**
 * Legacy adapter, format 0 (SPEC §4.1): reads the work-order conventions pinned by VERA's
 * docs/FORMAT-CONTRACT.md, in memory and without migration. Pure functions over text.
 */

export const LEGACY_STATES = [
  'DRAFT',
  'READY',
  'IN PROGRESS',
  'IN REVIEW',
  'ACCEPTED',
  'CHANGES REQUESTED',
  'DONE',
  'PARTIAL',
  'BLOCKED',
] as const;

export const LEGACY_LOG_TYPES = [
  'LAUNCH',
  'RESULT',
  'REVIEW',
  'MERGE',
  'DECISION',
  'WATCHDOG',
  'RELAUNCH',
  'USER',
  'NOTE',
] as const;

export const HEADER_KEYS = ['Fase', 'Estado', 'Depende de', 'Branch'] as const;

export interface LegacyProblem {
  level: 'error' | 'warning';
  code: string;
  line?: number;
  message: string;
}

const NUMBER = '[0-9]{3}[a-z]?';
const QUEUE_ROW = new RegExp(`^\\| +(${NUMBER}) +\\|`);
const FILE_NAME = new RegExp(`^WO-(${NUMBER})-([a-z0-9-]+)\\.md$`);
const WO_REF = new RegExp(`\\bWO-(${NUMBER})\\b`, 'g');
const LOG_LINE = new RegExp(
  `^- ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2})Z · \\*\\*(${LEGACY_LOG_TYPES.join('|')})\\*\\* · (.*)$`,
);

/** `WO-` followed by the number, for example `008b` → `WO-008b`. */
export function workOrderKey(number: string): string {
  return `WO-${number}`;
}

/** Leading state of a value such as `ACCEPTED (com desvios: ver RESULT)`, or null. */
export function leadingState(value: string): string | null {
  for (const state of [...LEGACY_STATES].sort((a, b) => b.length - a.length)) {
    if (value === state || value.startsWith(`${state} `)) return state;
  }
  return null;
}

function cells(row: string): string[] {
  const parts = row.split('|');
  return parts.slice(1, -1).map((cell) => cell.trim());
}

// ---------------------------------------------------------------------------- queue

export interface QueueRow {
  number: string;
  key: string;
  title: string;
  phase: string;
  state: string;
  agent: string;
  dependsOn: string[];
  line: number;
}

/** Queue rows `| NNN | title | phase | STATE | agent | depends |` anywhere in the orchestration document. */
export function parseQueue(text: string): { rows: QueueRow[]; problems: LegacyProblem[] } {
  const rows: QueueRow[] = [];
  const problems: LegacyProblem[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((content, i) => {
    const match = QUEUE_ROW.exec(content);
    if (!match) return;
    const line = i + 1;
    const number = match[1]!;
    const columns = cells(content);
    if (columns.length !== 6) {
      problems.push({
        level: 'error',
        code: 'queue-columns',
        line,
        message: `queue row ${number} has ${columns.length} columns (expected 6)`,
      });
    }
    if (seen.has(number)) {
      problems.push({
        level: 'error',
        code: 'queue-duplicate',
        line,
        message: `queue row ${number} appears more than once; the first is used`,
      });
      return;
    }
    seen.add(number);
    const [, title = '', phase = '', state = '', agent = '', depends = ''] = columns;
    if (!(LEGACY_STATES as readonly string[]).includes(state)) {
      problems.push({
        level: 'error',
        code: 'queue-state',
        line,
        message: `queue row ${number} has unknown state '${state}'`,
      });
    }
    const dependsOn: string[] = [];
    for (const token of depends.split(',').map((t) => t.trim())) {
      if (token === '' || token === '—' || token === '-') continue;
      if (new RegExp(`^${NUMBER}$`).test(token)) dependsOn.push(workOrderKey(token));
      else
        problems.push({
          level: 'warning',
          code: 'queue-depends',
          line,
          message: `queue row ${number}: dependency '${token}' is not a work-order number`,
        });
    }
    rows.push({ number, key: workOrderKey(number), title, phase, state, agent, dependsOn, line });
  });
  return { rows, problems };
}

// ---------------------------------------------------------------------- work orders

export interface WorkOrderFile {
  number: string;
  key: string;
  slug: string;
  /** Text of the first `# ` heading after the em dash, if any. */
  heading: string | null;
  header: Partial<Record<(typeof HEADER_KEYS)[number], { value: string; line: number }>>;
  headerState: string | null;
  branch: string | null;
  tasks: { total: number; done: number };
}

/** Parses the file name; null if it does not follow `WO-NNN[a-z]-<slug>.md`. */
export function parseWorkOrderName(name: string): { number: string; slug: string } | null {
  const match = FILE_NAME.exec(name);
  return match ? { number: match[1]!, slug: match[2]! } : null;
}

export function parseWorkOrder(
  name: string,
  text: string,
): { workOrder: WorkOrderFile | null; problems: LegacyProblem[] } {
  const problems: LegacyProblem[] = [];
  const parsedName = parseWorkOrderName(name);
  if (!parsedName) {
    problems.push({
      level: 'error',
      code: 'file-name',
      message: `${name}: file name does not match WO-NNN[a-z]-<slug>.md`,
    });
    return { workOrder: null, problems };
  }
  const header: WorkOrderFile['header'] = {};
  let heading: string | null = null;
  let total = 0;
  let done = 0;
  text.split(/\r?\n/).forEach((content, i) => {
    if (heading === null && content.startsWith('# ')) {
      const dash = content.indexOf(' — ');
      heading = (dash >= 0 ? content.slice(dash + 3) : content.slice(2)).trim();
    }
    for (const key of HEADER_KEYS) {
      if (header[key]) continue;
      const match = new RegExp(`^\\| *${key} *\\|(.*)\\|`).exec(content);
      if (match) header[key] = { value: match[1]!.split('|')[0]!.trim(), line: i + 1 };
    }
    const task = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/.exec(content);
    if (task) {
      total++;
      if (task[1] === 'x') done++;
    }
  });
  for (const key of HEADER_KEYS) {
    if (!header[key])
      problems.push({
        level: 'error',
        code: 'header-row',
        message: `${name}: header row '${key}' missing`,
      });
  }
  const estado = header.Estado;
  const headerState = estado ? leadingState(estado.value) : null;
  if (estado && !headerState) {
    problems.push({
      level: 'error',
      code: 'header-state',
      line: estado.line,
      message: `${name}: Estado '${estado.value}' does not start with a known state`,
    });
  }
  const branchValue = header.Branch?.value.replace(/`/g, '').trim();
  return {
    workOrder: {
      number: parsedName.number,
      key: workOrderKey(parsedName.number),
      slug: parsedName.slug,
      heading,
      header,
      headerState,
      branch: branchValue && branchValue !== '—' ? branchValue : null,
      tasks: { total, done },
    },
    problems,
  };
}

// ------------------------------------------------------------------------------ log

export interface LogEntry {
  line: number;
  /** ISO 8601 with seconds and milliseconds, for example `2026-10-04T08:58:00.000Z`. */
  ts: string;
  type: string;
  text: string;
  /** Work-order keys mentioned as `WO-NNN[a-z]`, in order of first mention. */
  items: string[];
  raw: string;
}

/** Log lines `- <YYYY-MM-DDTHH:MMZ> · **<TYPE>** · <text>`. Blank lines and headings are skipped. */
export function parseLog(text: string): { entries: LogEntry[]; problems: LegacyProblem[] } {
  const entries: LogEntry[] = [];
  const problems: LegacyProblem[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (raw === '' || raw.startsWith('#')) return;
    const match = LOG_LINE.exec(raw);
    if (!match) {
      problems.push({
        level: 'error',
        code: 'log-line',
        line,
        message: 'line does not match the log format',
      });
      return;
    }
    const body = match[3]!;
    const items = [...new Set([...body.matchAll(WO_REF)].map((m) => workOrderKey(m[1]!)))];
    entries.push({ line, ts: `${match[1]}:00.000Z`, type: match[2]!, text: body, items, raw });
  });
  return { entries, problems };
}
