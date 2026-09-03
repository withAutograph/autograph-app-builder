export function githubSandboxCredentialPolicy(token: string) {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const rules = [
    {
      transform: [{ headers: { authorization } }],
    },
  ];

  return {
    allow: {
      "github.com": rules,
      "codeload.github.com": rules,
      "*": [],
    },
  };
}
