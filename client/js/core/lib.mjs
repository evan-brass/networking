// Base64 <-> Uint8Array
export function base64_encode(uint8array) {
	return btoa(String.fromCharCode(...uint8array))
}
export function base64_decode(string) {
	return new Uint8Array(
		atob(string).split('').map(c => c.charCodeAt(0))
	);
}

// Used to create kad_id from a buffer
export function uint8array_to_bigint(arr) {
	let temp = '0x';
	for (const b of arr) {
		temp += b.toString(16).padStart(2, '0');
	}
	return BigInt(temp);
}

// A shared Text Encoder and Decoder
export const text_encoder = new TextEncoder();
export const text_decoder = new TextDecoder("utf-8");

// crypto.subtle parameters
export const P256 = {
	name: 'ECDSA',
	namedCurve: 'P-256',
	hash: 'SHA-256'
};
export const P256DH = {
	...P256,
	name: 'ECDH'
};

// Expiration creation / checking
export function get_expiration(future = 5 /* min. in the future that the expiration will expire. */) {
	// Timestamp for right now in seconds.
	return Math.trunc(Date.now() / 1000 + future * 60).toString(16);
}
export function check_expiration(str) {
	if (typeof str != 'string') throw new Error('Missing expiration');
	const expiration = BigInt('0x' + str);
	const now = Date.now() / 1000;
	if (expiration < now) throw new Error('Message has expired.');
	// TODO: check if the expiration is too far out.  (what's a reasonable maximum expiration for messages? 10min? 30min?)
}