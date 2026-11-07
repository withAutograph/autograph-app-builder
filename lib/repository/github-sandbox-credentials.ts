// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function githubSandboxCredentialPolicy(token: string) {
  const credential = `x-access-token:${token}`;
  const authorization = `Basic ${Buffer.from(credential).toString("base64")}`;
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
