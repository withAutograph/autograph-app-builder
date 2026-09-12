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

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(transaction.error), {
      once: true,
    });
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
}

function defaultFactory() {
  return typeof indexedDB === "undefined" ? undefined : indexedDB;
}

/**
 * Saves only the newest unacknowledged snapshot. All operations are serialized
 * so a delayed older write can never overwrite a newer outbox entry.
 */
export function createBuilderDraftOutbox<T>(
  options: BuilderDraftOutboxOptions,
): BuilderDraftOutbox<T> {
  const factory = options.indexedDB === undefined ? defaultFactory() : options.indexedDB;
  let operations = Promise.resolve();

  function serial<Result>(operation: () => Promise<Result>): Promise<Result> {
    // This queue deliberately composes the next operation without awaiting it here.
    // oxlint-disable-next-line promise/prefer-await-to-then
    const result = operations.then(operation);
    // Keep the queue usable after either outcome.
    // oxlint-disable-next-line promise/prefer-await-to-then
    operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

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
    read: () =>
      serial(() =>
        withDatabase(
          async (database) => {
            const transaction = database.transaction(storeName, "readonly");
            const result = await requestResult(transaction.objectStore(storeName).get(options.key));
            await transactionResult(transaction);
            return result as BuilderDraftOutboxEntry<T> | undefined;
          },
          () => memoryFallback.get(options.key) as BuilderDraftOutboxEntry<T> | undefined,
        ),
      ),
    write: (entry) =>
      serial(() =>
        withDatabase(
          async (database) => {
            const transaction = database.transaction(storeName, "readwrite");
            transaction.objectStore(storeName).put(entry, options.key);
            await transactionResult(transaction);
          },
          () => {
            memoryFallback.set(options.key, entry);
          },
        ),
      ),
    clearIfMutationId: (mutationId) =>
      serial(() =>
        withDatabase(
          async (database) => {
            const transaction = database.transaction(storeName, "readwrite");
            const store = transaction.objectStore(storeName);
            const entry = (await requestResult(store.get(options.key))) as
              | BuilderDraftOutboxEntry<T>
              | undefined;
            const cleared = entry?.mutationId === mutationId;
            if (cleared) {
              store.delete(options.key);
            }
            await transactionResult(transaction);
            return cleared;
          },
          () => {
            const entry = memoryFallback.get(options.key) as BuilderDraftOutboxEntry<T> | undefined;
            if (entry?.mutationId !== mutationId) {
              return false;
            }
            memoryFallback.delete(options.key);
            return true;
          },
        ),
      ),
    clearIfAcknowledged: (acknowledgement) =>
      serial(() =>
        withDatabase(
          async (database) => {
            const transaction = database.transaction(storeName, "readwrite");
            const store = transaction.objectStore(storeName);
            const entry = (await requestResult(store.get(options.key))) as
              | BuilderDraftOutboxEntry<T>
              | undefined;
            const cleared = entry?.mutationId === acknowledgement.mutationId;
            if (cleared) {
              store.delete(options.key);
            }
            await transactionResult(transaction);
            return cleared;
          },
          () => {
            const entry = memoryFallback.get(options.key) as BuilderDraftOutboxEntry<T> | undefined;
            if (entry?.mutationId !== acknowledgement.mutationId) {
              return false;
            }
            memoryFallback.delete(options.key);
            return true;
          },
        ),
      ),
    clear: () =>
      serial(() =>
        withDatabase(
          async (database) => {
            const transaction = database.transaction(storeName, "readwrite");
            transaction.objectStore(storeName).delete(options.key);
            await transactionResult(transaction);
          },
          () => {
            memoryFallback.delete(options.key);
          },
        ),
      ),
  };
}
