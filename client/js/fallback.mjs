import { openDB, deleteDB, wrap, unwrap } from 'https://cdn.jsdelivr.net/npm/idb/+esm';

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder("utf-8");

// This is just the first edition of the fallback client so we won't worry about a few improvements that will come later: some of which will only apply to the official client, and some which can also be applied back to this fallback.

const seed_addresses = [
	"ws://localhost:3030"
	// "seed1.hyperspace.gl"
	// etc.
];

function base64_encode(uint8array) {
	btoa(String.fromCharCode(...uint8array))
}
function base64_decode(string) {
	return new Uint8Array(
		atob(string).split('').map(c => c.charCodeAt(0))
	);
}

// We're just regenerating a new peer_id each time.
// TODO: use ed25519 instead of P256
const P256 = {
	name: 'ECDSA',
	namedCurve: 'P-256',
	hash: 'SHA-256'
};
const {publicKey, privateKey} = await crypto.subtle.generateKey(P256, false, ['sign']);
const publicKey_encoded = await (async () => {
	const exported = await crypto.subtle.exportKey("raw", publicKey);
	return base64_encode(new Uint8Array(exported));
})();

async function sign_message(msg) {
	const body = JSON.stringify(msg);
	const data = text_encoder.encode(body);
	const signature = base64_encode(new Uint8Array(
		await crypto.subtle.sign(P256, privateKey, data)
	));
	return JSON.stringify({
		origin: publicKey_encoded,
		body,
		signature
	});
}
async function verify_message(ws_data) {
	try {
		let {origin, body, signature} = JSON.parse(ws_data);
		// TODO: Fix whatever is causing firefox to throw an error about the following line.
		let origin_key = await crypto.subtle.importKey('raw', base64_decode(origin), P256, false, ['verify']);
		const data = text_encoder.encode(body);
		signature = base64_decode(signature);
		const is_valid = await crypto.subtle.verify(P256, origin_key, signature, data);
		if (is_valid) {
			let message = JSON.parse(body);
			return {origin, message};
		} else {
			console.warn("Received an invalid message");
		}
	} catch (e) {
		console.error(e);
	}
}

// Map from peer_id -> [RTCDataChannel | WebSocket]
const routing_table = new Map();

// Map from peer_id -> RTCPeerConnection
const connection_table = new Map();


// Connect to our seed addresses
for (const addr of seed_addresses) {
	let ws = new WebSocket(addr);
	ws.onopen = () => {
		ws.send(sign_message({
			type: 'addresses',
			addresses: []
		}));
	};
	ws.onmessage = async ({data}) => {
		const valid = await verify_message(data);
		if (valid) {
			const {origin} = valid;
			routing_table.set(origin, ws);
			ws.onmessage = message_handler.bind(null, ws);
			ws.onclose = () => {
				const route = routing_table.get(origin);
				if (route == ws) routing_table.delete(origin);
			};
			message_handler(ws, data);
			return;
		}
	};
}

async function message_handler(from, data) {
	const valid = await verify_message(data);

	if (valid) {
		const {origin, message} = valid;

		// TODO: unwrap routed messages and modify reply to send a routed message back.
		const reply = msg => {
			const data = sign_message(msg);
			from.send(data); // Both WebSocket and RTCDataChannel have a similiar send method
		};
	
		if (message.type == 'Introduction') {
			let conn = connection_table.get(origin);
			if (!conn) {
				conn = new RTCPeerConnection({ /* TODO: iceServers */ });
				connection_table.set(origin, conn);
				conn.onicecandidate = ({ candidate }) => {
					reply({ type: "Introduction", ice: [candidate] });
				};
				conn.onnegotiationneeded = async () => {
					const offer = await conn.createOffer();
					await conn.setLocalDescription(offer);
					reply({ type: "Introduction", sdp: conn.localDescription });
				};
				conn.onconnectionstatechange = () => {
					if (conn.connectionState == 'closed') {
						const current = connection_table.get(origin);
						if (current == conn) connection_table.delete(origin);
					}
				};
				const channel = conn.createDataChannel('hyperspace-protocol');
				channel.onopen = () => {
					const current = routing_table.get(origin);
					if (current && current != channel) {
						current.close();
					}
					routing_table.set(origin, channel);
				};
				channel.onclose = () => {
					const current = routing_table.get(origin);
					if (current && current == channel) {
						routing_table.delete(origin);
					}
				};
				channel.onmessage = message_handler.bind(null, channel);
			}
			for (const candidate of message.ice ?? []) {
				await conn.addIceCandidate(candidate);
			}
			if (message.sdp) {
				await conn.setRemoteDescription(message.sdp);
			}
		} else {
			console.log(origin, message);
		}
	}
}

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