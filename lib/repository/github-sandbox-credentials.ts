// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function githubSandboxCredentialPolicy(token: string) {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const rules = [
    {
      transform: [{ headers: { Authorization: authorization } }],
    },
  ];

  return {
    allow: {
      "*": [],
      "codeload.github.com": rules,
      "github.com": rules,
    },
  };
}
