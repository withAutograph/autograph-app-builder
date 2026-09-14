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

export const runSequentiallyUntil = <T, R>(
  values: Iterable<T>,
  operation: (value: T) => Promise<R | undefined>,
): Promise<R | undefined> => {
  const entries = [...values];
  const run = async (index: number): Promise<R | undefined> => {
      if (index >= entries.length) {
        return;
      }
    const result = await operation(entries[index]);
    return result ?? run(index + 1);
  };
  return run(0);
};
