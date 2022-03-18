import { base64_encode, P256 } from "./lib.mjs";

// We're just regenerating a new peer_id each time.
// TODO: use ed25519 instead of P256
export const {publicKey, privateKey} = await crypto.subtle.generateKey(P256, false, ['sign']);
export const publicKey_encoded = await (async () => {
	const exported = await crypto.subtle.exportKey("raw", publicKey);
	return base64_encode(new Uint8Array(exported));
})();
console.log("Our id is:", publicKey_encoded);