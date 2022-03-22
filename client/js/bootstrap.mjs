import { seed_addresses, seed_webtorrent, iceServers } from "./network-props.mjs";
import { insert_route, routing_table } from "./routing-table.mjs";
import { sign_message, verify_message, message_handler, create_RTCPeerConnection } from "./messages.mjs";
import { stream } from "./lib.mjs";

// Currently, bootstrapping is a one time thing that happens before the sdk loads.
// TODO: make it so that bootstrapping automatically happens when we have no active peers in our

// Random bytestring of length 20 (Used by webtorrent a lot):
function r20bs() {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	const str = Array.from(bytes).map(v => String.fromCharCode(v)).join('');
	return str;
}

// Send an address message to the connection and wait until we've received an address message so that we know who is on the other end.
function identify_connection(channel) {
	return new Promise((resolve, reject) => {
		channel.onopen = async () => {
			channel.send(await sign_message({
				type: 'addresses',
				addresses: []
			}));
		};
		channel.onclose = () => reject();
		channel.onmessage = async ({ data }) => {
			const valid = await verify_message(data);
			if (valid) {
				const {origin} = valid;
				resolve(origin);
				channel.onmessage = message_handler;
				message_handler({ data });
			}
		};
	});
}

function create_peer_connection() {
	const peer_connection = new RTCPeerConnection({ iceServers });
	const data_channel = peer_connection.createDataChannel('hyperspace-network', {
		negotiated: true,
		id: 42
	});
	// peer_connection.onconnectionstatechange = () => console.log('conn state', peer_connection.connectionState);
	// peer_connection.onicegatheringstatechange = () => console.log('icegather state', peer_connection.iceConnectionState);
	// peer_connection.onnegotiationneeded = () => console.log('negotiation needed');
	// peer_connection.onsignalingstatechange = () => console.log('signal state', peer_connection.signalingState);
	return {peer_connection, data_channel};
}

export function bootstrap() {
	return new Promise((resolve_bootstrapping, reject) => {
		// TODO: reject if every single bootstrapping method fails.

		// Connect to our seed addresses
		for (const addr of seed_addresses) {
			(async function() {
				try {
					let ws = new WebSocket(addr);
					let other_side = await identify_connection(ws);
					insert_route(other_side, ws);
					resolve_bootstrapping();
					// TODO: try to upgrade the websocket connection to a WebRTC connection?
				} catch (e) {
					console.warn('Failed to use seed-peer for bootstrap:', e);
				}
			})();
		}
	
		const peer_id = r20bs(); // TODO: Make not random?
		const peer_connections = new Map();
		for (const {tracker, info_hash, numwant = 1} of seed_webtorrent) {
			// TODO: share tracker connections between multiple info_hashes
			async function tracker_connection(offer_id = r20bs(), offer) {
				const {peer_connection, data_channel} = create_peer_connection();
				peer_connections.set(offer_id, peer_connection);
				identify_connection(data_channel).then(origin => {
					insert_route(origin, data_channel);
					resolve_bootstrapping();
				});
				const ice_done = new Promise(res => {
					peer_connection.onicecandidate = ({candidate}) => {
						if (candidate == null) res();
					}
				});
				if (offer) {
					// We're answering an existing connection
					peer_connection.setRemoteDescription(offer);
					const answer = await peer_connection.createAnswer();
					await peer_connection.setLocalDescription(answer);
				} else {
					// This connection will be offered to other peers by the tracker
					const offer = await peer_connection.createOffer();
					await peer_connection.setLocalDescription(offer);
				}
				// Wait for ice gather to complete before returning the offer / answer;
				await ice_done;
				if (peer_connection.localDescription?.type == 'offer') {
					return {
						offer_id,
						offer: peer_connection.localDescription
					};
				} else if (peer_connection.localDescription?.type == 'answer') {
					return {
						offer_id,
						answer: peer_connection.localDescription
					};
				} else {
					throw new Error("Peer connection's local description wasn't ws tracker friendly.");
				}
			}
			(async function() {
				try {
					const ws = new WebSocket(tracker);
					// Wait for the socket to open
					await new Promise((res, rej) => {
						ws.onopen = res;
						ws.onclose = rej;
						ws.onerror = rej;
					});

					// Create our initial numwant offers that we'll send in our first announce
					let offers = await Promise.all((new Array(numwant)).fill(0).map(() => tracker_connection()));

					// Send our initial announce message:
					ws.send(JSON.stringify({
						action: 'announce',
						peer_id, info_hash,
						numwant, offers,
						event: "started", downloaded: 100, left: 500, uploaded: 0
					}));

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
								ws.send(JSON.stringify({
									action: 'announce',
									peer_id, info_hash,
									numwant, // TODO: create more offers?
									event: 'completed', downloaded: 600, left: 0, uploaded: 0
								}));
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
								peer_id, info_hash,
								to_peer_id: msg.peer_id,
								...rest
							}));
						}
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