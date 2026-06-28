import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "#config/env.ts";

/**
 * Encryption of model credentials with AES-256-GCM.
 *
 * The key (32 bytes) comes from CREDENTIALS_ENCRYPTION_KEY (64 hex). Each value is encrypted with a
 * random 12-byte IV and stored as an envelope { v, iv, tag, ct } in JSONB.
 * GCM provides authentication (tag): if the ciphertext is tampered with, decryption fails.
 */
const KEY = Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, "hex");

export interface EncEnvelope {
	/** Encryption schema version (for future rotations). */
	v: 1;
	/** Base64 IV. */
	iv: string;
	/** Base64 GCM auth tag. */
	tag: string;
	/** Base64 ciphertext. */
	ct: string;
}

export function encryptJson(value: unknown): EncEnvelope {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", KEY, iv);
	const plaintext = Buffer.from(JSON.stringify(value), "utf8");
	const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		v: 1,
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		ct: ct.toString("base64"),
	};
}

export function decryptJson<T = unknown>(envelope: EncEnvelope): T {
	const decipher = createDecipheriv(
		"aes-256-gcm",
		KEY,
		Buffer.from(envelope.iv, "base64"),
	);
	decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(envelope.ct, "base64")),
		decipher.final(),
	]);
	return JSON.parse(plaintext.toString("utf8")) as T;
}
