// ULIDs (https://github.com/ulid/spec), the id format PeckList's Task API accepts for creates.
// Uses the Web Crypto API so it works on Obsidian mobile as well as desktop.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function ulid(now: number = Date.now(), random: (bytes: Uint8Array) => Uint8Array = defaultRandom): string {
	let time = '';
	let t = Math.floor(now);
	for (let i = 0; i < 10; i++) {
		time = ALPHABET.charAt(t % 32) + time;
		t = Math.floor(t / 32);
	}
	const bytes = random(new Uint8Array(16));
	let rest = '';
	for (let i = 0; i < 16; i++) rest += ALPHABET.charAt((bytes[i] ?? 0) % 32);
	return time + rest;
}

function defaultRandom(bytes: Uint8Array): Uint8Array {
	return crypto.getRandomValues(bytes);
}
