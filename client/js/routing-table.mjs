import { publicKey_encoded } from "./peer-id.mjs";
import { sign_message } from "./messages.mjs";
import { testing } from "./testing.mjs";


// Map from peer_id -> [RTCDataChannel | WebSocket]
export const routing_table = new Map();

// Map from peer_id -> RTCPeerConnection
export const connection_table = new Map();

testing.routing_table = routing_table;
testing.connection_table = connection_table;

// Source route a msg based on a path
export async function route(path, msgOrData) {
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

export function insert_route(peer_id, channel) {
	const old_route = routing_table.get(peer_id);
	if (old_route) {
		old_route.close();
	}
	routing_table.set(peer_id, channel);
	function clear_route() {
		const old_route = routing_table.get(peer_id);
		if (old_route == channel) {
			console.log("lost connection to: ", peer_id);
			routing_table.delete(peer_id);
		}
	}
	// Listen to websockets closing:
	channel.onclose = clear_route;
	// Listen to RTCDataChannels disconnecting / failing
	channel.onconnectionstatechange = () => {
		if (channel.connectionState == 'failed') {
			clear_route();
		}
	};
}

// The finite routing table space needs to be shared between DHT, GossipSub, etc.  While a connection might be quite important from a DHT distance perspective, it might not be useful with respect ot the topics we're subscribed to, or it might not have any of the same distributed applications running on it that we are running.