export interface FileVersion {
  mtimeMs: number;
  size: number;
}

export interface MappedFileCacheOptions<T> {
  maxEntries: number;
  version: (filePath: string) => Promise<FileVersion>;
  load: (filePath: string) => Promise<T>;
  validate: (loaded: unknown, filePath: string) => T;
}

export function fileVersionKey(version: FileVersion): string {
  return `${version.mtimeMs}-${version.size}`;
}

export class MappedFileCache<T> {
  private readonly entries = new Map<string, { versionKey: string; value: T }>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly options: MappedFileCacheOptions<T>;

  constructor(options: MappedFileCacheOptions<T>) {
    this.options = options;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  async get(filePath: string): Promise<T> {
    const version = await this.options.version(filePath);
    const versionKey = fileVersionKey(version);
    const cached = this.entries.get(filePath);
    if (cached && cached.versionKey === versionKey) {
      this.entries.delete(filePath);
      this.entries.set(filePath, cached);
      return cached.value;
    }
    if (cached) this.entries.delete(filePath);
    const pending = this.inFlight.get(filePath);
    if (pending) return pending;
    const loading = this.load(filePath, versionKey)
      .then((value) => {
        this.entries.delete(filePath);
        this.entries.set(filePath, { versionKey, value });
        while (this.entries.size > this.options.maxEntries) {
          const oldest = this.entries.keys().next();
          if (oldest.done) break;
          this.entries.delete(oldest.value);
        }
        return value;
      })
      .finally(() => {
        this.inFlight.delete(filePath);
      });
    this.inFlight.set(filePath, loading);
    return loading;
  }

  private async load(filePath: string, versionKey: string): Promise<T> {
    const loaded: unknown = await this.options.load(filePath);
    const value = this.options.validate(loaded, filePath);
    void versionKey;
    return value;
  }
}
