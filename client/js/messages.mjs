import { base64_decode, base64_encode, text_encoder, P256 } from "./lib.mjs";
import { our_peerid, PeerId, privateKey } from "./peer-id.mjs";
import { get_peer_id_set, get_routing_table, route } from "./routing-table.mjs";
import { min_connections } from "./network-props.mjs";
import { testing } from "./testing.mjs";
import { PeerConnection } from "./webrtc.mjs";

export async function sign_message(msg) {
	const body = JSON.stringify(msg);
	const data = text_encoder.encode(body);
	const signature = base64_encode(new Uint8Array(
		await crypto.subtle.sign(P256, privateKey, data)
	));
	return JSON.stringify({
		origin: our_peerid.public_key_encoded,
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
		origin = await PeerId.from_encoded(origin);
		let path_back = [origin];

		console.log("Recv", message);

		if (message.type == 'source_route') {
			let {path, content} = message;
			path = await Promise.all(path.map(PeerId.from_encoded));
			path_back = [...path].reverse();
			path_back.push(origin);
			if (path[path.length - 1] == our_peerid) {
				// TODO: Make sure that content is a routable message
				message = content;
			} else {
				await route(path, data);
				return;
			}
		}
	
		if (message.type == 'connect') {
			const ret_description = await PeerConnection.handle_connect(origin, message.sdp);
			if (ret_description) {
				await route(path_back, {
					type: 'connect',
					sdp: ret_description
				});
			}
		} else if (message.type == 'query') {
			if (message.addresses) {
				await route(path_back, { type: 'addresses', addresses: [] });
			}
			if (message.routing_table) {
				const routing_table = get_routing_table();
				const peers = Array.from(routing_table.keys()).map(pid => pid.public_key_encoded);
				await route(path_back, { type: 'routing_table', peers })
			}
		} else if (message.type == 'routing_table') {
			const peer_set = get_peer_id_set();
			let attempts = peer_set.size;
			for (const peer_id of await Promise.all((message.peers ?? []).map(PeerId.from_encoded))) {
				if (peer_id == our_peerid) {
					// Skip references to ourself
				} else if (peer_set.has(peer_id)) {
					// Skip references to connections that we've already created a PeerConnection for	
				} else if (attempts++ < min_connections) {
					const pc = new PeerConnection();
					pc.other_id = peer_id;
					const ret_description = await pc.negotiate();
					await route([...path_back, peer_id], { type: 'connect', sdp: ret_description });
				} else {
					break;
				}
			}
		}
	}
}