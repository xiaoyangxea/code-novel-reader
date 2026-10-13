import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Summarize the selected run, never inject historical findings or test counts.
const outputName = process.argv.find((arg) => arg.startsWith('--report='))?.slice(9) ?? 'search-matrix-latest.json';
if (!/^[\w.-]+\.json$/.test(outputName)) throw new Error('Invalid report filename');
const output = path.resolve('.vscode-test', outputName);
const report = JSON.parse(await readFile(output, 'utf8'));
report.scope = { network: 'See this run\'s proxyDetected field; no proxy credentials recorded.',
  probesPerQuery: report.maxProbes, browserRenderingInMatrix: report.browserRendering,
  limitations: ['Only a bounded set of ranked candidates was probed.', 'No login, captcha solving, paid chapter access or full-book downloading.',
    'Search hits and fetched text are not by themselves proof of the original work or an untruncated chapter.'] };
report.finalSummary = { inputs: report.queries.length,
  withRelatedCandidates: report.queries.filter((item) => item.candidateCount > 0).length,
  withAnyMatchingCatalog: report.queries.filter((item) => item.catalogMatched).length,
  withAnyFetchedChapter: report.queries.filter((item) => item.readable).length,
  originalConfirmedQueries: report.queries.filter((item) => item.originalConfirmed).map((item) => item.keyword),
  strictPassedQueries: report.auditSummary?.strictPass,
  negativeControlPassed: report.summary?.negativeControlPassed };
await writeFile(output, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report.finalSummary, report: output }));
