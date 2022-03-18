import { base64_decode, base64_encode, text_encoder, P256 } from "./lib.mjs";
import { privateKey, publicKey_encoded } from "./peer-id.mjs";
import { routing_table, connection_table, route } from "./routing-table.mjs";
import { min_connections } from "./network-props.mjs";
import { testing } from "./testing.mjs";

export async function sign_message(msg) {
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
testing.sign_message = sign_message;

export async function verify_message(ws_data) {
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


export function create_RTCPeerConnection(path_back, origin) {
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
			// TODO: submit a patch to WebRTC-rs to alias these fields to camelCase and use serde(default) for the username_fragment
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

export async function message_handler({ data }) {
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