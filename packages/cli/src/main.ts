#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { run } from './run.js';

let stopping = false;
let wake: (() => void) | null = null;
const stop = () => {
  stopping = true;
  wake?.();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const sleep = (ms: number) =>
  new Promise<boolean>((resolve) => {
    if (stopping) return resolve(false);
    const timer = setTimeout(() => resolve(!stopping), ms);
    wake = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });

process.exitCode = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  sleep,
});
