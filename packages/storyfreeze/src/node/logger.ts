import chalk from 'chalk';

/* eslint-disable no-console -- this class is the CLI's console boundary */

// Derived from storycrawler. Copyright (c) 2019 reg-viz, MIT licensed.
// https://github.com/reg-viz/storycap/tree/master/packages/storycrawler

export type LogLevel = 'verbose' | 'silent' | 'normal';

export class Logger {
  readonly color: chalk.Chalk;

  constructor(readonly level: LogLevel = 'normal') {
    type ChalkConstructor = new (options: { level: number }) => chalk.Chalk;
    const chalkRuntime = chalk as unknown as { Instance?: ChalkConstructor; constructor: ChalkConstructor };
    const Chalk = chalkRuntime.Instance ?? chalkRuntime.constructor;
    this.color = new Chalk({ level: 1 });
  }

  debug(...message: unknown[]) {
    if (this.level !== 'verbose') return;
    console.log(this.color.gray('debug'), ...message);
  }

  log(...message: Array<string | number | boolean>) {
    if (this.level === 'silent') return;
    console.log(this.color.cyan('info'), ...message);
  }

  warn(...message: Array<string | number | boolean>) {
    if (this.level === 'silent') return;
    console.error(this.color.yellow('warn'), ...message);
  }

  error(...message: unknown[]) {
    if (this.level === 'silent') return;
    console.error(this.color.red('error'), ...message);
  }

  errorStack(stack: unknown) {
    if (this.level === 'silent') return;
    console.error(stack);
  }

  write(data: string | Buffer) {
    if (this.level === 'silent') return;
    process.stdout.write(data);
  }

  tick() {
    if (this.level === 'silent') return;
    process.stdout.write('.');
  }
}
