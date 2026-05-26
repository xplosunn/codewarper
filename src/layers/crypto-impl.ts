import { createHash, randomBytes } from "node:crypto";
import type { Crypto } from "../providers/services.ts";

function base64Url(input: Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function isObject(value: unknown): boolean {
  return Boolean(value) && typeof value === "object";
}

export function createCrypto(): Crypto {
  const createPkcePair: Crypto["createPkcePair"] = () => {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    return { verifier, challenge };
  };

  const createRandomHex: Crypto["createRandomHex"] = (byteLength) => {
    return randomBytes(byteLength).toString("hex");
  };

  const decodeJsonWebTokenPayload: Crypto["decodeJsonWebTokenPayload"] = (token) => {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    try {
      const payload = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
      const parsed = JSON.parse(payload);
      if (isObject(parsed)) {
        return parsed;
      }

      return null;
    } catch {
      return null;
    }
  };

  return { createPkcePair, createRandomHex, decodeJsonWebTokenPayload };
}
