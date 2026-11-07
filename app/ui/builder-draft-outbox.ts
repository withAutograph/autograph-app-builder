/**
 * A tiny, origin-scoped outbox for the latest builder edit which has not been
 * acknowledged by the server. IndexedDB is intentionally an implementation
 * detail: callers only deal in snapshots and mutation IDs.
 */

export interface BuilderDraftOutboxEntry<T> {
  version: 1;
  /** The authoritative revision on which this local edit was based. */
  baseRevision: number;
  mutationId: string;
  snapshot: T;
  createdAt: number;
}

export interface BuilderDraftOutbox<T> {
  read: () => Promise<BuilderDraftOutboxEntry<T> | undefined>;
  write: (entry: BuilderDraftOutboxEntry<T>) => Promise<void>;
  clearIfMutationId: (mutationId: string) => Promise<boolean>;
  /** Clears only the snapshot represented by this server acknowledgement. */
  clearIfAcknowledged?: (acknowledgement: {
    mutationId: string;
    revision: number;
  }) => Promise<boolean>;
  /** Drops a snapshot superseded by an authoritative server revision. */
  clear: () => Promise<void>;
}

export interface BuilderDraftOutboxOptions {
  /** Namespaces drafts in the browser origin. Include the draft ID in this key. */
  key: string;
  /** Injectable for tests and for WebViews that expose a non-global factory. */
  indexedDB?: IDBFactory | null;
}

const databaseName = "autograph-builder-draft-outbox";
const storeName = "pending";
const memoryFallback = new Map<string, unknown>();

const isBuilderDraftOutboxEntry = <T>(value: unknown): value is BuilderDraftOutboxEntry<T> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("version" in value) || value.version !== 1) {
    return false;
  }
  if (!("baseRevision" in value) || typeof value.baseRevision !== "number") {
    return false;
  }
  if (!("mutationId" in value) || typeof value.mutationId !== "string") {
    return false;
  }
  if (!("createdAt" in value) || typeof value.createdAt !== "number") {
    return false;
  }
  return "snapshot" in value;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, reject, resolve } = Promise.withResolvers<T>();
  request.addEventListener(
    "success",
    () => {
      resolve(request.result);
    },
    {
      once: true,
    },
  );
  request.addEventListener(
    "error",
    () => {
      reject(request.error);
    },
    {
      once: true,
    },
  );
  return await promise;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function transactionResult(transaction: IDBTransaction): Promise<undefined> {
  const { promise, reject, resolve } = Promise.withResolvers<undefined>();
  transaction.addEventListener(
    "complete",
    () => {
      resolve();
    },
    { once: true },
  );
  transaction.addEventListener(
    "abort",
    () => {
      reject(transaction.error);
    },
    {
      once: true,
    },
  );
  transaction.addEventListener(
    "error",
    () => {
      reject(transaction.error);
    },
    {
      once: true,
    },
  );
  await promise;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const { promise, reject, resolve } = Promise.withResolvers<IDBDatabase>();
  const request = factory.open(databaseName, 1);
  request.addEventListener(
    "upgradeneeded",
    () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName);
      }
    },
    { once: true },
  );
  request.addEventListener(
    "success",
    () => {
      resolve(request.result);
    },
    {
      once: true,
    },
  );
  request.addEventListener(
    "error",
    () => {
      reject(request.error);
    },
    {
      once: true,
    },
  );
  return await promise;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function defaultFactory() {
  return typeof indexedDB === "undefined" ? undefined : indexedDB;
}

/**
 * Saves only the newest unacknowledged snapshot. All operations are serialized
 * so a delayed older write can never overwrite a newer outbox entry.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createBuilderDraftOutbox<T>(
  options: BuilderDraftOutboxOptions,
): BuilderDraftOutbox<T> {
  const factory = options.indexedDB === undefined ? defaultFactory() : options.indexedDB;
  let operations: Promise<unknown> = Promise.resolve();

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function serial<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = operations;
    const { promise, resolve } = Promise.withResolvers<null>();
    operations = promise;
    await previous;
    try {
      return await operation();
    } finally {
      resolve();
    }
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function withDatabase<Result>(
    operation: (database: IDBDatabase) => Promise<Result>,
    fallback: () => Result,
  ): Promise<Result> {
    if (!factory) {
      return fallback();
    }
    try {
      const database = await openDatabase(factory);
      try {
        return await operation(database);
      } finally {
        database.close();
      }
    } catch {
      return fallback();
    }
  }

  return {
    clear: async () => {
      await serial(async () => {
        await withDatabase(
          async (database) => {
            const transaction = database.transaction(storeName, "readwrite");
            transaction.objectStore(storeName).delete(options.key);
            await transactionResult(transaction);
          },
          () => {
            memoryFallback.delete(options.key);
          },
        );
      });
    },
    clearIfAcknowledged: async (acknowledgement) =>
      await serial(
        async () =>
          await withDatabase(
            async (database) => {
              const transaction = database.transaction(storeName, "readwrite");
              const store = transaction.objectStore(storeName);
              const storedEntry: unknown = await requestResult(store.get(options.key));
              const entry = isBuilderDraftOutboxEntry<T>(storedEntry) ? storedEntry : undefined;
              const cleared = entry?.mutationId === acknowledgement.mutationId;
              if (cleared) {
                store.delete(options.key);
              }
              await transactionResult(transaction);
              return cleared;
            },
            () => {
              const storedEntry = memoryFallback.get(options.key);
              const entry = isBuilderDraftOutboxEntry<T>(storedEntry) ? storedEntry : undefined;
              if (entry?.mutationId !== acknowledgement.mutationId) {
                return false;
              }
              memoryFallback.delete(options.key);
              return true;
            },
          ),
      ),
    clearIfMutationId: async (mutationId) =>
      await serial(
        async () =>
          await withDatabase(
            async (database) => {
              const transaction = database.transaction(storeName, "readwrite");
              const store = transaction.objectStore(storeName);
              const storedEntry: unknown = await requestResult(store.get(options.key));
              const entry = isBuilderDraftOutboxEntry<T>(storedEntry) ? storedEntry : undefined;
              const cleared = entry?.mutationId === mutationId;
              if (cleared) {
                store.delete(options.key);
              }
              await transactionResult(transaction);
              return cleared;
            },
            () => {
              const storedEntry = memoryFallback.get(options.key);
              const entry = isBuilderDraftOutboxEntry<T>(storedEntry) ? storedEntry : undefined;
              if (entry?.mutationId !== mutationId) {
                return false;
              }
              memoryFallback.delete(options.key);
              return true;
            },
          ),
      ),
    read: async () =>
      await serial(
        async () =>
          await withDatabase(
            async (database) => {
              const transaction = database.transaction(storeName, "readonly");
              const result: unknown = await requestResult(
                transaction.objectStore(storeName).get(options.key),
              );
              await transactionResult(transaction);
              return isBuilderDraftOutboxEntry<T>(result) ? result : undefined;
            },
            () => {
              const result = memoryFallback.get(options.key);
              return isBuilderDraftOutboxEntry<T>(result) ? result : undefined;
            },
          ),
      ),
    write: async (entry) => {
      await serial(async () => {
        await withDatabase(
          async (database) => {
            const transaction = database.transaction(storeName, "readwrite");
            transaction.objectStore(storeName).put(entry, options.key);
            await transactionResult(transaction);
          },
          () => {
            memoryFallback.set(options.key, entry);
          },
        );
      });
    },
  };
}
