import { make_kad_id } from "./kad.mjs";
import { base64_decode, base64_encode, P256 } from "./lib.mjs";

/**
 * Peer IDs are ephemeral - they are created fresh each time.
 * Applications that use the Hyperspace Network must have their own method of keeping track of identities.
 * In the future, when we signal RTCPeerConnections on the application's behalf, we'll pass along their 'a=identity:' sdp.
 */
const {publicKey, privateKey} = await crypto.subtle.generateKey(P256, false, ['sign']);
let our_peerid;

/**
 * The PeerId class is just a container for the kad_id, and encoded public key so that we don't need to recreate them all the time (which would require async crypto calls.)
 */
export class PeerId {
	// By storing peer_ids and always returning the same object, we can use javascript == on the peer ids. The downside is, this map is a memory leak - we hold onto every peer id we've ever seen just in case we see it again.  Sadly a weakmap wouldn't work in this case.  If all of the PeerId references have been garbage collected then we can create a new PeerId without breaking object equality because no other references to the object exist.  Sadly, to use this would require the whole hard to use WeakRef stuffs. (TODO: Switch this map to holding WeakRefs)
	static peer_ids = new Map();
	public_key; // p256-public key
	kad_id; // Hash of the p256 key's x and y components as a bigint
	public_key_encoded;
	constructor({public_key, kad_id, public_key_encoded}) {
		this.public_key = public_key;
		this.kad_id = kad_id;
		this.public_key_encoded = public_key_encoded;
	}
	polite() {
		// Return true if this peer's kad_id is greater than ours.
		return our_peerid.kad_id < this.kad_id;
	}
	async verify(signature, buffer) {
		return await crypto.subtle.verify(P256, this.public_key, signature, buffer);
	}
	static async from_encoded(public_key_encoded) {
		let peer_id = PeerId.peer_ids.get(public_key_encoded);
		if (!peer_id) {
			const pk_bytes = base64_decode(public_key_encoded);
			const public_key = await crypto.subtle.importKey("raw", pk_bytes, P256, true, ["verify"]);
			peer_id = await PeerId.from_public_key(public_key, public_key_encoded);
			PeerId.peer_ids.set(public_key_encoded, peer_id);
		}
		return peer_id;
	}
	static async from_public_key(public_key, public_key_encoded = false) {
		if (!public_key_encoded) {
			const bytes = await crypto.subtle.exportKey('raw', public_key);
			public_key_encoded = base64_encode(new Uint8Array(bytes));
		}
		let kad_id;
		{ // Get the kad_id from the public key:
			let {x, y} = await crypto.subtle.exportKey('jwk', public_key);
			x = x.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');
			y = y.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');
			x = atob(x); y = atob(y);
			const bytes = new Uint8Array((x + y).split('').map(e => e.charCodeAt(0)));
			kad_id = await make_kad_id(bytes);
		}
		return new PeerId({ public_key, public_key_encoded, kad_id });
	}
}
our_peerid = await PeerId.from_public_key(publicKey);
PeerId.peer_ids.set(our_peerid.public_key_encoded, our_peerid);
console.log("Our peer_id is", our_peerid);

export { our_peerid, privateKey };