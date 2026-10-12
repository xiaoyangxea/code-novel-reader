import { open } from 'node:fs/promises';
import { connect } from 'node:net';
import * as path from 'node:path';
import { homedir } from 'node:os';

export function effectiveProxy(configured?: string): string | undefined {
  return configured || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || undefined;
}

export function parseClashProxyPort(header: string): number | undefined {
  const match = header.match(/^mixed-port:\s*(\d+)\s*$/m) ?? header.match(/^port:\s*(\d+)\s*$/m);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/** Inspect only the local app's header/port, never subscription or node credentials. */
export async function detectLocalProxy(): Promise<string | undefined> {
  const roots = process.platform === 'win32'
    ? [process.env.APPDATA && path.join(process.env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev')]
    : [path.join(homedir(), '.config', 'io.github.clash-verge-rev.clash-verge-rev')];
  for (const root of roots) {
    if (!root) continue;
    let port: number | undefined;
    try {
      const handle = await open(path.join(root, 'config.yaml'), 'r');
      try {
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        port = parseClashProxyPort(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally { await handle.close(); }
    } catch { continue; }
    if (!port) continue;
    const live = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      const finish = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.setTimeout(300, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
    if (live) return `http://127.0.0.1:${port}`;
  }
  return undefined;
}
