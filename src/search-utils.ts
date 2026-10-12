import { SearchResult } from './model';

export function filterSearchProviders<T extends { name: string }>(providers: T[], names?: string[]): T[] {
  return names === undefined ? providers : providers.filter((provider) => names.includes(provider.name));
}

export function groupSearchResults(results: SearchResult[], keyword: string): SearchResult[][] {
  const groups = new Map<string, SearchResult[]>();
  const normalize = (value: string) => value.normalize('NFKC').replace(/[\s《》]/g, '').toLowerCase();
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    const key = `${normalize(result.title)}:${normalize(result.author ?? '')}`;
    const group = groups.get(key) ?? [];
    group.push(result);
    groups.set(key, group);
  }
  const query = normalize(keyword);
  return [...groups.values()].sort((a, b) => {
    const rank = (item: SearchResult) => normalize(item.title) === query ? 0 : normalize(item.title).includes(query) ? 1 : 2;
    return rank(a[0]!) - rank(b[0]!);
  });
}
