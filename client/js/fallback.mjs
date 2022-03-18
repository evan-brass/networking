// import { openDB, deleteDB, wrap, unwrap } from 'https://cdn.jsdelivr.net/npm/idb/+esm';

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder("utf-8");

// This is just the first edition of the fallback client so we won't worry about a few improvements that will come later: some of which will only apply to the official client, and some which can also be applied back to this fallback.

const seed_addresses = [
	"ws://localhost:3030"
	// "seed1.hyperspace.gl"
	// etc.
];
const min_connections = 5;

function base64_encode(uint8array) {
	return btoa(String.fromCharCode(...uint8array))
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
console.log("Our id is:", publicKey_encoded);

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
		// NOTE: Looks like Firefox doesn't like importing compressed P-256 keys.  Won't be an issue in the future when we do the crypto in Rust.
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

window.testing = {
	routing_table,
	connection_table,
	sign_message
};


// Connect to our seed addresses
for (const addr of seed_addresses) {
	let ws = new WebSocket(addr);
	ws.onopen = () => {
		sign_message({
			type: 'addresses',
			addresses: []
		}).then(d => ws.send(d));
	};
	ws.onmessage = async ({ data }) => {
		const valid = await verify_message(data);
		if (valid) {
			const {origin} = valid;
			routing_table.set(origin, ws);
			ws.onmessage = message_handler;
			ws.onclose = () => {
				const route = routing_table.get(origin);
				if (route == ws) routing_table.delete(origin);
			};
			message_handler({ data });

			// Try to replace the websocket with an RTCPeerConnection:
			create_RTCPeerConnection([origin], origin);

			return;
		}
	};
}

function create_RTCPeerConnection(path_back, origin) {
	const conn = new RTCPeerConnection({ iceServers: [{
		// A list of stun/turn servers: https://gist.github.com/sagivo/3a4b2f2c7ac6e1b5267c2f1f59ac6c6b
		urls: [
			'stun:stun.l.google.com:19302',
			'stun:stun1.l.google.com:19302'
		]
	}] });
	connection_table.set(origin, conn);
	conn.onicecandidate = ({ candidate }) => {
		if (candidate !== null) {
			candidate = candidate.toJSON();
			// TODO: submit a patch to WebRTC-rs to alias these fields to camelCase and use serde(default)
			const new_candidate = {
				candidate: candidate.candidate,
				sdp_mid: candidate.sdpMid ?? "",
				sdp_mline_index: candidate.sdpMLineIndex ?? 0,
				username_fragment: candidate.usernameFragment ?? ""
			};
			route(path_back, { type: "connect", ice: new_candidate });
		}
	};
	conn.onnegotiationneeded = async () => {
		const offer = await conn.createOffer();
		await conn.setLocalDescription(offer);
		await route(path_back, { type: "connect", sdp: conn.localDescription });
	};
	conn.onconnectionstatechange = () => {
		if (['closed', 'disconnected', 'failed'].includes(conn.connectionState)) {
			const current = connection_table.get(origin);
			if (current == conn) connection_table.delete(origin);
		}
	};
	conn.ondatachannel = console.log;
	const channel = conn.createDataChannel('hyperspace-protocol', {
		negotiated: true,
		id: 42
	});
	channel.onopen = () => {
		console.log("New RTCDataChannel Openned!");
		
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
	channel.onmessage = message_handler;
	return conn;
}

async function route(path, msgOrData) {
	for (let i = path.length - 1; i >= 0; --i) {
		const peer_id = path[i];
		if (peer_id == publicKey_encoded) {
			break;
		} else if (routing_table.has(peer_id)) {
			try {
				if (typeof msgOrData !== 'string' && i < path.length - 1) {
					msgOrData = {
						type: 'source_route',
						path: path.slice(i),
						content: msgOrData
					};
				}
				if (typeof msgOrData !== 'string') {
					console.log("Send", msgOrData);
					msgOrData = await sign_message(msgOrData);
				}
				const route = routing_table.get(peer_id);
				route.send(msgOrData);
				return;
			} catch (e) { console.error(e); }
		}
	}
	throw new Error('TODO: return path unreachable');
}

async function message_handler({ data }) {
	const valid = await verify_message(data);

	if (valid) {
		let {origin, message} = valid;
		let path_back = [origin];

		console.log("Recv", message);

		if (message.type == 'source_route') {
			const {path, content} = message;
			path_back = [...path].reverse();
			path_back.push(origin);
			if (path[path.length - 1] == publicKey_encoded) {
				// TODO: Make sure that content is a routable message
				message = content;
			} else {
				await route(path, data);
				return;
			}
		}
	
		if (message.type == 'connect') {
			let conn = connection_table.get(origin);
			if (!conn) {
				conn = create_RTCPeerConnection(path_back, origin);
			}
			if (message.sdp) {
				await conn.setRemoteDescription(message.sdp);
				if (message.sdp.type == 'offer') {
					await conn.setLocalDescription(await conn.createAnswer());
					await route(path_back, { type: 'connect', sdp: conn.localDescription });
				}
			}
			if (message.ice) {
				// TODO: submit a patch to WebRTC-rs to serde(alias these fields)
				await conn.addIceCandidate({
					candidate: message.ice.candidate,
					sdpMid: message.ice.sdp_mid,
					sdpMLineIndex: message.ice.sdp_mline_index,
					usernameFragment: message.ice.username_fragment
				});
			}
		} else if (message.type == 'query') {
			if (message.addresses) {
				await route(path_back, { type: 'addresses', addresses: [] });
			}
			if (message.routing_table) {
				const peers = Array.from(routing_table.keys());
				await route(path_back, { type: 'routing_table', peers })
			}
		} else if (message.type == 'routing_table') {
			let attempts = routing_table.size;
			for (const peer_id of message.peers ?? []) {
				if (peer_id == publicKey_encoded) {
					// Skip references to ourself
				} else if (connection_table.has(peer_id)) {
					// Skip references to connections that we've already created a RTCPeerConnection for	
				} else if (attempts++ < min_connections) {
					create_RTCPeerConnection([...path_back, peer_id], peer_id);
				} else {
					break;
				}
			}
		}
	}
}

async function heartbeat() {
	if (routing_table.size < min_connections && routing_table.size > 0) {
		// Find a random peer and see who they're connected to.
		const keys = Array.from(routing_table.keys());
		const key = keys[Math.trunc(Math.random() * keys.length)];
		const route = routing_table.get(key);
		route.send(await sign_message({
			type: 'query',
			routing_table: true
		}));
	}

	console.log("Heartbeat Finished.");
	setTimeout(heartbeat, 3000);
}
heartbeat();

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