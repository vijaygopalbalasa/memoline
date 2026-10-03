/**
 * The reads an agent needs to keep its books on Arc, over Memoline's public API: one transaction as
 * ledger lines (from its sender's or a chosen account's point of view), an address's recent lines, or
 * a payment link. Each answers a plain summary for the model to read and the API's JSON beside it.
 * Nothing here throws: a refusal is a sentence.
 */
export type ToolResult = { ok: true; text: string; data: unknown } | { ok: false; text: string };

type Line = {
  direction: string;
  token: string;
  amount: string;
  counterparty: string;
  reference: string | null;
  fee: string;
};

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const network = (chainId: unknown) => (chainId === 5042 ? 'Arc mainnet' : 'Arc testnet');

function describeLine(l: Line): string {
  const ref = l.reference ? `, reference ${l.reference}` : '';
  if (l.direction === 'in') return `received ${l.amount} ${l.token} from ${l.counterparty}${ref}`;
  if (l.direction === 'self') return `sent ${l.amount} ${l.token} to itself${ref}`;
  return `paid ${l.amount} ${l.token} to ${l.counterparty}${ref}`;
}

type Movement = { from: string; to: string; token: string; amount: string; kind: string };
const isMovements = (v: unknown): v is Movement[] =>
  Array.isArray(v) &&
  v.every(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      typeof m.from === 'string' &&
      typeof m.to === 'string' &&
      typeof m.amount === 'string',
  );
/** A movement in words: who paid whom. Minted and burned money has no payer or payee. */
function describeMovement(m: Movement): string {
  if (m.kind === 'mint') return `${m.amount} ${m.token} newly created for ${m.to}`;
  if (m.kind === 'burn') return `${m.amount} ${m.token} destroyed by ${m.from}`;
  if (m.kind === 'self') return `${m.from} sent ${m.amount} ${m.token} to itself`;
  return `${m.from} paid ${m.amount} ${m.token} to ${m.to}`;
}

const isLines = (v: unknown): v is Line[] =>
  Array.isArray(v) &&
  v.every(
    (l) =>
      typeof l === 'object' && l !== null && typeof l.amount === 'string' && typeof l.direction === 'string',
  );

export function memolineTools(opts: { baseUrl: string; fetch?: typeof fetch; apiKey?: string | undefined }) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const get = opts.fetch ?? fetch;

  async function call(
    path: string,
    o: { keyed?: boolean } = {},
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; text: string }> {
    let res: Response;
    try {
      res = await get(`${base}${path}`, {
        headers: {
          accept: 'application/json',
          // A workspace's own books need its key; the public reads never send one.
          ...(o.keyed && opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
      });
    } catch {
      return { ok: false, text: `The Memoline API at ${base} could not be reached. Try again in a moment.` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, text: `The Memoline API answered ${res.status} with something that is not JSON.` };
    }
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        text: typeof b.error === 'string' ? b.error : `The Memoline API answered ${res.status}.`,
      };
    }
    return { ok: true, body: b };
  }

  return {
    async transaction(hash: string, o: { account?: string | undefined } = {}): Promise<ToolResult> {
      if (!HASH.test(hash)) return { ok: false, text: 'A transaction hash is 0x and 64 hex characters.' };
      if (o.account !== undefined && !ADDRESS.test(o.account))
        return { ok: false, text: 'An account is an Arc address: 0x and 40 hex characters.' };
      const r = await call(`/api/v1/tx/${hash}${o.account ? `?account=${o.account}` : ''}`);
      if (!r.ok) return r;
      const t = r.body.transaction as Record<string, unknown> | undefined;
      if (r.body.apiVersion !== 1 || !t || !isLines(r.body.lines)) {
        return { ok: false, text: 'The answer was not what the Memoline API returns; nothing was read.' };
      }
      const lines = r.body.lines;
      const n = (r.body.normalization ?? {}) as Record<string, unknown>;
      const movements = isMovements(n.movements) ? n.movements : [];
      const moved = movements.filter((m) => m.kind !== 'self');
      // A sender that moved no money (a relayed transfer, an x402 settlement) is named as the gas payer,
      // and the payment is told from the movements, never as "sent 0.00 to itself".
      const senderMovedNothing =
        moved.length > 0 && lines.every((l) => l.direction === 'self' && /^0(\.0+)?$/.test(l.amount));
      const gas =
        senderMovedNothing && typeof n.gasPayer === 'string'
          ? `gas ${t.fee} USDC paid by ${n.gasPayer}, which moved no money`
          : `sent by ${t.from}, gas ${t.fee} USDC`;
      const head = `${network(r.body.chainId)} transaction ${t.hash}: ${t.status === 'success' ? 'confirmed' : 'reverted, nothing was paid'}, ${gas}.`;
      const account = r.body.account as { address?: string; participant?: boolean } | undefined;
      const view = account?.address ? `From the point of view of ${account.address}` : null;
      let body: string;
      if (account && account.participant === false) {
        body = `${view}: ${typeof r.body.note === 'string' ? r.body.note : 'it took no part in this transaction.'}`;
      } else if (senderMovedNothing && !account) {
        body = `${moved.length === 1 ? 'The movement' : `${moved.length} movements`}:\n${moved.map((m) => `- ${describeMovement(m)}`).join('\n')}`;
      } else if (lines.length === 0) {
        body = `${view ? `${view}: it` : 'It'} moved no USDC or EURC${view ? '' : ' to or from its sender'}.`;
      } else {
        body = `${view ? `${view}, ` : ''}${lines.length} ${lines.length === 1 ? 'line' : 'lines'}:\n${lines.map((l) => `- ${describeLine(l)}`).join('\n')}`;
      }
      return { ok: true, text: `${head}\n${body}`, data: r.body };
    },

    async address(address: string): Promise<ToolResult> {
      if (!ADDRESS.test(address)) return { ok: false, text: 'An Arc address is 0x and 40 hex characters.' };
      const r = await call(`/api/v1/address/${address}`);
      if (!r.ok) return r;
      if (r.body.apiVersion !== 1 || !isLines(r.body.lines)) {
        return { ok: false, text: 'The answer was not what the Memoline API returns; nothing was read.' };
      }
      const lines = r.body.lines;
      const cov = r.body.coverage as { complete?: boolean } | undefined;
      const head = `${network(r.body.chainId)} address ${r.body.address}, about the last day: ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}.`;
      const warn =
        cov?.complete === false
          ? '\nNot every block of the window was read, so older lines may be missing.'
          : '';
      const list = lines.map((l) => `- ${describeLine(l)}`).join('\n');
      return { ok: true, text: `${head}${warn}${list ? `\n${list}` : ''}`, data: r.body };
    },

    /** A workspace account's statement over a period, rolled up by counterparty. Needs a key with
     * the read scope. The words and the data carry addresses and the workspace's own names only: a name read
     * from the ERC-8004 registry (the API's `agents`) is a stranger's words, and a model reads both blocks,
     * so it is left out of each. */
    async statement(p: {
      account: string;
      token: 'USDC' | 'EURC';
      from: number;
      to: number;
    }): Promise<ToolResult> {
      if (!ADDRESS.test(p.account))
        return { ok: false, text: 'An account is an Arc address: 0x and 40 hex characters.' };
      if (p.token !== 'USDC' && p.token !== 'EURC')
        return { ok: false, text: 'The currency is USDC or EURC.' };
      if (!Number.isInteger(p.from) || !Number.isInteger(p.to) || p.from < 0 || p.to < 0)
        return { ok: false, text: 'from and to are times in seconds since 1970.' };
      if (p.from > p.to)
        return { ok: false, text: 'from is after to: the period must start before it ends.' };
      if (!opts.apiKey)
        return {
          ok: false,
          text: 'Reading a workspace statement needs an API key: set MEMOLINE_API_KEY to a key with the read scope, made in Settings, API keys.',
        };
      const r = await call(
        `/api/v1/statement?account=${p.account}&token=${p.token}&from=${p.from}&to=${p.to}`,
        { keyed: true },
      );
      if (!r.ok) return r;
      const b = r.body;
      const totals = b.totals as Record<string, unknown> | undefined;
      const rolled = b.rolled as { lines?: unknown[]; next?: unknown } | undefined;
      if (b.apiVersion !== 1 || !totals || !rolled || !Array.isArray(rolled.lines)) {
        return { ok: false, text: 'The answer was not what the Memoline API returns; nothing was read.' };
      }
      const day = (t: unknown) => new Date(Number(t) * 1000).toISOString().slice(0, 10);
      const head = `${network(b.chainId)} statement for ${b.account}, ${b.token}, ${day(b.from)} to ${day(b.to)}: in ${totals.in}, out ${totals.out}, gas ${totals.fees}.`;
      const tie =
        b.ties === true
          ? `Balances on Arc: opening ${b.opening}, closing ${b.closing}, and the period closes.`
          : b.ties === false
            ? `Balances on Arc: opening ${b.opening}, closing ${b.closing}; the period does not close. ${(Array.isArray(b.findings) ? b.findings : []).join(' ')}`
            : 'The balances on Arc could not be read, so the totals are not checked against the chain.';
      const lines = rolled.lines as {
        counterparty: string;
        name: string | null;
        direction: string;
        amount: string;
        count: number;
      }[];
      const who = (l: { counterparty: string; name: string | null }) =>
        l.name ? `${l.name} (${l.counterparty})` : l.counterparty;
      const list = lines.map(
        (l) =>
          `- ${l.direction === 'in' ? 'received' : 'paid'} ${l.amount} ${b.token} ${l.direction === 'in' ? 'from' : 'to'} ${who(l)} in ${Number(l.count).toLocaleString('en-US')} ${Number(l.count) === 1 ? 'payment' : 'payments'}`,
      );
      const more = rolled.next ? '\nMore rolled lines exist; ask the API with its cursor for the rest.' : '';
      return {
        ok: true,
        text: `${head}\n${tie}\n${lines.length === 0 ? 'No movements with a counterparty in the period.' : `${lines.length} rolled ${lines.length === 1 ? 'line' : 'lines'}:\n${list.join('\n')}`}${more}`,
        data: (({ agents: _agents, ...rest }) => rest)(b),
      };
    },

    async link(id: string, amount?: string): Promise<ToolResult> {
      if (!/^[0-9A-Z]{26}$/.test(id))
        return { ok: false, text: 'A payment link id is 26 letters and digits.' };
      if (amount !== undefined && !/^\d+(\.\d{1,6})?$/.test(amount)) {
        return {
          ok: false,
          text: 'The amount must be a plain number with at most 6 decimal places, like 12.50.',
        };
      }
      const r = await call(`/api/v1/links/${id}${amount !== undefined ? `?amount=${amount}` : ''}`);
      if (!r.ok) return r;
      const l = r.body.link as Record<string, unknown> | undefined;
      if (r.body.apiVersion !== 1 || !l) {
        return { ok: false, text: 'The answer was not what the Memoline API returns; nothing was read.' };
      }
      const token = String(l.token);
      const asks = l.amount === null ? `asks any amount of ${token}` : `asks ${l.amount} ${token}`;
      const lines = [
        `${network(l.chainId)} payment link ${l.id} ${asks} to ${l.payee} for ${l.reference}${l.description ? ` (${l.description})` : ''}.`,
        `Status: ${String(l.status).replace('_', ' ')}; ${l.paid} ${token} paid${l.remaining !== null && l.remaining !== undefined ? `, ${l.remaining} ${token} left` : ''}.`,
      ];
      const pay = r.body.pay as {
        to: string;
        data: string;
        value: string;
        amount: string;
        chainId: number;
      } | null;
      if (!r.body.payableNow) lines.push(String(r.body.reason ?? 'It cannot be paid now.'));
      else if (pay) {
        lines.push(
          `To pay ${pay.amount} ${token}, send to ${pay.to} on chain ${pay.chainId} with value 0 and data ${pay.data}, from an ordinary wallet (not a smart-contract wallet), then post the transaction hash to /api/v1/links/${l.id}/confirm.`,
        );
      } else lines.push('It takes any amount: ask again with the amount to get the transaction to sign.');
      return { ok: true, text: lines.join('\n'), data: r.body };
    },
  };
}

export type MemolineTools = ReturnType<typeof memolineTools>;
