export function downloadIndexes(input: string, total: number): number[] {
  const match = input.trim().match(/^(\d+)\s*(?:[-–]\s*(\d+))?$/);
  const start = Number(match?.[1]);
  const end = Number(match?.[2] ?? match?.[1]);
  if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > total || end - start >= 20_000) {
    throw new Error(`范围无效，请输入 1-${total} 内的章节序号或区间。`);
  }
  return Array.from({ length: end - start + 1 }, (_, offset) => start - 1 + offset);
}

export function safeExportName(title: string): string {
  const name = title.replace(/[\u0000-\u001f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
  return !name || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ? `novel_${name}` : name;
}
