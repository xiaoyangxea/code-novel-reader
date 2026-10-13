import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { readChromiumCachedHtmlBatch } from './chromium-cache';
import { resolveSafeRemoteUrl, type FetchOptions } from './net';
import { createBrowserRoute, type BrowserRoute } from './browser-proxy';

const maxRenderedBytes = 8_000_000;
const verificationAttemptLifetimeMs = 30 * 60 * 1000;
const normalBrowserPreferenceLifetimeMs = 30 * 60 * 1000;
let browserQueue: Promise<void> = Promise.resolve();
const executableCache = new Map<string, string>();
const normalBrowserPreferredUntil = new Map<string, number>();
const verificationRoutes = new Set<BrowserRoute>();

export async function closeVerificationRoutes(): Promise<void> {
  await Promise.all([...verificationRoutes].map((route) => route.close()));
  verificationRoutes.clear();
}

async function withBrowserRoute<T>(options: FetchOptions, operation: (route: BrowserRoute) => Promise<T>): Promise<T> {
  const route = await createBrowserRoute(options);
  try { return await operation(route); } finally { await route.close(); }
}

function browserNetworkArgs(route: BrowserRoute, url: string, address: string): string[] {
  return [...route.args, ...(route.args.includes('--no-proxy-server') ? [hostResolverArgument(url, address)] : [])];
}

export const browserIsolationArguments = Object.freeze([
  '--disable-extensions', '--disable-sync', '--disable-background-networking',
  '--disable-component-update', '--disable-default-apps', '--disable-domain-reliability',
  '--no-first-run', '--no-default-browser-check', '--disable-notifications',
  '--disable-background-mode', '--password-store=basic',
  // The isolated profile is intentionally terminated after a capture. Suppress
  // browser-owned UI that would otherwise cover the novel page on a later run.
  '--disable-translate', '--disable-features=TranslateUI',
  '--hide-crash-restore-bubble', '--disable-session-crashed-bubble'
]);

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

export class BrowserAutomationBlockedError extends Error {
  constructor(readonly url: string) {
    super('该站点在普通浏览器中可以打开，但仍拒绝插件自动读取页面。重复打开验证窗口无法解决；当前不能直接导入该站，可暂时使用本地 TXT/EPUB。');
    this.name = 'BrowserAutomationBlockedError';
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
  const cacheKey = configured ? path.resolve(configured) : '<automatic>';
  const cached = executableCache.get(cacheKey);
  if (cached) return cached;
  for (const candidate of candidatePaths(configured)) {
    try {
      await access(candidate);
      executableCache.set(cacheKey, candidate);
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

function verificationAttemptPath(profile: string): string {
  return path.join(profile, '.verification-attempted');
}

async function hasRecentVerificationAttempt(profile: string): Promise<boolean> {
  try {
    const info = await stat(verificationAttemptPath(profile));
    return Date.now() - info.mtimeMs <= verificationAttemptLifetimeMs;
  } catch {
    return false;
  }
}

export function isBrowserChallengeHtml(html: string): boolean {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, ' ').trim() ?? '';
  if (/Just a moment|Checking your browser|安全验证|人机验证|请稍候/i.test(title)) return true;

  // Some sites retain challenge-related scripts after serving a valid chapter. A
  // substantial page with a normal reader/catalog container must not be rejected.
  const readableStructure = /(?:id|class)\s*=\s*["'][^"']*(?:chaptercontent|chapter-content|novelcontent|booktxt|read-content|section-list|full_chapters|chapter-list|catalog|\bcontent\b|\bcon\b)[^"']*["']/i.test(html);
  if (readableStructure && html.length >= 2000) return false;
  if (/cf-turnstile|cf-browser-verification|challenge-platform|cdn-cgi\/challenge-platform|Cloudflare Ray ID/i.test(html)) return true;

  const visibleText = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return visibleText.length < 1500 && /验证码|人机验证|完成安全验证|请稍候/i.test(visibleText);
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasDesktopSession(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
    || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

const browserStops = new WeakMap<ChildProcess, Promise<void>>();

export function ownedBrowserTerminationArguments(pid: number): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('无效的专用浏览器进程 ID。');
  return ['/PID', String(pid), '/T', '/F'];
}

async function stopOwnedBrowser(child: ChildProcess): Promise<void> {
  const pending = browserStops.get(child);
  if (pending) return pending;
  const stopped = (async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // This ChildProcess was created by the current reading task. Never kill by
    // browser name or terminate an independently opened verification window.
    if (process.platform === 'win32' && child.pid) {
      await new Promise<void>((resolve) => execFile('taskkill.exe', ownedBrowserTerminationArguments(child.pid!),
        { windowsHide: true, timeout: 2000 }, () => resolve()));
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, delay(2000)]);
  })();
  browserStops.set(child, stopped);
  return stopped;
}

async function renderHeadlessHtml(
  executable: string,
  safeUrl: string,
  address: string,
  profile: string,
  timeoutMs: number,
  renderedLimit: number,
  route: BrowserRoute
): Promise<string> {
  const args = [
    '--headless=new', '--disable-gpu', '--mute-audio', ...browserIsolationArguments,
    ...browserNetworkArgs(route, safeUrl, address), `--user-data-dir=${profile}`,
    `--virtual-time-budget=${Math.max(timeoutMs - 2_000, 5_000)}`, '--dump-dom', safeUrl
  ];
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const chunks: Buffer[] = [];
  let total = 0;
  let overflow = false;
  child.stdout?.on('data', (chunk: Buffer) => {
    if (overflow) return;
    total += chunk.length;
    if (total > renderedLimit) {
      overflow = true;
      void stopOwnedBrowser(child);
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  let code: number | null;
  let stderr: string;
  try { ({ code, stderr } = await waitForExit(child, timeoutMs)); }
  finally { await stopOwnedBrowser(child); }
  if (overflow) throw new Error(`浏览器渲染后的页面超过 ${Math.ceil(renderedLimit / 1_000_000)} MB，已停止读取。`);
  const html = Buffer.concat(chunks, total).toString('utf8');
  if (isBrowserChallengeHtml(html)) throw new BrowserVerificationRequiredError(safeUrl);
  if (!html.trim() || (code !== 0 && html.length < 200)) {
    throw new Error(`浏览器渲染失败${code === null ? '' : `（退出码 ${code}）`}${stderr ? `：${stderr.trim().slice(0, 300)}` : ''}`);
  }
  return html;
}

async function renderFromNormalBrowserCache(
  executable: string,
  safeUrls: string[],
  address: string,
  profile: string,
  cacheDirectoryRoot: string,
  timeoutMs: number,
  renderedLimit: number,
  route: BrowserRoute
): Promise<Map<string, string>> {
  const safeUrl = safeUrls[0];
  if (!safeUrl) throw new Error('没有可供普通浏览器读取的 URL。');
  await mkdir(cacheDirectoryRoot, { recursive: true });
  const cacheRoot = await mkdtemp(path.join(cacheDirectoryRoot, 'request-'));
  const args = [
    '--disable-gpu', '--mute-audio', ...browserIsolationArguments,
    '--start-minimized', '--window-size=800,600',
    ...browserNetworkArgs(route, safeUrl, address), `--user-data-dir=${profile}`, `--disk-cache-dir=${cacheRoot}`,
    '--new-window', ...safeUrls
  ];
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
  let spawnError: Error | undefined;
  let exitCode: number | null | undefined;
  child.once('error', (error) => { spawnError = error; });
  child.once('exit', (code) => { exitCode = code; });
  const deadline = Date.now() + timeoutMs;
  const challengeUrls = new Set<string>();
  let firstChallengeAt: number | undefined;
  const results = new Map<string, string>();
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const pendingUrls = safeUrls.filter((targetUrl) => !results.has(targetUrl));
      const cached = await readChromiumCachedHtmlBatch(cacheRoot, pendingUrls, renderedLimit);
      for (const [targetUrl, html] of cached) {
        if (isBrowserChallengeHtml(html)) {
          challengeUrls.add(targetUrl);
          firstChallengeAt ??= Date.now();
        } else {
          results.set(targetUrl, html);
        }
      }
      if (results.size === safeUrls.length) return results;
      if (firstChallengeAt && Date.now() - firstChallengeAt >= Math.min(10_000, Math.max(timeoutMs - 2_000, 3_000))) {
        throw new BrowserVerificationRequiredError([...challengeUrls][0] ?? safeUrl);
      }
      if (exitCode !== undefined) {
        throw new Error(`普通浏览器提前退出${exitCode === null ? '' : `（退出码 ${exitCode}）`}。请先关闭仍在运行的专用验证窗口后重试。`);
      }
      await delay(200);
    }
    if (challengeUrls.size > 0) throw new BrowserVerificationRequiredError([...challengeUrls][0] ?? safeUrl);
    throw new Error(`等待普通浏览器缓存超时（${timeoutMs}ms）。请确认专用验证窗口已关闭后重试。`);
  } finally {
    await stopOwnedBrowser(child);
    await rm(cacheRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}

export async function renderHtmlBatchWithBrowser(urls: string[], options: FetchOptions): Promise<Map<string, string>> {
  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length === 0 || uniqueUrls.length > 5) throw new Error('普通浏览器批量读取每次只允许 1–5 个页面。');
  if (options.browserRendering === false) throw new Error('浏览器渲染已关闭。');
  if (!hasDesktopSession()) throw new Error('当前环境没有可用于普通浏览器缓存读取的桌面会话。');
  const resolved = await Promise.all(uniqueUrls.map((url) => resolveSafeRemoteUrl(url, options.timeoutMs, options.proxy)));
  const first = resolved[0];
  if (!first) throw new Error('没有可供普通浏览器读取的 URL。');
  const origin = new URL(first.url).origin;
  if (resolved.some((item) => new URL(item.url).origin !== origin)) throw new Error('普通浏览器批量读取只允许同源页面。');
  const executable = await findBrowserExecutable(options.browserExecutable);
  if (!executable) throw new Error('未找到 Chrome、Edge、Chromium 或 Brave；可在 codeNovel.browserExecutable 中手动指定。');
  if (!options.browserDataDirectory) throw new Error('浏览器隔离数据目录尚未初始化。');
  const profile = siteProfileDirectory(options.browserDataDirectory, first.url);
  await mkdir(profile, { recursive: true });
  return queued(() => withBrowserRoute(options, async (route) => {
    options.onProgress?.(`正在启动隔离浏览器批量读取 ${resolved.length} 个页面...`);
    const timeoutMs = Math.min(Math.max(options.browserTimeoutMs ?? options.timeoutMs, 12_000), 60_000);
    const renderedLimit = Math.min(options.maxBytes ?? maxRenderedBytes, maxRenderedBytes);
    try {
      const rendered = await renderFromNormalBrowserCache(
        executable,
        resolved.map((item) => item.url),
        first.address,
        profile,
        path.join(options.browserDataDirectory!, 'capture-cache'),
        timeoutMs,
        renderedLimit,
        route
      );
      normalBrowserPreferredUntil.set(new URL(first.url).hostname.toLowerCase(), Date.now() + normalBrowserPreferenceLifetimeMs);
      return rendered;
    } catch (error) {
      if (error instanceof BrowserVerificationRequiredError && await hasRecentVerificationAttempt(profile)) {
        throw new BrowserAutomationBlockedError(error.url);
      }
      throw error;
    }
  }));
}

export async function renderHtmlWithBrowser(url: string, options: FetchOptions): Promise<string> {
  const resolved = await resolveSafeRemoteUrl(url, options.timeoutMs, options.proxy);
  const safeUrl = resolved.url;
  if (options.browserRendering === false) throw new Error('浏览器渲染已关闭。');
  const executable = await findBrowserExecutable(options.browserExecutable);
  if (!executable) {
    throw new Error('未找到 Chrome、Edge、Chromium 或 Brave；可在 codeNovel.browserExecutable 中手动指定。');
  }
  if (!options.browserDataDirectory) throw new Error('浏览器隔离数据目录尚未初始化。');
  const profile = siteProfileDirectory(options.browserDataDirectory, safeUrl);
  await mkdir(profile, { recursive: true });
  return queued(() => withBrowserRoute(options, async (route) => {
    const timeoutMs = Math.min(Math.max(options.browserTimeoutMs ?? options.timeoutMs, 12_000), 60_000);
    const renderedLimit = Math.min(options.maxBytes ?? maxRenderedBytes, maxRenderedBytes);
    const host = new URL(safeUrl).hostname.toLowerCase();
    const renderNormal = async (): Promise<string> => {
      options.onProgress?.('正在启动隔离浏览器读取页面...');
      const rendered = await renderFromNormalBrowserCache(
        executable,
        [safeUrl],
        resolved.address,
        profile,
        path.join(options.browserDataDirectory!, 'capture-cache'),
        timeoutMs,
        renderedLimit,
        route
      );
      const html = rendered.get(safeUrl);
      if (!html) throw new Error('普通浏览器缓存中没有找到目标页面。');
      normalBrowserPreferredUntil.set(host, Date.now() + normalBrowserPreferenceLifetimeMs);
      return html;
    };

    if ((normalBrowserPreferredUntil.get(host) ?? 0) > Date.now() && hasDesktopSession()) {
      try {
        return await renderNormal();
      } catch (error) {
        normalBrowserPreferredUntil.delete(host);
        if (error instanceof BrowserVerificationRequiredError) {
          if (await hasRecentVerificationAttempt(profile)) throw new BrowserAutomationBlockedError(safeUrl);
          throw error;
        }
        // A transient normal-browser failure can still recover through headless mode.
      }
    }
    options.onProgress?.('正在尝试无头浏览器读取页面...');
    try {
      return await renderHeadlessHtml(executable, safeUrl, resolved.address, profile, timeoutMs, renderedLimit, route);
    } catch (error) {
      if (!(error instanceof BrowserVerificationRequiredError) || !hasDesktopSession()) throw error;
      try {
        return await renderNormal();
      } catch (cacheError) {
        if (cacheError instanceof BrowserVerificationRequiredError) {
          if (await hasRecentVerificationAttempt(profile)) throw new BrowserAutomationBlockedError(safeUrl);
          throw error;
        }
        throw cacheError;
      }
    }
  }));
}

export async function startVerificationBrowser(url: string, options: FetchOptions): Promise<void> {
  const resolved = await resolveSafeRemoteUrl(url, options.timeoutMs, options.proxy);
  const safeUrl = resolved.url;
  const executable = await findBrowserExecutable(options.browserExecutable);
  if (!executable) throw new Error('未找到可用于验证的 Chrome、Edge、Chromium 或 Brave。');
  if (!options.browserDataDirectory) throw new Error('浏览器隔离数据目录尚未初始化。');
  const profile = siteProfileDirectory(options.browserDataDirectory, safeUrl);
  await mkdir(profile, { recursive: true });
  const route = await createBrowserRoute(options);
  verificationRoutes.add(route);
  const args = [
    ...browserIsolationArguments, ...browserNetworkArgs(route, safeUrl, resolved.address), `--user-data-dir=${profile}`, '--new-window'
  ];
  args.push(safeUrl);
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: false, detached: true });
  const stopRoute = () => { verificationRoutes.delete(route); void route.close(); };
  child.once('exit', stopRoute);
  child.once('error', stopRoute);
  const lifetime = setTimeout(stopRoute, verificationAttemptLifetimeMs);
  lifetime.unref();
  child.once('exit', () => clearTimeout(lifetime));
  child.once('error', () => clearTimeout(lifetime));
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
  await writeFile(verificationAttemptPath(profile), new Date().toISOString(), 'utf8');
}
