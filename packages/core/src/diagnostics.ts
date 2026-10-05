export type DiagnosticLevel = 'error' | 'warning';

export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  path: string;
  line?: number;
  message: string;
}

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    cmp(a.path, b.path) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    cmp(a.code, b.code) ||
    cmp(a.message, b.message)
  );
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
