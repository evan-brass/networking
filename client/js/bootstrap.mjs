import { seed_addresses, webtorrent_trackers, seed_info_hashes } from "./network-props.mjs";
import { connection_table, insert_route } from "./routing-table.mjs";
import { stream } from "./lib.mjs";
import { create_peer_connection, negotiate_connection, identify_connection, channel_established } from "./webrtc.mjs";

// Currently, bootstrapping is a one time thing that happens before the sdk loads.
// TODO: make it so that bootstrapping automatically happens when we have no active peers in our

let active_resolve_bootstrapping;

// Random bytestring of length 20 (Used by webtorrent a lot):
function r20bs() {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	const str = Array.from(bytes).map(v => String.fromCharCode(v)).join('');
	return str;
}

const peer_id = r20bs(); // TODO: Make not random?
const numwant = 1;
const peer_connections = new Map();
async function tracker_connection(offer_id = r20bs(), offer) {
	const {peer_connection, data_channel} = create_peer_connection();
	peer_connections.set(offer_id, peer_connection);
	identify_connection(data_channel).then(origin => {
		insert_route(origin, data_channel);
		connection_table.set(origin, peer_connection);
		if (active_resolve_bootstrapping) {
			active_resolve_bootstrapping();
			active_resolve_bootstrapping = false;
		}
	});
	const description = await negotiate_connection(peer_connection, offer);

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
const tracker_connections = new Map();
async function get_tracker_ws(address) {
	let ws = tracker_connections.get(address);
	if (!ws || ws.readyState == 2 || ws.readyState == 3) {
		ws = new WebSocket(address);
		tracker_connections.set(address, ws);
		if (ws.readyState == 0) {
			await new Promise((res, rej) => {
				ws.onopen = res;
				ws.onclose = rej;
				ws.onerror = rej;
			});
			(async function() {
				// We listen for responses
				let interval;
				for await (const {data} of stream(ws, 'message')) {
					const msg = JSON.parse(data);
					console.log(msg);
					if (msg.interval) {
						if (interval) clearInterval(interval);
						interval = setInterval(() => {
							// We should get a response with an interval as the first message back.
							// If we didn't get any peers, then we should say that we're now a seeder for the info_hash
							if (ws.readyState == ws.CLOSED || ws.readyState == ws.CLOSING) {
								clearInterval(interval);
								return;
							}
							for (const info_hash of seed_info_hashes) {
								ws.send(JSON.stringify({
									action: 'announce',
									peer_id, info_hash,
									numwant, // TODO: create more offers?
									event: 'completed', downloaded: 600, left: 0, uploaded: 0
								}));
							}
						}, msg.interval * 1000);
					}
					if (msg.answer) {
						// Apply the remote description to our offer_id;
						const pc = peer_connections.get(msg.offer_id);
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
				}
			})();
		}
	}
	if (ws.readyState == 0) {
		await new Promise((res, rej) => {
			ws.onopen = res;
			ws.onclose = rej;
			ws.onerror = rej;
		});
	}
	return ws;
}

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
					if (active_resolve_bootstrapping) {
						active_resolve_bootstrapping();
						active_resolve_bootstrapping = false;
					}
					// TODO: try to upgrade the websocket connection to a WebRTC connection?
				} catch (e) {
					console.warn('Failed to use seed-peer for bootstrap:', e);
				}
			})();
		}
	
		for (const tracker of webtorrent_trackers) {
			(async function() {
				try {
					const ws = await get_tracker_ws(tracker);
					
					// Send our initial announce message:
					for (const info_hash of seed_info_hashes) {
						// Create our initial numwant offers that we'll send in our first announce
						let offers = await Promise.all((new Array(numwant)).fill(0).map(() => tracker_connection()));

						ws.send(JSON.stringify({
							action: 'announce',
							peer_id, info_hash,
							numwant, offers,
							event: "started", downloaded: 100, left: 500, uploaded: 0
						}));
					}
				} catch(e) {
					console.warn('Failed to use webtorrent tracker for bootstrap:', e);
				}
			})();
		}
	
		// TODO: Bootstrap using WebTorrent trackers
		// TODO: Bootstrap using 
	});
}