import { base64_decode, base64_encode, text_encoder, P256 } from "./lib.mjs";
import { privateKey, publicKey_encoded } from "./peer-id.mjs";
import { routing_table, connection_table, route, insert_route } from "./routing-table.mjs";
import { min_connections } from "./network-props.mjs";
import { testing } from "./testing.mjs";
import { channel_established, create_peer_connection, negotiate_connection } from "./webrtc.mjs";
import { kad_id, our_kad_id } from "./kad.mjs";

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
			if (message.sdp.type == 'offer' && conn) {
				// Both peers tried to connect to eachother simultaniously:
				const their_kad_id = kad_id(base64_decode(origin));
				if (our_kad_id > their_kad_id) {
					// Resend our offer in case the peer missed it.
					await route(path_back, {
						type: 'connect',
						sdp: conn.localDescription
					});
					console.log("Ignoring a simultaneous connection.");
					debugger;
					return;
				} else {
					// Cancel our connection and answer their connection.
					conn.close();
					conn = false;
					debugger;
				}
			}
			if (message.sdp.type == 'offer' && !conn) {
				const {peer_connection, data_channel} = create_peer_connection();
				channel_established(data_channel).then(() => {
					insert_route(origin, data_channel);
				});
				connection_table.set(origin, peer_connection);
				const answer = await negotiate_connection(peer_connection, message.sdp);
				await route(path_back, { type: 'connect', sdp: answer });
			} else if (message.sdp.type == 'answer' && conn) {
				await conn.setRemoteDescription(message.sdp);
			} else {
				console.log("Not sure what's with this connect message.");
				debugger;
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
					const {peer_connection, data_channel} = create_peer_connection();
					channel_established(data_channel).then(() => {
						insert_route(peer_id, data_channel);
					});
					connection_table.set(peer_id, peer_connection);
					const offer = await negotiate_connection(peer_connection);
					await route([...path_back, peer_id], { type: 'connect', sdp: offer });
				} else {
					break;
				}
			}
		}
	}
}