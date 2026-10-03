#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFrom } from './config.ts';
import { createServer } from './server.ts';
import { memolineTools } from './tools.ts';

// Which Memoline to read from: Arc testnet by default for now, or the one MEMOLINE_API_URL names. A key
// with the read scope (Settings, API keys) lets the statement tool read the workspace's own books, and it
// only ever travels over https: with any other address the server says why on stderr and exits with 1.
// exitCode rather than exit(), so the sentence reaches a piped stderr before the process ends.
const config = configFrom(process.env);
if (config.ok) {
  await createServer(memolineTools({ baseUrl: config.baseUrl, apiKey: config.apiKey })).connect(
    new StdioServerTransport(),
  );
} else {
  process.stderr.write(`${config.error}\n`);
  process.exitCode = 1;
}
