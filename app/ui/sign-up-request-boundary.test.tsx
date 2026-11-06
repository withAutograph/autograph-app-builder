import { expect, it } from "vitest";

interface RequestServices {
  connection: () => Promise<boolean>;
  headers: () => Promise<Headers>;
  session: (headers: Headers) => Promise<null>;
}

const initializeRequest = async (services: RequestServices): Promise<null> => {
  await services.connection();
  const requestHeaders = await services.headers();
  return await services.session(requestHeaders);
};

it("waits for a real request before starting shared auth initialization", async () => {
  const connection = Promise.withResolvers<boolean>();
  let headersCalled = false;
  let sessionCalled = false;
  const services: RequestServices = {
    connection: async () => {
      await connection.promise;
      return true;
    },
    headers: async () => {
      headersCalled = true;
      const requestHeaders = await Promise.resolve(new Headers());
      return requestHeaders;
    },
    session: async () => {
      sessionCalled = true;
      const session = await Promise.resolve(null);
      return session;
    },
  };

  const pending = initializeRequest(services);
  await Promise.resolve();
  expect(headersCalled).toBe(false);
  expect(sessionCalled).toBe(false);
  connection.resolve(true);
  await expect(pending).resolves.toBeNull();
  expect(sessionCalled).toBe(true);
});
