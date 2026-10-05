export class VercelTokenDecryptionKeyError extends Error {
  constructor() {
    super("Vercel token decryption key is unavailable.");
    this.name = "VercelTokenDecryptionKeyError";
  }
}
