import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const MASTER_KEY = process.env.ALPHA_CODE_MASTER_KEY ?? "";

function deriveKey(): Buffer {
  return createHash("sha256").update(MASTER_KEY).digest();
}

export function isEncryptionEnabled(): boolean {
  return MASTER_KEY.length > 0;
}

export function encryptString(plain: string): string {
  const iv = randomBytes(12);
  const key = deriveKey();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptString(payload: string): string | null {
  if (!payload.startsWith("enc:v1:")) return payload;
  if (!isEncryptionEnabled()) return null;
  const parts = payload.split(":");
  if (parts.length !== 5) return null;
  const iv = Buffer.from(parts[2] ?? "", "base64");
  const tag = Buffer.from(parts[3] ?? "", "base64");
  const data = Buffer.from(parts[4] ?? "", "base64");
  try {
    const key = deriveKey();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}
