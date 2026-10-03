# @memoline/mcp

An MCP server that lets an AI agent read Arc as ledger lines through Memoline's public HTTP API.

It offers four read-only tools. Three of them read public data and need no key. The fourth,
`arc_statement`, reads one of your workspace's accounts and needs a Memoline API key with the read scope.

It never holds funds, never holds a wallet key, and never signs or sends a transaction. It only sends GET
requests to the Memoline API you point it at, and it sends your API key only with `arc_statement` and only
over https.

## Run it

It needs Node 20 or later. Run it with npx:

```sh
npx -y @memoline/mcp
```

The server speaks MCP over standard input and output, so your MCP client starts it for you. Add it to the
client's configuration:

```json
{
  "mcpServers": {
    "memoline": {
      "command": "npx",
      "args": ["-y", "@memoline/mcp"],
      "env": {
        "MEMOLINE_API_URL": "https://memoline-testnet.vercel.app",
        "MEMOLINE_API_KEY": "ml_test_..."
      }
    }
  }
}
```

Leave out `MEMOLINE_API_KEY` if you only use the public tools. You can also install it once with
`npm install -g @memoline/mcp` and run `memoline-mcp`.

## Settings

`MEMOLINE_API_URL` says which Memoline to read from. Memoline's API runs on Arc testnet today, so for now
the server reads Arc testnet when it is not set.

- Arc testnet: `https://memoline-testnet.vercel.app` (the default for now)
- Arc mainnet: `https://memoline-one.vercel.app`, once Memoline's mainnet release is live

To read Arc mainnet once that release is live, set `MEMOLINE_API_URL` to `https://memoline-one.vercel.app`.

`MEMOLINE_API_KEY` is optional. It is a Memoline API key with the read scope, which a workspace admin makes in
Settings, API keys. Keys for Arc testnet start with `ml_test_` and work only with the testnet URL. Keys for Arc
mainnet start with `ml_live_`.

The server never sends a key in plain text. If `MEMOLINE_API_KEY` is set and `MEMOLINE_API_URL` is not an
https address, the server does not start: it says why on standard error and exits with code 1. Plain http is
allowed only for `http://localhost` and `http://127.0.0.1`, for local development.

## Tools

Each tool answers with a plain summary for the model to read and the API's JSON beside it. When a tool
cannot answer, it says why in one sentence and marks the answer as an error.

### arc_transaction

Reads one Arc transaction as ledger lines: each USDC or EURC movement counted once, gas split across the
lines, and the invoice reference from its Arc Memo. Lines are from the sender's point of view, or from the
account given; a transfer sent by a third wallet (an x402 settlement) names its payer and payee from the
movements.

- `hash` (string, required): The transaction hash, 0x and 64 hex characters.
- `account` (string, optional): An address whose point of view the lines take, 0x and 40 hex characters.

### arc_address

Reads an Arc address's USDC and EURC movements over about the last day as ledger lines, with gas on the
lines it paid for and memo references attached.

- `address` (string, required): The address, 0x and 40 hex characters.

### arc_link

Reads a Memoline payment link: what it asks, to whom, under which reference, what has been paid, and the
exact transaction a wallet signs to pay it. Read-only: it never signs or sends.

- `id` (string, required): The link id, the last part of its pay page address.
- `amount` (string, optional): For a link that takes any amount: how much to pay, like 12.50.

### arc_statement

Reads one of the workspace's accounts over a period as a statement rolled up by counterparty: money in and
out, gas, the balances Arc reports at the period's edges and whether it closes, and one line per
counterparty and direction with the count of payments. Needs MEMOLINE_API_KEY (a key with the read
scope). Read-only.

- `account` (string, required): An account of the workspace, 0x and 40 hex characters.
- `token` (`USDC` or `EURC`, required): The currency.
- `from` (integer, required): The start of the period, seconds since 1970.
- `to` (integer, required): The end of the period, seconds since 1970.

## Licence

MIT. See [LICENSE](LICENSE). The licence covers this package only. Memoline's hosted application and the
rest of its code are proprietary.
