// Fixed-format diagnostics. Every line is built from identifiers chosen by the
// code, integers and error codes; free text, paths, messages and stacks never
// reach the sink. Anything that does not look like an identifier or a code is
// replaced before it is written. A sink that throws is ignored: diagnostics never
// break the caller (a throwing sink once wedged the monitor's refresh chain).

export type LogSink = (line: string) => void;

const IDENT = /^[a-z][a-z0-9_.-]{0,39}$/;
const CODE = /^[A-Z0-9_]{1,40}$/;

function ident(s: string): string {
  return IDENT.test(s) ? s : "invalid";
}

function int(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export class Logger {
  constructor(private readonly sink: LogSink) {}

  private write(line: string): void {
    try {
      this.sink(line);
    } catch {
      // swallowed: a broken output channel must not take the caller down
    }
  }

  count(event: string, n: number): void {
    this.write(`count ${ident(event)}=${int(n)}`);
  }

  error(where: string, code: string): void {
    this.write(`error ${ident(where)} ${CODE.test(code) ? code : "EXCEPTION"}`);
  }

  timing(what: string, ms: number): void {
    this.write(`timing ${ident(what)} ${int(ms)}ms`);
  }
}
