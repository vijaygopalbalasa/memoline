import { type RunReport, runFooter } from './csv.js';

const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export function runToJson(r: RunReport): string {
  return JSON.stringify({ ...r, footer: runFooter(r) }, bigintReplacer, 2);
}
