import { seed_addresses, seed_info_hashes, webtorrent_trackers, num_tracker_want } from "./network-props.mjs";
import { insert_route, connection_table, routing_table } from "./routing-table.mjs";
import { create_peer_connection, identify_connection, negotiate_connection } from './webrtc.mjs';

// Random bytestring of length 20 (Used by webtorrent a lot):
function r20bs() {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	const str = Array.from(bytes).map(v => String.fromCharCode(v)).join('');
	return str;
}

let active_resolve_bootstrapping;

const peer_id = r20bs(); // TODO: Make not random?

// Open connections to the webtorrent trackers
const pending_tracker_connections = new Map();
for (const addr of webtorrent_trackers) {
	let ws;
	try {
		ws = new WebSocket(addr);
		let interval;
		ws.onopen = async () => {
			ws.onmessage = async ({ data }) => {
				const msg = JSON.parse(data);
				if (msg.interval) {
					if (interval) clearInterval(interval);
					interval = setInterval(() => {
						// We should get a response with an interval as the first message back.
						// If we didn't get any peers, then we should say that we're now a seeder for the info_hash
						if (ws.readyState == 2 || ws.readyState == 3) {
							clearInterval(interval);
							return;
						}
						for (const info_hash of seed_info_hashes) {
							ws.send(JSON.stringify({
								action: 'announce',
								peer_id, info_hash,
								numwant: num_tracker_want, // TODO: create more offers?
								event: 'completed', downloaded: 600, left: 0, uploaded: 0
							}));
						}
					}, msg.interval * 1000);
				}
				if (msg.answer) {
					// Apply the remote description to our offer_id;
					const pc = pending_tracker_connections.get(msg.offer_id);
					if (pc) {
						await pc.setRemoteDescription(msg.answer);
						console.log("received answer from", msg.peer_id);
					}
				} else if (msg.offer) {
					const rest = await tracker_connection(msg.offer_id, msg.offer);
					ws.send(JSON.stringify({
						action: 'announce',
						peer_id, info_hash: msg.info_hash,
						to_peer_id: msg.peer_id,
						...rest
					}));
				}
			};
			// Create our initial numwant offers that we'll send in our first announce
			let offers = await Promise.all((new Array(num_tracker_want)).fill(0).map(() => tracker_connection()));
	
			// Send our initial announce message:
			for (const info_hash of seed_info_hashes) {
				ws.send(JSON.stringify({
					action: 'announce',
					peer_id, info_hash,
					numwant: num_tracker_want, offers,
					event: "started", downloaded: 100, left: 500, uploaded: 0
				}));
			}
		};
	} catch (e) {
		console.log("Unable to connect to webtorrent tracker:", e);
	}
}

// TODO: share tracker connections between multiple info_hashes
async function tracker_connection(offer_id = r20bs(), offer) {
	const {peer_connection, data_channel} = create_peer_connection();
	pending_tracker_connections.set(offer_id, peer_connection);
	identify_connection(data_channel).then(origin => {
		if (!routing_table.has(origin)) {
			insert_route(origin, data_channel);
			connection_table.set(origin, peer_connection);
		}
		pending_tracker_connections.delete(offer_id);
		if (active_resolve_bootstrapping) active_resolve_bootstrapping();
	});
	const description = await negotiate_connection(peer_connection, offer);
	setTimeout(() => {
		if (peer_connection.signalingState == 'have-local-offer') {
			// If we don't get an answer for our offer within 3sec, then we close the offer.  The tracker knows about us and will pass any new peers' offers on to us, so ours will never get used.
			peer_connection.close();
		}
	}, 3000);

	if (description?.type == 'offer') {
		return {
			offer_id,
			offer: description
		};
	} else if (description?.type == 'answer') {
		return {
			offer_id,
			answer: description
		};
	} else {
		throw new Error("Peer connection's local description wasn't ws tracker friendly.");
	}
}

/**
 * There's two kinds of bootstrapping methods.
 */
export function bootstrap() {
	return new Promise((resolve_bootstrapping, reject) => {
		active_resolve_bootstrapping = resolve_bootstrapping;
		// TODO: reject if every single bootstrapping method fails.

		// Connect to our seed addresses
		for (const addr of seed_addresses) {
			(async function() {
				try {
					let ws = new WebSocket(addr);
					let other_side = await identify_connection(ws);
					insert_route(other_side, ws);
					if (active_resolve_bootstrapping) active_resolve_bootstrapping();
					// TODO: try to upgrade the websocket connection to a WebRTC connection?
				} catch (e) {
					console.warn('Failed to use seed-peer for bootstrap:', e);
				}
			})();
		}
	
		// TODO: Bootstrap using WebTorrent trackers
		// TODO: Bootstrap using 
	});
}