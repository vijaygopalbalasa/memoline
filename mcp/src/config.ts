/** Memoline's API runs on Arc testnet today, so the server reads testnet when MEMOLINE_API_URL is not set.
 * Once Memoline's mainnet release is live, set MEMOLINE_API_URL to https://memoline-one.vercel.app. */
export const DEFAULT_API_URL = 'https://memoline-testnet.vercel.app';

/** Which Memoline to read from: the one MEMOLINE_API_URL names, or the default when it is not set or empty. */
export function apiUrlFrom(env: Record<string, string | undefined>): string {
  return env.MEMOLINE_API_URL || DEFAULT_API_URL;
}

export type Config = { ok: true; baseUrl: string; apiKey: string | undefined } | { ok: false; error: string };

/** Plain http reaches only this machine, for local development. The host is compared after parsing, so
 * http://localhost.evil.example or http://localhost@evil.example is another host and is refused. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function keepsKeyPrivate(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname));
}

/** The server's settings from its environment. A key travels only over https, or over plain http to this
 * machine, so a key with any other address refuses to start. An empty key is never sent, so it is no key. */
export function configFrom(env: Record<string, string | undefined>): Config {
  const baseUrl = apiUrlFrom(env);
  const apiKey = env.MEMOLINE_API_KEY || undefined;
  if (apiKey !== undefined && !keepsKeyPrivate(baseUrl)) {
    return {
      ok: false,
      error:
        'Memoline MCP did not start: MEMOLINE_API_KEY is set and MEMOLINE_API_URL is not an https address, so the key would travel in plain text. ' +
        `Use an https address, such as ${DEFAULT_API_URL}. Plain http is allowed only for http://localhost and http://127.0.0.1, for local development.`,
    };
  }
  return { ok: true, baseUrl, apiKey };
}
