/* oxlint-disable eslint/no-await-in-loop, node/callback-return, react-doctor/async-await-in-loop, eslint/complexity, sonarjs/cognitive-complexity, eslint/no-control-regex -- JSON syntax and transport chunks must be consumed in order. */
/** Validate a streamed JSON document while retaining only selected string comparisons. */
export const readJsonStringChecks = async (
  body: ReadableStream<Uint8Array> | null,
  checks: readonly {
    pointer: string;
    expected?: string;
    expectedLiteral?: "true" | "false";
    optional?: boolean;
    capture?: boolean;
  }[],
  options: { allowedRootKeys?: readonly string[] } = {},
): Promise<{ matches: boolean[]; values: (string | undefined)[] }> => {
  if (
    !body ||
    checks.length === 0 ||
    checks.some(({ pointer }) => !pointer.startsWith("/") || /~[^01]/u.test(pointer))
  ) {
    throw new Error("Invalid JSON readback input.");
  }
  const paths = checks.map(({ pointer }) =>
    pointer
      .slice(1)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")),
  );
  const longestPointer = Math.max(...checks.map(({ pointer }) => pointer.length));
  const allowedRootKeys =
    options.allowedRootKeys === undefined ? undefined : new Set(options.allowedRootKeys);
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let position = 0;
  let ended = false;
  const matched = checks.map(({ optional }) => optional === true);
  const values: (string | undefined)[] = Array.from({ length: checks.length });
  const next = async (): Promise<string | undefined> => {
    while (position >= text.length && !ended) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A stream must be consumed in order.
      const chunk = await reader.read();
      text = decoder.decode(chunk.value, { stream: !chunk.done });
      position = 0;
      ended = chunk.done;
    }
    return text[position];
  };
  const take = async (): Promise<string | undefined> => {
    const character = await next();
    if (character !== undefined) {
      position += 1;
    }
    return character;
  };
  const whitespace = async (): Promise<void> => {
    while (/^[\t\n\r ]$/u.test((await next()) ?? "")) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Consume whitespace one character at a time.
      await take();
    }
  };
  const requireCharacter = async (character: string): Promise<void> => {
    if ((await take()) !== character) {
      throw new Error("Invalid JSON response.");
    }
  };
  const string = async (
    compare?: string,
    capture = false,
  ): Promise<{ value: string; equal: boolean; nonempty: boolean }> => {
    await requireCharacter('"');
    let value = "";
    let equal = compare !== undefined;
    let index = 0;
    for (;;) {
      // Skip ordinary string content in one step. Large app fields must not
      // require one Promise allocation per character or enter the output heap.
      // oxlint-disable-next-line eslint(no-control-regex) -- JSON control characters require validation.
      const ordinary = /^[^"\\\u0000-\u001F]+/u.exec(text.slice(position));
      if (ordinary?.[0] !== undefined && ordinary[0] !== "") {
        const [content] = ordinary;
        if (compare !== undefined && content !== compare.slice(index, index + content.length)) {
          equal = false;
        }
        const retainedLength = capture ? 4096 : longestPointer;
        if (value.length <= retainedLength) {
          value += content.slice(0, retainedLength + 1 - value.length);
        }
        index += content.length;
        position += content.length;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Consume a JSON string in order.
      let character = await take();
      if (character === undefined) {
        throw new Error("Incomplete JSON string.");
      }
      if (character === '"') {
        if (capture && index > 4096) {
          throw new Error("Provider metadata display name exceeds safe length.");
        }
        return { equal: equal && index === compare?.length, nonempty: index > 0, value };
      }
      if (character === "\\") {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Consume the escape sequence.
        const escapedCharacter = await take();
        if (escapedCharacter === "u") {
          let hex = "";
          for (let count = 0; count < 4; count += 1) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Read four hexadecimal digits.
            const digit = await take();
            if (digit === undefined || !/^[0-9a-f]$/iu.test(digit)) {
              throw new Error("Invalid JSON Unicode escape.");
            }
            hex += digit;
          }
          character = String.fromCodePoint(Number.parseInt(hex, 16));
        } else {
          const escapes = new Map([
            ['"', '"'],
            ["/", "/"],
            ["\\", "\\"],
            ["b", "\b"],
            ["f", "\f"],
            ["n", "\n"],
            ["r", "\r"],
            ["t", "\t"],
          ]);
          character = escapes.get(escapedCharacter ?? "");
          if (character === undefined) {
            throw new Error("Invalid JSON escape.");
          }
        }
      } else if ((character.codePointAt(0) ?? 0) < 32) {
        throw new Error("Invalid JSON control character.");
      }
      if (compare !== undefined && character !== compare[index]) {
        equal = false;
      }
      index += 1;
      // Keys only need to be retained up to the requested pointer segment length.
      if (value.length <= (capture ? 4096 : longestPointer)) {
        value += character;
      }
    }
  };
  const literal = async (word: string): Promise<void> => {
    for (const character of word) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Validate each literal character.
      await requireCharacter(character);
    }
  };
  const number = async (): Promise<void> => {
    if ((await next()) === "-") {
      await take();
    }
    if ((await next()) === "0") {
      await take();
    } else {
      if (!/^[1-9]$/u.test((await next()) ?? "")) {
        throw new Error("Invalid JSON number.");
      }
      do {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Consume a number digit.
        await take();
      } while (/^[0-9]$/u.test((await next()) ?? ""));
    }
    if ((await next()) === ".") {
      await take();
      if (!/^[0-9]$/u.test((await next()) ?? "")) {
        throw new Error("Invalid JSON number fraction.");
      }
      do {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Consume a fraction digit.
        await take();
      } while (/^[0-9]$/u.test((await next()) ?? ""));
    }
    const exponent = await next();
    if (/^[eE]$/u.test(exponent ?? "")) {
      await take();
      if (/^[+-]$/u.test((await next()) ?? "")) {
        await take();
      }
      if (!/^[0-9]$/u.test((await next()) ?? "")) {
        throw new Error("Invalid JSON exponent.");
      }
      do {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Consume an exponent digit.
        await take();
      } while (/^[0-9]$/u.test((await next()) ?? ""));
    }
  };
  const value = async (depth: number, selected: readonly number[]): Promise<void> => {
    if (depth > 512) {
      throw new Error("JSON response nesting exceeds safe parser depth.");
    }
    await whitespace();
    const character = await next();
    const target = selected.find((index) => paths[index]?.length === depth);
    if (target !== undefined && character !== '"') {
      matched[target] = false;
    }
    if (character === '"') {
      const observed = await string(
        target === undefined ? undefined : checks[target]?.expected,
        target === undefined ? false : checks[target]?.capture === true,
      );
      if (target !== undefined) {
        matched[target] =
          checks[target]?.expectedLiteral === undefined &&
          (checks[target]?.expected === undefined ? observed.nonempty : observed.equal);
        values[target] = observed.value;
      }
    } else if (character === "{") {
      await take();
      await whitespace();
      if ((await next()) === "}") {
        await take();
        return;
      }
      for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Traverse object members in order.
        const parsedKey = await string();
        const key = parsedKey.value;
        if (depth === 0 && allowedRootKeys !== undefined && !allowedRootKeys.has(key)) {
          throw new Error("Unexpected JSON response field.");
        }
        await whitespace();
        await requireCharacter(":");
        await value(
          depth + 1,
          selected.filter((index) => paths[index]?.[depth] === key),
        );
        await whitespace();
        const separator = await take();
        if (separator === "}") {
          return;
        }
        if (separator !== ",") {
          throw new Error("Invalid JSON object separator.");
        }
        await whitespace();
      }
    } else if (character === "[") {
      await take();
      await whitespace();
      if ((await next()) === "]") {
        await take();
        return;
      }
      let index = 0;
      for (;;) {
        const currentIndex = String(index);
        await value(
          depth + 1,
          selected.filter((check) => paths[check]?.[depth] === currentIndex),
        );
        index += 1;
        await whitespace();
        const separator = await take();
        if (separator === "]") {
          return;
        }
        if (separator !== ",") {
          throw new Error("Invalid JSON array separator.");
        }
        await whitespace();
      }
    } else if (character === "t") {
      await literal("true");
      if (target !== undefined) {
        matched[target] = checks[target]?.expectedLiteral === "true";
      }
    } else if (character === "f") {
      await literal("false");
      if (target !== undefined) {
        matched[target] = checks[target]?.expectedLiteral === "false";
      }
    } else if (character === "n") {
      await literal("null");
    } else {
      await number();
    }
  };
  try {
    await value(
      0,
      checks.map((_, index) => index),
    );
    await whitespace();
    if ((await next()) !== undefined) {
      throw new Error("Unexpected data after JSON response.");
    }
    return { matches: matched, values };
  } finally {
    await reader.cancel();
  }
};

/** Compare a single selected JSON string without retaining the response body. */
export const readJsonPointerString = async (
  body: ReadableStream<Uint8Array> | null,
  pointer: string,
  expected: string,
): Promise<boolean> => {
  const result = await readJsonStringChecks(body, [{ expected, pointer }]);
  return result.matches[0] ?? false;
};
