import { templateExtras } from './template-extras';

export interface ReadingTemplate {
  readonly id: string;
  readonly label: string;
  readonly prefix: string;
  readonly suffix: string;
}

// These strings are display-only. They are never evaluated or imported as code.
function template(id: string, label: string, prefix: string, suffix: string): ReadingTemplate {
  return Object.freeze({ id, label, prefix: prefix.trim(),
    suffix: suffix.trimEnd() + '\n\n' + (templateExtras[id] ?? '').trim() });
}

export const readingTemplates: readonly ReadingTemplate[] = Object.freeze([
  template('diagnostics', '诊断分析', `
interface DiagnosticItem {
  readonly code: string;
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error';
}

interface ParseContext {
  readonly source: string;
  readonly revision: number;
  readonly diagnostics: readonly DiagnosticItem[];
}

export function collectDiagnostics(context: ParseContext): DiagnosticItem[] {
  const diagnostics = [...context.diagnostics];
`, `

  return diagnostics.filter(isActionable);
}

function isActionable(item: DiagnosticItem): boolean {
  if (!item.code.trim()) return false;
  if (!item.message.trim()) return false;
  return item.severity !== 'info';
}

export class DiagnosticRegistry {
  private readonly entries = new Map<string, DiagnosticItem[]>();

  update(context: ParseContext): number {
    const items = collectDiagnostics(context);
    this.entries.set(context.source, items);
    return items.length;
  }

  get(source: string): readonly DiagnosticItem[] {
    return this.entries.get(source) ?? [];
  }

  clear(source?: string): void {
    if (source !== undefined) this.entries.delete(source);
    else this.entries.clear();
  }

  snapshot(): ReadonlyMap<string, readonly DiagnosticItem[]> {
    return new Map(this.entries);
  }
}

export function summarizeDiagnostics(items: readonly DiagnosticItem[]) {
  return {
    errors: items.filter((item) => item.severity === 'error').length,
    warnings: items.filter((item) => item.severity === 'warning').length,
    total: items.length
  };
}
`),
  template('requests', '请求处理', `
interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface ResponseEnvelope {
  readonly status: number;
  readonly body: unknown;
}

export function dispatchRequest(request: RequestContext): ResponseEnvelope {
  const method = request.method.toUpperCase();
`, `

  if (!request.path.startsWith('/')) return { status: 400, body: null };
  if (method === 'OPTIONS') return { status: 204, body: null };
  return { status: 200, body: { route: request.path, method } };
}

type Middleware = (request: RequestContext) => RequestContext;

export class RequestRouter {
  private readonly middleware: Middleware[] = [];
  private readonly routes = new Map<string, (request: RequestContext) => ResponseEnvelope>();

  use(handler: Middleware): this {
    this.middleware.push(handler);
    return this;
  }

  register(path: string, handler: (request: RequestContext) => ResponseEnvelope): void {
    if (this.routes.has(path)) throw new Error('Duplicate route');
    this.routes.set(path, handler);
  }

  handle(request: RequestContext): ResponseEnvelope {
    const normalized = this.middleware.reduce((value, handler) => handler(value), request);
    const handler = this.routes.get(normalized.path);
    return handler ? handler(normalized) : dispatchRequest(normalized);
  }

  paths(): string[] {
    return [...this.routes.keys()].sort();
  }
}

export function normalizeRequest(request: RequestContext): RequestContext {
  return {
    ...request,
    method: request.method.trim().toUpperCase(),
    path: request.path.replace(/\\/{2,}/g, '/')
  };
}
`),
  template('cache', '缓存管理', `
interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

interface CacheOptions {
  readonly capacity: number;
  readonly ttlMs: number;
}

export function readCache<T>(entry: CacheEntry<T> | undefined, now: number): T | undefined {
  const expired = !entry || entry.expiresAt <= now;
`, `

  return expired ? undefined : entry?.value;
}

export class MemoryCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly options: CacheOptions) {
    if (options.capacity < 1 || options.ttlMs < 1) throw new Error('Invalid cache options');
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    const value = readCache(entry, now);
    if (value === undefined) this.entries.delete(key);
    else if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return value;
  }

  set(key: string, value: T, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.options.ttlMs });
    while (this.entries.size > this.options.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  prune(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }
}
`),
  template('scheduler', '任务调度', `
interface ScheduledTask {
  readonly id: string;
  readonly priority: number;
  readonly run: () => Promise<void>;
}

interface ScheduleContext {
  readonly cancelled: boolean;
  readonly tasks: readonly ScheduledTask[];
}

export function selectTasks(context: ScheduleContext): ScheduledTask[] {
  const pending = [...context.tasks];
`, `

  if (context.cancelled) return [];
  return pending.sort((left, right) => left.priority - right.priority);
}

export class TaskScheduler {
  private readonly pending = new Map<string, ScheduledTask>();
  private running = false;
  private stopped = false;

  enqueue(task: ScheduledTask): void {
    if (this.stopped) throw new Error('Scheduler stopped');
    this.pending.set(task.id, task);
  }

  async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (this.pending.size && !this.stopped) {
        const [task] = selectTasks({ cancelled: false, tasks: [...this.pending.values()] });
        if (!task) break;
        this.pending.delete(task.id);
        await task.run();
      }
    } finally {
      this.running = false;
    }
  }

  cancel(id: string): boolean {
    return this.pending.delete(id);
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
`),
  template('configuration', '配置校验', `
interface ServiceConfig {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly retries: number;
}

interface ConfigIssue {
  readonly field: keyof ServiceConfig;
  readonly message: string;
}

export function validateConfig(config: ServiceConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
`, `

  if (!config.endpoint.trim()) issues.push({ field: 'endpoint', message: 'Required' });
  if (config.timeoutMs < 100) issues.push({ field: 'timeoutMs', message: 'Too small' });
  if (!Number.isInteger(config.retries) || config.retries < 0) {
    issues.push({ field: 'retries', message: 'Expected a nonnegative integer' });
  }
  return issues;
}

export class ConfigStore {
  private revision = 0;
  private readonly listeners = new Set<(config: ServiceConfig) => void>();

  constructor(private current: ServiceConfig) {}

  read(): Readonly<ServiceConfig> {
    return { ...this.current };
  }

  replace(config: ServiceConfig): void {
    const issues = validateConfig(config);
    if (issues.length) throw new Error(issues.map((item) => item.message).join('; '));
    this.current = { ...config };
    this.revision += 1;
    for (const listener of this.listeners) listener(this.read());
  }

  subscribe(listener: (config: ServiceConfig) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  version(): number {
    return this.revision;
  }
}

export function defaultConfig(): ServiceConfig {
  return { endpoint: '/api', timeoutMs: 5000, retries: 2 };
}
`),
  template('transform', '数据转换', `
interface DataRecord {
  readonly id: string;
  readonly value: string;
  readonly tags: readonly string[];
}

interface TransformOptions {
  readonly trim: boolean;
  readonly lowercase: boolean;
}

export function transformRecord(record: DataRecord, options: TransformOptions): DataRecord {
  let value = record.value;
`, `

  if (options.trim) value = value.trim();
  if (options.lowercase) value = value.toLowerCase();
  return { ...record, value, tags: [...new Set(record.tags)] };
}

type RecordTransform = (record: DataRecord) => DataRecord;

export class TransformPipeline {
  private readonly stages: RecordTransform[] = [];

  append(transform: RecordTransform): this {
    this.stages.push(transform);
    return this;
  }

  process(record: DataRecord): DataRecord {
    return this.stages.reduce((value, transform) => transform(value), record);
  }

  processAll(records: readonly DataRecord[]): DataRecord[] {
    const seen = new Set<string>();
    const output: DataRecord[] = [];
    for (const record of records) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      output.push(this.process(record));
    }
    return output;
  }

  reset(): void {
    this.stages.length = 0;
  }
}

export function groupByTag(records: readonly DataRecord[]): Map<string, DataRecord[]> {
  const groups = new Map<string, DataRecord[]>();
  for (const record of records) {
    for (const tag of record.tags) groups.set(tag, [...(groups.get(tag) ?? []), record]);
  }
  return groups;
}
`),
  template('events', '事件总线', `
interface DomainEvent {
  readonly type: string;
  readonly timestamp: number;
  readonly payload: unknown;
}

type EventListener = (event: DomainEvent) => void;
type ListenerRegistry = Map<string, Set<EventListener>>;

export function dispatchEvent(registry: ListenerRegistry, event: DomainEvent): number {
  const listeners = [...(registry.get(event.type) ?? [])];
`, `

  for (const listener of listeners) listener(event);
  return listeners.length;
}

export class EventBus {
  private readonly registry: ListenerRegistry = new Map();

  on(type: string, listener: EventListener): () => void {
    const listeners = this.registry.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.registry.set(type, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.registry.delete(type);
    };
  }

  once(type: string, listener: EventListener): () => void {
    const remove = this.on(type, (event) => {
      remove();
      listener(event);
    });
    return remove;
  }

  emit(type: string, payload: unknown): number {
    return dispatchEvent(this.registry, { type, payload, timestamp: Date.now() });
  }

  count(type: string): number {
    return this.registry.get(type)?.size ?? 0;
  }

  clear(type?: string): void {
    if (type) this.registry.delete(type);
    else this.registry.clear();
  }
}

export function createEventBus(): EventBus {
  return new EventBus();
}
`),
  template('state', '状态管理', `
interface ApplicationState {
  readonly ready: boolean;
  readonly revision: number;
  readonly items: readonly string[];
}

type StateAction =
  | { readonly type: 'ready' }
  | { readonly type: 'append'; readonly value: string }
  | { readonly type: 'reset' };

export function reduceState(state: ApplicationState, action: StateAction): ApplicationState {
  const revision = state.revision + 1;
`, `

  switch (action.type) {
    case 'ready': return { ...state, ready: true, revision };
    case 'append': return { ...state, items: [...state.items, action.value], revision };
    case 'reset': return { ready: false, items: [], revision };
  }
}

export class StateStore {
  private state: ApplicationState = { ready: false, revision: 0, items: [] };
  private readonly listeners = new Set<(state: ApplicationState) => void>();

  dispatch(action: StateAction): void {
    this.state = reduceState(this.state, action);
    for (const listener of this.listeners) listener(this.snapshot());
  }

  snapshot(): ApplicationState {
    return { ...this.state, items: [...this.state.items] };
  }

  select<T>(selector: (state: ApplicationState) => T): T {
    return selector(this.snapshot());
  }

  subscribe(listener: (state: ApplicationState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export function selectItemCount(state: ApplicationState): number {
  return state.items.length;
}
`),
  template('logging', '日志采集', `
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: number;
  readonly context: Readonly<Record<string, string>>;
}

export function formatLog(entry: LogEntry): string {
  const timestamp = new Date(entry.timestamp).toISOString();
`, `

  const fields = Object.entries(entry.context).map(([key, value]) => key + '=' + value);
  return [timestamp, entry.level.toUpperCase(), entry.message, ...fields].join(' ');
}

export class BufferedLogger {
  private readonly buffer: LogEntry[] = [];
  private dropped = 0;

  constructor(private readonly capacity = 200) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid capacity');
  }

  write(level: LogLevel, message: string, context: Record<string, string> = {}): void {
    this.buffer.push({ level, message, context: { ...context }, timestamp: Date.now() });
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
      this.dropped += 1;
    }
  }

  flush(): string[] {
    const result = this.buffer.map(formatLog);
    this.buffer.length = 0;
    return result;
  }

  snapshot(): readonly LogEntry[] {
    return this.buffer.map((entry) => ({ ...entry, context: { ...entry.context } }));
  }

  statistics() {
    return { buffered: this.buffer.length, dropped: this.dropped };
  }

  clear(): void {
    this.buffer.length = 0;
    this.dropped = 0;
  }
}

export function createLogger(): BufferedLogger {
  return new BufferedLogger(200);
}
`),
  template('retry', '重试策略', `
interface RetryPolicy {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

interface RetryState {
  readonly attempt: number;
  readonly cancelled: boolean;
}

export function retryDelay(policy: RetryPolicy, state: RetryState): number | undefined {
  const exponent = Math.max(state.attempt - 1, 0);
`, `

  if (state.cancelled || state.attempt >= policy.attempts) return undefined;
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  isCancelled: () => boolean = () => false
): Promise<T> {
  let attempt = 0;
  while (true) {
    if (isCancelled()) throw new Error('Operation cancelled');
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      const delay = retryDelay(policy, { attempt, cancelled: isCancelled() });
      if (delay === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

export class RetryBudget {
  private remaining: number;

  constructor(private readonly capacity: number) {
    this.remaining = Math.max(0, capacity);
  }

  consume(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    return true;
  }

  reset(): void {
    this.remaining = Math.max(0, this.capacity);
  }

  available(): number {
    return this.remaining;
  }
}
`),
  template('plugins', '插件注册', `
interface RuntimePlugin {
  readonly id: string;
  readonly dependencies: readonly string[];
  activate(): void;
  dispose(): void;
}

type PluginRegistry = ReadonlyMap<string, RuntimePlugin>;

export function resolvePlugins(registry: PluginRegistry): RuntimePlugin[] {
  const ordered: RuntimePlugin[] = [];
`, `

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('Circular dependency');
    const plugin = registry.get(id);
    if (!plugin) throw new Error('Missing plugin: ' + id);
    visiting.add(id);
    for (const dependency of plugin.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(plugin);
  };
  for (const id of registry.keys()) visit(id);
  return ordered;
}

export class PluginHost {
  private readonly registry = new Map<string, RuntimePlugin>();
  private active: RuntimePlugin[] = [];

  register(plugin: RuntimePlugin): void {
    if (this.registry.has(plugin.id)) throw new Error('Duplicate plugin');
    this.registry.set(plugin.id, plugin);
  }

  start(): void {
    if (this.active.length) return;
    for (const plugin of resolvePlugins(this.registry)) {
      plugin.activate();
      this.active.push(plugin);
    }
  }

  stop(): void {
    for (const plugin of this.active.reverse()) plugin.dispose();
    this.active = [];
  }

  list(): string[] {
    return [...this.registry.keys()];
  }
}
`),
  template('dependencies', '依赖注入', `
type ServiceFactory = (container: ServiceContainer) => unknown;

interface ServiceBinding {
  readonly factory: ServiceFactory;
  readonly singleton: boolean;
}

export function resolveService(container: ServiceContainer, token: string): unknown {
  const binding = container.binding(token);
`, `

  if (!binding) throw new Error('Unregistered service: ' + token);
  return binding.factory(container);
}

export class ServiceContainer {
  private readonly bindings = new Map<string, ServiceBinding>();
  private readonly instances = new Map<string, unknown>();
  private readonly resolving = new Set<string>();

  register(token: string, factory: ServiceFactory, singleton = true): this {
    if (this.bindings.has(token)) throw new Error('Duplicate binding');
    this.bindings.set(token, { factory, singleton });
    return this;
  }

  binding(token: string): ServiceBinding | undefined {
    return this.bindings.get(token);
  }

  get(token: string): unknown {
    if (this.instances.has(token)) return this.instances.get(token);
    if (this.resolving.has(token)) throw new Error('Circular service dependency');
    this.resolving.add(token);
    try {
      const instance = resolveService(this, token);
      if (this.bindings.get(token)?.singleton) this.instances.set(token, instance);
      return instance;
    } finally {
      this.resolving.delete(token);
    }
  }

  has(token: string): boolean {
    return this.bindings.has(token);
  }

  resetInstances(): void {
    this.instances.clear();
  }
}

export function createContainer(): ServiceContainer {
  return new ServiceContainer();
}
`),
  template('files', '文件索引', `
interface IndexedFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

interface FileQuery {
  readonly prefix: string;
  readonly minimumSize: number;
}

export function queryFiles(files: readonly IndexedFile[], query: FileQuery): IndexedFile[] {
  const prefix = query.prefix.toLowerCase();
`, `

  return files.filter((file) => file.path.toLowerCase().startsWith(prefix)
    && file.size >= query.minimumSize).sort((left, right) => left.path.localeCompare(right.path));
}

export class FileIndex {
  private readonly files = new Map<string, IndexedFile>();
  private revision = 0;

  update(file: IndexedFile): void {
    if (file.size < 0) throw new Error('Invalid file size');
    this.files.set(file.path, { ...file });
    this.revision += 1;
  }

  remove(path: string): boolean {
    const removed = this.files.delete(path);
    if (removed) this.revision += 1;
    return removed;
  }

  search(query: FileQuery): IndexedFile[] {
    return queryFiles([...this.files.values()], query);
  }

  totalBytes(): number {
    return [...this.files.values()].reduce((total, file) => total + file.size, 0);
  }

  snapshot() {
    return { revision: this.revision, files: [...this.files.values()] };
  }

  clear(): void {
    this.files.clear();
    this.revision += 1;
  }
}

export function createFileIndex(): FileIndex {
  return new FileIndex();
}
`),
  template('search', '搜索管线', `
interface SearchDocument {
  readonly id: string;
  readonly title: string;
  readonly terms: readonly string[];
}

interface SearchHit {
  readonly document: SearchDocument;
  readonly score: number;
}

export function scoreDocument(document: SearchDocument, terms: readonly string[]): number {
  const title = document.title.toLowerCase();
`, `

  return terms.reduce((score, term) => score
    + (title === term ? 10 : title.includes(term) ? 3 : 0)
    + (document.terms.includes(term) ? 1 : 0), 0);
}

export class SearchIndex {
  private readonly documents = new Map<string, SearchDocument>();

  add(document: SearchDocument): void {
    this.documents.set(document.id, {
      ...document,
      terms: document.terms.map((term) => term.toLowerCase())
    });
  }

  search(query: string, limit = 20): SearchHit[] {
    const terms = [...new Set(query.toLowerCase().split(/\\s+/).filter(Boolean))];
    if (!terms.length) return [];
    return [...this.documents.values()]
      .map((document) => ({ document, score: scoreDocument(document, terms) }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, limit));
  }

  remove(id: string): boolean {
    return this.documents.delete(id);
  }

  clear(): void {
    this.documents.clear();
  }

  get size(): number {
    return this.documents.size;
  }
}

export function createSearchIndex(): SearchIndex {
  return new SearchIndex();
}
`),
  template('metrics', '性能统计', `
interface TimingSample {
  readonly operation: string;
  readonly durationMs: number;
}

interface TimingSummary {
  readonly count: number;
  readonly mean: number;
  readonly maximum: number;
}

export function summarizeTimings(samples: readonly TimingSample[]): TimingSummary {
  const durations = samples.map((sample) => sample.durationMs);
`, `

  if (!durations.length) return { count: 0, mean: 0, maximum: 0 };
  const total = durations.reduce((sum, value) => sum + value, 0);
  return { count: durations.length, mean: total / durations.length,
    maximum: durations.reduce((max, value) => Math.max(max, value), 0) };
}

export class PerformanceTracker {
  private readonly samples: TimingSample[] = [];

  constructor(private readonly capacity = 500) {}

  record(operation: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.samples.push({ operation, durationMs });
    while (this.samples.length > Math.max(1, this.capacity)) this.samples.shift();
  }

  async measure<T>(operation: string, task: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await task();
    } finally {
      this.record(operation, performance.now() - started);
    }
  }

  summary(operation?: string): TimingSummary {
    return summarizeTimings(this.samples.filter((sample) => !operation || sample.operation === operation));
  }

  operations(): string[] {
    return [...new Set(this.samples.map((sample) => sample.operation))].sort();
  }

  clear(): void {
    this.samples.length = 0;
  }
}

export function createTracker(): PerformanceTracker {
  return new PerformanceTracker();
}
`),
  template('batch', '批处理队列', `
interface BatchOptions {
  readonly size: number;
  readonly stopOnError: boolean;
}

interface BatchResult<T> {
  readonly completed: T[];
  readonly errors: unknown[];
}

export function splitBatches<T>(items: readonly T[], options: BatchOptions): T[][] {
  const batches: T[][] = [];
`, `

  const size = Math.max(1, Math.floor(options.size));
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export async function processBatches<T, R>(
  items: readonly T[],
  process: (item: T) => Promise<R>,
  options: BatchOptions
): Promise<BatchResult<R>> {
  const completed: R[] = [];
  const errors: unknown[] = [];
  for (const batch of splitBatches(items, options)) {
    for (const item of batch) {
      try {
        completed.push(await process(item));
      } catch (error) {
        errors.push(error);
        if (options.stopOnError) return { completed, errors };
      }
    }
  }
  return { completed, errors };
}

export class BatchQueue<T> {
  private readonly items: T[] = [];

  append(items: readonly T[]): void {
    this.items.push(...items);
  }

  take(size: number): T[] {
    return this.items.splice(0, Math.max(0, Math.floor(size)));
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}
`)
]);

export function readingTemplate(id?: string): ReadingTemplate {
  return readingTemplates.find((item) => item.id === id) ?? readingTemplates[0]!;
}
