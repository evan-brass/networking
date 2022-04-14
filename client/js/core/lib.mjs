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