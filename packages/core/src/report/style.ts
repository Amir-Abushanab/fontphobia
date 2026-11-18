// Text styling hooks for the human-readable reports. The default is plain text (reports written
// to files, tests, integrations); the CLI passes ANSI colors when it writes to a terminal.

export interface Style {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
}

const same = (s: string) => s;

export const plainStyle: Style = {
  bold: same,
  dim: same,
  red: same,
  green: same,
  yellow: same,
  cyan: same,
  magenta: same,
};

/** "78%": the share saved going from `before` to `after` bytes (negative when it grew). */
export const savedPct = (before: number, after: number) =>
  before ? `${Math.round((1 - after / before) * 100)}%` : '0%';
