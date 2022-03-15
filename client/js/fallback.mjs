import { openDB, deleteDB, wrap, unwrap } from 'https://cdn.jsdelivr.net/npm/idb/+esm';


// This is just the first edition of the fallback client so we won't worry about a few improvements that will come later: some of which will only apply to the official client, and some which can also be applied back to this fallback.

const seed_addresses = [
	"ws://localhost:3030"
	// "seed1.hyperspace.gl"
	// etc.
];

// Connect to our seed addresses
for (const addr of seed_addresses) {
	let ws = new WebSocket(addr);
	ws.onmessage = ({data}) => {
		console.log(data);
	};
}

// We're just regenerating a new peer_id each time. TODO: reuse peer_keys
const {publicKey, privateKey} = await crypto.subtle.generateKey({
	name: 'ECDSA',
	namedCurve: 'P-384'
}, false, ['sign']);

// Map from peer_id -> RTCDataChannel
const routing_table = new Map();

if (window.parent === null) {
	throw new Error("The fallback hyperspace-client should be embedded in an iframe by the distributed web app.");
}

const {port1: app_port, port2} = new MessageChannel();

// Send half of the message channel to the app
window.parent.postMessage({
	hyperspace_client_message_port: port2
}, "*", [port2]);

// Handle messageson the app_port:
app_port.onmessage = ({ data, origin }) => {
	console.log(origin, data);
};