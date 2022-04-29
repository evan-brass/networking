import { base64_decode, base64_encode, P256, P256DH, text_decoder, text_encoder, uint8array_to_bigint } from "./lib.mjs";

/**
 * A PeerID is a pair of keypairs: ECDSA + ECDH.  The ECDSA pair is used to sign messages, and the ECDH is used to encrypt messages.
 * We derive a Kademlia ID (256bit BigInt) using sha-256 on the xy coordinates of both public keys.  The Kademlia ID defines the
 * position of each node in the routing / DHT structure.
 * The encoded form of a PeerId is `<ecdsa base64 encoded>&<ecdh base64 encoded>`.  The encoded form is what shows up in the back path
 * and in the sibling lists.  (In the future we should just use binary for everything, but...anyway)
 */
const {publicKey: ecdsa, privateKey: ecdsa_priv} = await crypto.subtle.generateKey(P256, false, ['sign', 'verify']);
const {publicKey: ecdh, privateKey: ecdh_priv} = await crypto.subtle.generateKey(P256DH, false, ['deriveKey']);

// Since we have two keys, our new encoded form will be   The encoded form is what will identify peers in the message paths and is what you would send in a list of your siblings during peer-exchange.

// encoded -> Weak<PeerId>
export const known_ids = new Map();
export function cleanup_known_ids() {
	// TODO: Delete all the keys who's weak PeerId has been garbage collected.
}

// Sign some data using our peer's ecdsa key
export async function sign(data) {
	if (typeof data == 'string') {
		data = text_encoder.encode(data);
	}
	const signature = await crypto.subtle.sign(P256, ecdsa_priv, data);
	return base64_encode(new Uint8Array(signature));
}
// Decrypt some ciphertext that was encrypted using an ephmeral ECDH key and our public ECDH key
export async function decrypt(encrypted, as_text = true) {
	// 1. Extract the parts from encrypted:
	const [ephemeral_encoded, iv_encoded, ciphertext] = encrypted.split('.');

	// 2. Import the ephemeral Key
	const ephemeral = await crypto.subtle.importKey('raw', base64_decode(ephemeral_encoded), P256DH, false, []);

	// 3. Derive a shared secret using our ecdh_priv and the ephemeral ecdh key
	const shared_key = await crypto.subtle.deriveKey({ name: 'ECDH', public: ephemeral}, ecdh_priv, { name: 'AES-CBC', length: 256}, false, ['decrypt']);

	// 4. Decrypt the ciphertext using AES-CBC
	let data = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: base64_decode(iv_encoded)}, shared_key, base64_decode(ciphertext));
	if (as_text) {
		data = text_decoder.decode(data);
	}

	// 5. Return the decrypted data
	return data;
}

async function derive_kad_id(ecdsa, ecdh) {
	// We want to hash the x/y coordinates of both keys to get the kad_id (we do this instead of hashing the encoded so that it doesn't matter if the encoded used compressed or uncompressed keys)
	let {x: x1, y: y1} = await crypto.subtle.exportKey('jwk', ecdsa);
	x1 = x1.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');
	y1 = y1.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');
	x1 = atob(x1); y1 = atob(y1);

	let {x: x2, y: y2} = await crypto.subtle.exportKey('jwk', ecdh);
	x2 = x2.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');
	y2 = y2.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');
	x2 = atob(x2); y2 = atob(y2);

	const bytes = new Uint8Array((x1 + y1 + x2 + y2).split('').map(e => e.charCodeAt(0)));
	return uint8array_to_bigint(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
export class PeerId {
	ecdsa;
	ecdh;
	kad_id;
	encoded;
	constructor() {
		Object.assign(this, ...arguments);
	}
	static async from_encoded(encoded) {
		try {
			const existing = known_ids.get(encoded);
			if (existing) {
				if (existing.then) return await existing;
				const pid = existing.deref();
				if (pid) return pid;
			}
			// Reserve the known-id (using a promise) so that we don't accidentally create two ids for the same encoded
			let res;
			known_ids.set(encoded, new Promise(resolve => { res = resolve; }));
			let [ecdsa, ecdh] = encoded.split('&').map(base64_decode);
			ecdsa = await crypto.subtle.importKey('raw', ecdsa, P256, true, ['verify']);
			ecdh = await crypto.subtle.importKey('raw', ecdh, P256DH, true, []);
			const kad_id = await derive_kad_id(ecdsa, ecdh);
			const ret = new PeerId({ecdsa, ecdh, kad_id, encoded});
			known_ids.set(encoded, new WeakRef(ret));
			res(ret);
			return ret;
		} catch (e) {
			console.error(e);
		}
	}
	polite() {
		return our_peerid.kad_id < this.kad_id;
	}
	async encrypt(data) {
		// Convert data to a buffer if it is text
		if (typeof data == 'string') {
			data = text_encoder.encode(data);
		}

		// 1. Generate an ephemeral ECDH key
		const {publicKey: ephemeral, privateKey: ephemeral_priv} = await crypto.subtle.generateKey(P256DH, false, ['deriveKey']);
		const ephemeral_encoded = base64_encode(new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral)));

		// 2. Derive a shared secret using the ephemeral ecdh key and this Peer's public ecdh key
		const shared_key = await crypto.subtle.deriveKey(
			{ name: 'ECDH', public: this.ecdh},
			ephemeral_priv,
			{ name: 'AES-CBC', length: 256 },
			false,
			['encrypt']
		);

		// 3. Generate a random initial value (must be 16 bytes)
		const iv = crypto.getRandomValues(new Uint8Array(16));
		const iv_encoded = base64_encode(iv);

		// 4. Encrypt the plaintext(data) using AES-CBC
		const ciphertext = base64_encode(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, shared_key, data)));
		
		// 5. Return the encoded ephemeral key + iv + ciphertext
		// IMPORTANT: In order to not be affected by padding oracle attacks, the returned encrypted text MUST be part of an authenticated message (the message must be signed).
		return `${ephemeral_encoded}.${iv_encoded}.${ciphertext}`;
	}
	async verify(signature, buffer) {
		if (typeof signature == 'string') {
			signature = base64_decode(signature);
		}
		if (typeof buffer == 'string') {
			buffer = text_encoder.encode(buffer);
		}
		return await crypto.subtle.verify(P256, this.ecdsa, signature, buffer);
	}
}

export const our_peerid = await (async function() {
	const kad_id = await derive_kad_id(ecdsa, ecdh);
	const ecdsa_encoded = base64_encode(new Uint8Array(await crypto.subtle.exportKey('raw', ecdsa)));
	const ecdh_encoded = base64_encode(new Uint8Array(await crypto.subtle.exportKey('raw', ecdh)));
	// We can't give different encoded forms to different peers because it would invalidate the back_path signatures.  I know... it should really be based on public key bytes the same way that kad_id is, but that would be harder to implement.  An alternative would be to base the signature in the back_path off of the hex encoded kad_id but that feels pretty much just as dirty...
	const encoded = `${ecdsa_encoded}&${ecdh_encoded}`;
	
	return new PeerId({ecdsa, ecdh, kad_id, encoded});
})();
known_ids.set(our_peerid.encoded, new WeakRef(our_peerid));