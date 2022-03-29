import { base64_decode, base64_encode, text_encoder, P256 } from "./lib.mjs";
import { our_peerid, PeerId, privateKey } from "./peer-id.mjs";
import { get_peer_id_set, get_routing_table, route, routing_table } from "./routing-table.mjs";
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

// TODO: we probably still need source routing so that we actually receive the recursive acknowledgements and such, however since the path is built hop-by-hop the old method of signing won't work anymore, we need to ba able to insert hops into the source path as we route.

export async function message_handler({ data }) {
	const valid = await verify_message(data);

	if (valid) {
		let {origin, message} = valid;
		origin = await PeerId.from_encoded(origin);
		let destination;
		if (message.destination) {
			destination = await PeerId.from_encoded(message.destination);
		}

		if (destination && destination !== our_peerid) {
			// Route the message on as best we can:
			await route(destination.kad_id, data);
			// TODO: read the message to see if there's any tasty routing information that we can overhear.
			return;
		}

		console.log("Recv", message);

		// TODO: add a nonce to all messages that we send, and ack the nonce in all replies.
		// TODO: lookup should be split into find_node and find_value because for find_value we accept any key, but for find_node we want the key to be a encoded_public_key
		if (message.type == 'lookup') {
			// The key is just the BigInt.toString(16) of the kad_id.  In the future we should probably use something better like base64.
			let {key, want_value} = message;
			key = BigInt('0x' + key);
			const closer_peers = routing_table.lookup(key);
			// TODO: If the origin wants the value and we have received a store for the key, then return the value.
			// Send a recursive acknowledgement
			await route(origin.kad_id, {
				type: 'rec_ack',
				// TODO: Since we return the public_key_encoded, an adversary would need to generate a random public key that hashes close to the key that we are looking up.  We can add an additional layer of protection by (in the future) adding a peer signature which is just a signature over the public key's bytes so that we can be certain that a peer generated the public key from a secret key instead of just picking a random ec point.
				peers: closer_peers.map(({value: i}) => i.other_id.public_key_encoded)
			});
			if (closer_peers.length > 0) {
				closer_peers[0].value.send(data);
			}
		} else if (message.type == 'connect') {
			const ret_description = await PeerConnection.handle_connect(origin, message.sdp);
			if (ret_description) {
				await route(origin.kad_id, {
					type: 'connect',
					sdp: ret_description
				});
			}
		} else if (message.type == 'rec_ack') {
			const peers = await Promise.all(message.peers.map(encoded => PeerId.from_encoded(encoded)));
			const peer_id_set = get_peer_id_set();
			for (const peer of peers) {
				if (peer != our_peerid && !peer_id_set.has(peer) && routing_table.should_add(peer.kad_id)) {
					// Create a peerconnection for this peer:
					const pc = new PeerConnection();
					pc.other_id = peer;
					const offer = pc.negotiate();
					await route(peer.kad_id, {
						type: 'connect',
						sdp: offer
					});
					peer_id_set.add(peer);
				}
			}
		}
		// else if (message.type == 'query') {
		// 	if (message.addresses) {
		// 		await route(path_back, { type: 'addresses', addresses: [] });
		// 	}
		// 	if (message.routing_table) {
		// 		const routing_table = get_routing_table();
		// 		const peers = Array.from(routing_table.keys()).map(pid => pid.public_key_encoded);
		// 		await route(path_back, { type: 'routing_table', peers })
		// 	}
		// } else if (message.type == 'routing_table') {
		// 	const peer_set = get_peer_id_set();
		// 	let attempts = peer_set.size;
		// 	for (const peer_id of await Promise.all((message.peers ?? []).map(PeerId.from_encoded))) {
		// 		if (peer_id == our_peerid) {
		// 			// Skip references to ourself
		// 		} else if (peer_set.has(peer_id)) {
		// 			// Skip references to connections that we've already created a PeerConnection for	
		// 		} else if (attempts++ < min_connections) {
		// 			const pc = new PeerConnection();
		// 			pc.other_id = peer_id;
		// 			const ret_description = await pc.negotiate();
		// 			await route([...path_back, peer_id], { type: 'connect', sdp: ret_description });
		// 		} else {
		// 			break;
		// 		}
		// 	}
		// }
	}
}