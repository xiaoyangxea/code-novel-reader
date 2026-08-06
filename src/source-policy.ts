import { NovelSource } from './model';

export function sourceAllowsUrl(source: NovelSource, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase();
    return source.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function requireSourceUrl(source: NovelSource, rawUrl: string): void {
  if (!sourceAllowsUrl(source, rawUrl)) {
    throw new Error(`书源“${source.name}”拒绝访问未声明的域名。`);
  }
}
