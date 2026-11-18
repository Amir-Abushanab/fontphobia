// Terminal output for the CLI: colors, step headings, a live status line with a progress bar, and
// the interactive prompts. Everything degrades to plain lines when the output isn't a terminal
// (pipes, CI, --json), so logs and tests see the same text without escape codes.
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stripVTControlCharacters } from 'node:util';
import type { Style } from '@fontphobia/core';

const env = process.env;

/** NO_COLOR and FORCE_COLOR (https://no-color.org, https://force-color.org), then whether it's a terminal. */
export function colorEnabled(stream: { isTTY?: boolean }, flag?: boolean): boolean {
  if (flag === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  return !!stream.isTTY && env.TERM !== 'dumb';
}

/** Whether a question can be asked: both ends are a terminal and nothing says this is CI. */
const canPrompt = (ci?: boolean) =>
  !ci && !env.CI && !!process.stdin.isTTY && !!process.stderr.isTTY && env.TERM !== 'dumb';

const sgr = (open: number, close: number) => (s: string) => (s ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export function ansiStyle(on: boolean): Style {
  const id = (s: string) => s;
  return on
    ? {
        bold: sgr(1, 22),
        dim: sgr(2, 22),
        red: sgr(31, 39),
        green: sgr(32, 39),
        yellow: sgr(33, 39),
        cyan: sgr(36, 39),
        magenta: sgr(35, 39),
      }
    : { bold: id, dim: id, red: id, green: id, yellow: id, cyan: id, magenta: id };
}

/** Visible width, without escape codes. */
export const visible = (s: string) => stripVTControlCharacters(s).length;

/** `s` cut to `width` visible characters (escape codes kept, then reset). */
export function fit(s: string, width: number): string {
  if (visible(s) <= width) return s;
  let out = '';
  let n = 0;
  for (let i = 0; i < s.length && n < width - 1;) {
    // oxlint-disable-next-line no-control-regex -- an escape sequence is what this skips
    const m = s.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    out += ch;
    i += ch.length;
    n++;
  }
  return out + '…\x1b[0m';
}

/** A bar `width` cells wide, `done` of `total` filled. */
export function bar(done: number, total: number, width: number, s: Style): string {
  if (total <= 0) return s.dim('─'.repeat(width));
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return s.cyan('━'.repeat(filled)) + s.dim('─'.repeat(width - filled));
}

export const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

let cursorHidden = false;
// Ctrl+C while the status line is up: put the cursor back and exit like the default handler would
// (exit handlers, such as the one that stops the Linux browser container, still run).
const onSigint = () => {
  showCursor();
  process.stderr.write('\n');
  process.exit(130);
};
const hideCursor = () => {
  if (!cursorHidden) process.once('SIGINT', onSigint);
  cursorHidden = true;
  process.stderr.write('\x1b[?25l');
};
const showCursor = () => {
  if (cursorHidden) {
    process.stderr.write('\x1b[?25h');
    process.off('SIGINT', onSigint);
  }
  cursorHidden = false;
};

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** The wordmark: heavy "font" thinning to "bia", an eye in each o. 63 columns. */
const LOGO = [
  ' ▄█▀▀▀                  ▄▄          ██            █     ▀',
  '▀██▀▀▀ ▄█▀▀▀█▄ ██▄▀▀█▄ ▀██▀▀ ██▄▀▀▄ ██▄▀▀▄ ▄▀▀▀▀▄ █▄▀▀▄ █  ▀▀▀▄',
  ' ██    ██ █ ██ ██   ██  ██   ██   █ ██   █ █  █ █ █   █ █ ▄▀▀▀█',
  ' ██    ▀█▄▄▄█▀ ██   ██  ▀█▄▄ ██▀▄▄▀ ██   █ ▀▄▄▄▄▀ █▀▄▄▀ █ ▀▄▄▄█',
  '                             ██',
];

export interface UiOptions {
  /** --json: nothing on stderr but errors. */
  quiet?: boolean;
  /** --no-color. */
  color?: boolean;
  /** --ci. */
  ci?: boolean;
}

/**
 * Progress and log lines go to stderr; reports go to stdout. With a terminal on stderr a status
 * line with a spinner (and a bar, when the total is known) stays below the log lines.
 */
export class Ui {
  /** For reports on stdout. */
  readonly out: Style;
  /** For progress and logs on stderr. */
  readonly err: Style;
  readonly quiet: boolean;
  /** Questions can be asked. */
  readonly interactive: boolean;
  /** A status line can be drawn (stderr is a terminal, not CI, not quiet). */
  readonly live: boolean;
  private status = '';
  private timer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private shown = false;

  constructor(o: UiOptions = {}) {
    this.quiet = !!o.quiet;
    this.out = ansiStyle(colorEnabled(process.stdout, o.color));
    this.err = ansiStyle(colorEnabled(process.stderr, o.color));
    this.live = !this.quiet && !!process.stderr.isTTY && !env.CI && env.TERM !== 'dumb';
    this.interactive = !this.quiet && canPrompt(o.ci);
  }

  /**
   * The wordmark and version at the start of a run in a terminal; elsewhere (CI logs, pipes, a
   * narrow terminal) the version line alone.
   */
  banner(version: string, detail: string) {
    if (this.quiet) return;
    const s = this.err;
    const line = `${s.bold('fontphobia')} ${s.cyan(version)} ${s.dim(`· ${detail}`)}`;
    const wide = (process.stderr.columns || 80) > Math.max(...LOGO.map((l) => l.length)) + 2;
    this.write(this.live && wide ? `\n${LOGO.map((l) => `  ${l}`).join('\n')}\n  ${line}\n` : `${line}\n`);
  }

  /** A heading: `[1/4] Audit`, then what the step does, dimmed. */
  step(n: number, total: number, title: string, explain?: string) {
    if (this.quiet) return;
    const s = this.err;
    const head = total ? `${s.dim(`[${n}/${total}]`)} ${s.bold(title)}` : s.bold(title);
    const indent = total ? ' '.repeat(`[${n}/${total}] `.length) : '';
    this.write(`\n${head}\n${explain && this.live ? this.wrap(explain, indent, s.dim) + '\n' : ''}`);
  }

  /** A log line from the crawler or the planner. */
  log = (m: string) => {
    if (this.quiet) return;
    const s = this.err;
    const text = m.startsWith('warning: ')
      ? `  ${s.yellow('!')} ${s.yellow(m.replace(/^warning: /, ''))}`
      : /^config: |^serving |^server at |^starting: |^building: |^Chrome |^chromium |^using /.test(m)
        ? `  ${s.dim('·')} ${s.dim(m)}`
        : `  ${s.dim('·')} ${m}`;
    this.write(text + '\n');
  };

  /** A finished item: `✓ text`. */
  ok(m: string) {
    if (!this.quiet) this.write(this.wrap(m, '    ', (x) => x, `  ${this.err.green('✓')} `) + '\n');
  }

  warn(m: string) {
    if (!this.quiet) this.write(this.wrap(m, '    ', (x) => x, `  ${this.err.yellow('!')} `) + '\n');
  }

  /** Free text on stderr, wrapped and indented like the step explanations. */
  note(m: string, indent = '  ') {
    if (!this.quiet) this.write(this.wrap(m, indent, this.err.dim) + '\n');
  }

  /** Set the status line (spinner + text); '' hides it. */
  spin(text: string) {
    if (!this.live) return;
    this.status = text;
    if (!text) return this.stop();
    if (!this.timer) {
      hideCursor();
      this.timer = setInterval(() => this.draw(), 80);
      this.timer.unref();
    }
    this.draw();
  }

  /** The status line with a progress bar. */
  progress(label: string, done: number, total: number, item?: string) {
    if (!this.live) return;
    const s = this.err;
    const cols = process.stderr.columns || 80;
    const count = total > 0 ? `${done}/${total}` : `${done}`;
    const w = Math.max(10, Math.min(30, cols - label.length - count.length - 20));
    this.spin(`${label}  ${bar(done, total, w, s)}  ${count}${item ? `  ${s.dim(item)}` : ''}`);
  }

  /** Remove the status line. */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      showCursor();
    }
    this.status = '';
    this.clear();
  }

  /** Write to stdout, below anything on stderr (the status line is taken down first). */
  print(text: string) {
    this.stop();
    process.stdout.write(text);
  }

  /** `text` in lines that fit the terminal: the first after `first`, the others after `indent`. */
  private wrap(text: string, indent: string, paint: (s: string) => string, first = indent) {
    const cols = Math.min(100, ((process.stderr.isTTY && process.stderr.columns) || 101) - 1);
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/ +/)) {
      const lead = lines.length ? indent : first;
      if (line && visible(lead) + visible(line) + 1 + visible(word) > cols) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line || !lines.length) lines.push(line);
    return lines.map((l, i) => (i ? indent : first) + paint(l)).join('\n');
  }

  private write(text: string) {
    this.clear();
    process.stderr.write(text);
    if (this.status) this.draw();
  }

  private clear() {
    if (this.shown) {
      process.stderr.write('\r\x1b[2K');
      this.shown = false;
    }
  }

  private draw() {
    if (!this.status) return;
    const cols = process.stderr.columns || 80;
    const f = this.err.cyan(SPIN[this.frame++ % SPIN.length]!);
    process.stderr.write(`\r\x1b[2K${fit(`  ${f} ${this.status}`, cols - 1)}`);
    this.shown = true;
  }

  /** y/N (or Y/n with `yes`). Ctrl+C exits; end of input takes the default. */
  async confirm(q: string, yes = false): Promise<boolean> {
    this.stop();
    const s = this.err;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.on('SIGINT', () => {
      process.stderr.write('\n');
      process.exit(130);
    });
    try {
      const a = (await rl.question(`${s.cyan('?')} ${s.bold(q)} ${s.dim(yes ? '(Y/n)' : '(y/N)')} `)).trim();
      return a ? /^y/i.test(a) : yes;
    } catch {
      process.stderr.write('\n');
      return yes;
    } finally {
      rl.close();
    }
  }

  /**
   * Pick any of `choices` (↑/↓ or j/k to move, space to toggle, a for all, enter to confirm, esc for
   * none). Returns the picked values in the order given.
   */
  async multiselect<T>(
    q: string,
    choices: { value: T; label: string; hint?: string; detail?: string; picked?: boolean }[],
  ): Promise<T[]> {
    this.stop();
    const s = this.err;
    const stdin = process.stdin;
    const picked = choices.map((c) => !!c.picked);
    let at = 0;
    let drawn = 0;
    const render = (final?: boolean) => {
      const cols = process.stderr.columns || 80;
      if (drawn) process.stderr.write(`\x1b[${drawn}A\r\x1b[0J`);
      const L: string[] = [];
      if (final) {
        const names = choices.filter((_, i) => picked[i]).map((c) => c.label.trim());
        L.push(`${s.green('✓')} ${s.bold(q)} ${names.length ? s.cyan(names.join(', ')) : s.dim('none')}`);
      } else {
        L.push(`${s.cyan('?')} ${s.bold(q)}`);
        L.push(s.dim('  ↑/↓ move · space select · a all · enter confirm'));
        choices.forEach((c, i) => {
          const box = picked[i] ? s.green('◼') : s.dim('◻');
          const cursor = i === at ? s.cyan('❯') : ' ';
          const label = i === at ? s.bold(c.label) : c.label;
          L.push(fit(`${cursor} ${box} ${label}${c.hint ? `  ${s.dim(c.hint)}` : ''}`, cols - 1));
        });
        const d = choices[at]?.detail;
        if (d) L.push(...this.wrap(d, '    ', s.dim).split('\n'));
      }
      process.stderr.write(L.join('\n') + '\n');
      drawn = final ? 0 : L.length;
    };
    emitKeypressEvents(stdin);
    const raw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    hideCursor();
    render();
    try {
      return await new Promise<T[]>((done) => {
        const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } = {}) => {
          if (key.ctrl && key.name === 'c') {
            stdin.off('keypress', onKey);
            stdin.setRawMode(raw);
            showCursor();
            process.stderr.write('\n');
            process.exit(130);
          }
          if (key.name === 'up' || str === 'k') at = (at + choices.length - 1) % choices.length;
          else if (key.name === 'down' || str === 'j' || key.name === 'tab') at = (at + 1) % choices.length;
          else if (key.name === 'space') picked[at] = !picked[at];
          else if (str === 'a') picked.fill(!picked.every(Boolean));
          else if (key.name === 'escape') picked.fill(false);
          if (key.name === 'return' || key.name === 'enter' || key.name === 'escape') {
            stdin.off('keypress', onKey);
            render(true);
            done(choices.filter((_, i) => picked[i]).map((c) => c.value));
            return;
          }
          render();
        };
        stdin.on('keypress', onKey);
      });
    } finally {
      stdin.setRawMode(raw);
      stdin.pause();
      showCursor();
    }
  }
}

/** Restore the cursor if the process ends while the status line is up. */
process.once('exit', showCursor);

/**
 * Colors for the plain reports (audit, verify, check, auto): headings bold, failures red,
 * warnings yellow, savings and passes green. The text itself is unchanged.
 */
export function highlight(text: string, s: Style): string {
  const lines = text.split('\n');
  return lines
    .map((l, i) => {
      if (!l.trim()) return l;
      const next = lines[i + 1] ?? '';
      if (l.startsWith('Verify passed')) return s.bold(s.green(l));
      if (l.startsWith('Verify failed')) return s.bold(s.red(l));
      if (l.startsWith('fontphobia: subsets are up to date')) return s.green(l);
      if (l.startsWith('fontphobia: subsets are out of date')) return s.bold(s.red(l));
      // A heading: an unindented line with indented lines under it.
      if (!/^\s/.test(l) && /^ {2}\S/.test(next) && l.length < 90 && !/^\s*[-+]/.test(l)) return s.bold(l);
      return l
        .replace(/\b([1-9]\d* (?:regression\(s\)|failed to load|differ\b))/g, (m) => s.red(m))
        .replace(/^(\s*)(regression|failed)(:)/, (_, a: string, b: string, c: string) => a + s.red(s.bold(b)) + c)
        .replace(/^(\s*)(warning|note)(:)/, (_, a: string, b: string, c: string) => a + s.yellow(b) + c)
        .replace(/\((\d+% less)\)/g, (_, m: string) => `(${s.green(m)})`)
        .replace(/ (\d+ identical)/g, (_, m: string) => ` ${s.green(m)}`);
    })
    .join('\n');
}
