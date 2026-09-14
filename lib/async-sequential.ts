export const runSequentially = async <T>(
  values: Iterable<T>,
  operation: (value: T) => Promise<void>,
): Promise<void> => {
  const entries = [...values];
  const run = async (index: number): Promise<void> => {
    if (index >= entries.length) {
      return;
    }
    await operation(entries[index]);
    await run(index + 1);
  };
  await run(0);
};

export const runSequentiallyUntil = async <T, R>(
  values: Iterable<T>,
  operation: (value: T) => Promise<R | null>,
): Promise<R | null> => {
  const entries = [...values];
  const run = async (index: number): Promise<R | null> => {
    if (index >= entries.length) {
      return null;
    }
    const result = await operation(entries[index]);
    if (result !== null) {
      return result;
    }
    return await run(index + 1);
  };
  return await run(0);
};
