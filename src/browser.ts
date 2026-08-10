import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveSafeRemoteUrl, type FetchOptions } from './net';

const maxRenderedBytes = 8_000_000;
let browserQueue: Promise<void> = Promise.resolve();

const browserIsolationArgs = [
  '--disable-extensions', '--disable-sync', '--disable-background-networking',
  '--disable-component-update', '--disable-default-apps', '--disable-domain-reliability',
  '--no-first-run', '--no-default-browser-check', '--disable-notifications',
  '--disable-background-mode', '--password-store=basic'
];

function hostResolverArgument(rawUrl: string, address: string): string {
  const hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  const mappedAddress = address.includes(':') ? `[${address}]` : address;
  return `--host-resolver-rules=MAP ${hostname} ${mappedAddress}, MAP localhost ~NOTFOUND, MAP *.localhost ~NOTFOUND, MAP 127.* ~NOTFOUND, MAP 10.* ~NOTFOUND, MAP 169.254.* ~NOTFOUND, MAP 192.168.* ~NOTFOUND, MAP 172.16.* ~NOTFOUND, MAP 172.17.* ~NOTFOUND, MAP 172.18.* ~NOTFOUND, MAP 172.19.* ~NOTFOUND, MAP 172.20.* ~NOTFOUND, MAP 172.21.* ~NOTFOUND, MAP 172.22.* ~NOTFOUND, MAP 172.23.* ~NOTFOUND, MAP 172.24.* ~NOTFOUND, MAP 172.25.* ~NOTFOUND, MAP 172.26.* ~NOTFOUND, MAP 172.27.* ~NOTFOUND, MAP 172.28.* ~NOTFOUND, MAP 172.29.* ~NOTFOUND, MAP 172.30.* ~NOTFOUND, MAP 172.31.* ~NOTFOUND`;
}

export class BrowserVerificationRequiredError extends Error {
  constructor(readonly url: string) {
    super('站点需要浏览器验证。请使用插件的专用验证窗口完成一次验证后重试。');
    this.name = 'BrowserVerificationRequiredError';
  }
}

function candidatePaths(configured?: string): string[] {
  const candidates = configured ? [configured] : [];
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter((value): value is string => Boolean(value));
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
        path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    );
  } else {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge', 'brave-browser']) {
        candidates.push(path.join(directory, name));
      }
    }
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

export async function findBrowserExecutable(configured?: string): Promise<string | undefined> {
  for (const candidate of candidatePaths(configured)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard installation location.
    }
  }
  return undefined;
}

function siteProfileDirectory(root: string, rawUrl: string): string {
  const host = new URL(rawUrl).hostname.toLowerCase();
  const id = createHash('sha256').update(host).digest('hex').slice(0, 20);
  return path.join(root, id);
}

function isChallengePage(html: string): boolean {
  return /Just a moment|Checking your browser|challenge-platform|cf-turnstile|cf-browser-verification|Cloudflare Ray ID|验证码|人机验证|请稍候/i.test(html);
}

async function queued<T>(operation: () => Promise<T>): Promise<T> {
  const previous = browserQueue;
  let release!: () => void;
  browserQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`浏览器渲染超时（${timeoutMs}ms）。`));
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

export async function renderHtmlWithBrowser(url: string, options: FetchOptions): Promise<string> {
  const resolved = await resolveSafeRemoteUrl(url, options.timeoutMs);
  const safeUrl = resolved.url;
  if (options.browserRendering === false) throw new Error('浏览器渲染已关闭。');
  const executable = await findBrowserExecutable(options.browserExecutable);
  if (!executable) {
    throw new Error('未找到 Chrome、Edge、Chromium 或 Brave；可在 codeNovel.browserExecutable 中手动指定。');
  }
  if (!options.browserDataDirectory) throw new Error('浏览器隔离数据目录尚未初始化。');
  const profile = siteProfileDirectory(options.browserDataDirectory, safeUrl);
  await mkdir(profile, { recursive: true });
  return queued(async () => {
    const timeoutMs = Math.min(Math.max(options.browserTimeoutMs ?? options.timeoutMs, 12_000), 60_000);
    const renderedLimit = Math.min(options.maxBytes ?? maxRenderedBytes, maxRenderedBytes);
    const args = [
      '--headless=new', '--disable-gpu', '--mute-audio', '--no-proxy-server', ...browserIsolationArgs,
      hostResolverArgument(safeUrl, resolved.address), `--user-data-dir=${profile}`,
      `--virtual-time-budget=${Math.max(timeoutMs - 2_000, 5_000)}`, '--dump-dom'
    ];
    args.push(safeUrl);
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return;
      total += chunk.length;
      if (total > renderedLimit) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    const { code, stderr } = await waitForExit(child, timeoutMs);
    if (overflow) throw new Error(`浏览器渲染后的页面超过 ${Math.ceil(renderedLimit / 1_000_000)} MB，已停止读取。`);
    const html = Buffer.concat(chunks, total).toString('utf8');
    if (isChallengePage(html)) throw new BrowserVerificationRequiredError(safeUrl);
    if (!html.trim() || (code !== 0 && html.length < 200)) {
      throw new Error(`浏览器渲染失败${code === null ? '' : `（退出码 ${code}）`}${stderr ? `：${stderr.trim().slice(0, 300)}` : ''}`);
    }
    return html;
  });
}

export async function startVerificationBrowser(url: string, options: FetchOptions): Promise<void> {
  const resolved = await resolveSafeRemoteUrl(url, options.timeoutMs);
  const safeUrl = resolved.url;
  const executable = await findBrowserExecutable(options.browserExecutable);
  if (!executable) throw new Error('未找到可用于验证的 Chrome、Edge、Chromium 或 Brave。');
  if (!options.browserDataDirectory) throw new Error('浏览器隔离数据目录尚未初始化。');
  const profile = siteProfileDirectory(options.browserDataDirectory, safeUrl);
  await mkdir(profile, { recursive: true });
  const args = [
    '--no-proxy-server', ...browserIsolationArgs, hostResolverArgument(safeUrl, resolved.address), `--user-data-dir=${profile}`, '--new-window'
  ];
  args.push(safeUrl);
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: false, detached: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.unref();
      resolve();
    }, 1200);
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const onExit = (code: number | null) => {
      if (code === 0) return;
      clearTimeout(timer);
      reject(new Error(`专用浏览器启动后立即退出${code === null ? '' : `（退出码 ${code}）`}。`));
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}
