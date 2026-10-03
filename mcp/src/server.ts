import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemolineTools, ToolResult } from './tools.ts';

const answer = (r: ToolResult) =>
  r.ok
    ? {
        content: [
          { type: 'text' as const, text: r.text },
          { type: 'text' as const, text: JSON.stringify(r.data, null, 2) },
        ],
      }
    : { content: [{ type: 'text' as const, text: r.text }], isError: true };

/** An MCP server with Memoline's four read-only tools. */
export function createServer(tools: MemolineTools): McpServer {
  const server = new McpServer({ name: 'memoline', version: '0.1.0' });
  server.registerTool(
    'arc_transaction',
    {
      title: 'Arc transaction as ledger lines',
      description:
        "Reads one Arc transaction as ledger lines: each USDC or EURC movement counted once, gas split across the lines, and the invoice reference from its Arc Memo. Lines are from the sender's point of view, or from the account given; a transfer sent by a third wallet (an x402 settlement) names its payer and payee from the movements.",
      inputSchema: {
        hash: z.string().describe('The transaction hash, 0x and 64 hex characters.'),
        account: z
          .string()
          .optional()
          .describe('An address whose point of view the lines take, 0x and 40 hex characters.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ hash, account }) => answer(await tools.transaction(hash, { account })),
  );
  server.registerTool(
    'arc_address',
    {
      title: 'Arc address, recent ledger lines',
      description:
        "Reads an Arc address's USDC and EURC movements over about the last day as ledger lines, with gas on the lines it paid for and memo references attached.",
      inputSchema: { address: z.string().describe('The address, 0x and 40 hex characters.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address }) => answer(await tools.address(address)),
  );
  server.registerTool(
    'arc_link',
    {
      title: 'Arc payment link',
      description:
        'Reads a Memoline payment link: what it asks, to whom, under which reference, what has been paid, and the exact transaction a wallet signs to pay it. Read-only: it never signs or sends.',
      inputSchema: {
        id: z.string().describe('The link id, the last part of its pay page address.'),
        amount: z
          .string()
          .optional()
          .describe('For a link that takes any amount: how much to pay, like 12.50.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id, amount }) => answer(await tools.link(id, amount)),
  );
  server.registerTool(
    'arc_statement',
    {
      title: 'Workspace statement, rolled up by counterparty',
      description:
        "Reads one of the workspace's accounts over a period as a statement rolled up by counterparty: money in and out, gas, the balances Arc reports at the period's edges and whether it closes, and one line per counterparty and direction with the count of payments. Needs MEMOLINE_API_KEY (a key with the read scope). Read-only.",
      inputSchema: {
        account: z.string().describe('An account of the workspace, 0x and 40 hex characters.'),
        token: z.enum(['USDC', 'EURC']).describe('The currency.'),
        from: z.number().int().describe('The start of the period, seconds since 1970.'),
        to: z.number().int().describe('The end of the period, seconds since 1970.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (p) => answer(await tools.statement(p)),
  );
  return server;
}
