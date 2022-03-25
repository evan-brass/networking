import { publicKey_encoded } from "./peer-id.mjs";
import { sign_message } from "./messages.mjs";
import { PeerConnection } from "./webrtc.mjs";

export function get_routing_table() {
	// This time around, I'm trying to have the routing table be a snapshot of the current connections.  In the future when more complex routing is needed it can't be that way (we may need to store routing paths not just datachannels) but we'll cross that bridge when we come to it.
	// peer_id -> rtcdatachannel
	const routing_table = new Map();
	for (const pc of PeerConnection.connections) {
		if (pc.other_id) {
			const dc = pc.get_hn_dc();
			if (dc) routing_table.set(pc.other_id, dc);
		}
	}
	return routing_table;
}
// Get all of the peer_ids that we have even if they aren't routable yet:
export function get_peer_id_set() {
	const peer_set = new Set();
	for (const pc of PeerConnection.connections) {
		if (pc.other_id) {
			peer_set.add(pc.other_id);
		}
	}
	return peer_set;
}

// Source route a msg based on a path
export async function route(path, msgOrData) {
	const routing_table = get_routing_table();
	for (let i = path.length - 1; i >= 0; --i) {
		const peer_id = path[i];
		if (peer_id == publicKey_encoded) {
			// If we reach our own public_key then abort so that we don't route the message backwards.
			break;
		} else if (routing_table.has(peer_id)) {
			const route = routing_table.get(peer_id);
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
				route.send(msgOrData);
				return;
			} catch (e) { console.error(e); }
		}
	}
	throw new Error('TODO: return path unreachable');
}

// The finite routing table space needs to be shared between DHT, GossipSub, etc.  While a connection might be quite important from a DHT distance perspective, it might not be useful with respect ot the topics we're subscribed to, or it might not have any of the same distributed applications running on it that we are running.