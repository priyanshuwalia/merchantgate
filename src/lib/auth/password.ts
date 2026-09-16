import crypto from "node:crypto";

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SALT_BYTES = 16;

function scryptAsync(
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: {
    N: number;
    r: number;
    p: number;
    maxmem?: number;
  },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scryptAsync(
    Buffer.from(password, "utf8"),
    salt,
    SCRYPT_KEYLEN,
    {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
      maxmem: 256 * 1024 * 1024,
    },
  );
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [saltHex, hashHex] = storedHash.split(":");
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expectedHash = Buffer.from(hashHex, "hex");

  const derivedKey = await scryptAsync(
    Buffer.from(password, "utf8"),
    salt,
    expectedHash.length,
    {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
      maxmem: 256 * 1024 * 1024,
    },
  );

  if (derivedKey.length !== expectedHash.length) return false;
  return crypto.timingSafeEqual(derivedKey, expectedHash);
}
