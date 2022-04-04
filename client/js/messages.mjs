import { our_peerid, PeerId } from "./peer-id.mjs";
import { lin_dst, routing_table } from "./routing-table.mjs";
import { PeerConnection } from './webrtc.mjs';

function create_nonce() {
    return Array.from(crypto.getRandomValues(new Uint8Array(4))).map(v => v.toString(16).padStart(2, '0')).join('');
}

export async function verify_message(data) {
	let {
		forward_path, forward_sig,
		body, body_sig,
		back_path
	} = JSON.parse(data);

	// Verify the back_path
	if (!Array.isArray(back_path)) throw new Error('missing back_path');
	let last_pid = our_peerid;
	const back_path_parsed = [];
	if (back_path.length < 1) throw new Error("back path can't be empty.");
	for (const hop of back_path) {
		if (typeof hop != 'string') throw new Error('non-string in back_path');
		let [peer_id, signature] = hop.split('.');
		peer_id = await PeerId.from_encoded(peer_id ?? '');
		if (!await peer_id.verify(signature ?? '', last_pid.public_key_encoded + body_sig ?? '')) throw new Error('signature failed in back_path.');
		back_path_parsed.unshift(peer_id);

		// Testing: Create a map of how the network is connected:
		// if (!sniffed_map.has(peer_id)) sniffed_map.set(peer_id, new Set());
		// sniffed_map.get(peer_id).add(last_pid);

		last_pid = peer_id;
	}
	const origin = back_path_parsed[0];

	// Verify the forward_path:
	let forward_path_parsed;
	if (typeof forward_path == 'string') {
		if (!origin.verify(forward_sig ?? '', forward_path)) throw new Error('forward_sig invalid.');
		// Parse the forward_path:
		forward_path_parsed = await Promise.all(forward_path.split(',').map(PeerId.from_encoded));
	}

	// Verify the body:
	if (typeof body == 'string') {
		if (!origin.verify(body_sig ?? '', body)) throw new Error('body_sig invalid.');
		// Parse the body:
		body = JSON.parse(body);
		// TODO: Check if the body has all required fields?
		if (typeof body?.nonce != 'string') throw new Error('body missing nonce');
	} else {
		// TODO: Throw an error?
		body = undefined;
	}

	return {
		origin,
		forward_path_parsed,
		body,
		back_path_parsed
	};
}

// Trigger a lookup_node
export async function lookup_node(kad_id) {
	await routing_table.kad_route(kad_id, {
		type: 'lookup_node',
		nonce: create_nonce(),
		kad_id
	});
}
export async function announce_self() {
	await routing_table.sibling_broadcast({
		type: "siblings",
		nonce: create_nonce(),
		siblings: Array.from(routing_table.siblings()).map(c => c.other_id.public_key_encoded)
	});
}

async function sniff_backpath(back_path_parsed) {
	// for (let i = 0; i < back_path_parsed.length; ++i) {
	// 	const pid = back_path_parsed[i];
	// 	if (pid != our_peerid && routing_table.space_available(pid.kad_id)) {
	// 		// Try to create a peerconnection to this peer:
	// 		const sdp = await PeerConnection.handle_connect(pid);
	// 		if (sdp) {
	// 			await source_route(back_path_parsed.slice(i), {
	// 				type: 'connect',
	// 				nonce: create_nonce(),
	// 				sdp
	// 			});
	// 		}
	// 	}
	// }
}

routing_table.events.addEventListener('old-sibling', async () => {
	await announce_self();
});
routing_table.events.addEventListener('new-sibling', async () => {
	await announce_self();
});

export async function message_handler({ data }) {
	const {origin, forward_path_parsed, body, back_path_parsed} = await verify_message(data);

	// Sniff Back path and consider connecting to the peers in it:
	sniff_backpath(back_path_parsed);

	// Forward the message if we're not the intended target:
	if (forward_path_parsed && forward_path_parsed[0] !== our_peerid) {
		await routing_table.forward(forward_path_parsed, data);
		return;
	}

	console.log('Rec:', body);

	// Handle the message:
	if (body.type == 'siblings') {
		// The sender thinks that we're siblings
		if (!routing_table.is_sibling(origin.kad_id)) {
			// But we don't think the sender is our sibling:
			const constraint = (our_peerid.kad_id < origin.kad_id) ? (k, c) => c < k : (k, c) => c > k;
			let closer = routing_table.lookup(origin.kad_id, constraint, lin_dst);
			closer = closer.other_id.public_key_encoded;
			await routing_table.source_route(back_path_parsed, {
				type: 'not_siblings',
				nonce: body.nonce,
				closer
			});
		}
		for (const sib of body.siblings) {
			const pid = await PeerId.from_encoded(sib);
			if (pid != our_peerid && !PeerConnection.have_conn(pid.kad_id) && routing_table.space_available_sibling_list(pid.kad_id)) {
				// Make a new connection:
				const sdp = await PeerConnection.handle_connect(pid);
				if (sdp) {
					await routing_table.source_route([pid, ...back_path_parsed], {
						type: 'connect',
						nonce: create_nonce(),
						sdp
					});
				}
			}
		}
	} else if (body.type == 'not_siblings') {
		const closer = await PeerId.from_encoded(body.closer);
		await routing_table.source_route([closer, ...back_path_parsed], {
			type: 'connect_request',
			nonce: create_nonce()
		});
	} else if (body.type == 'connect_request') {
		if (body.bits) {
			// TODO: handle kbucket connect_requests
		} else {
			// Handle a sibling connect request:
			if (origin == our_peerid) return;
			if (routing_table.space_available_sibling_list(origin.kad_id)) {
				const sdp = await PeerConnection.handle_connect(origin, body.sdp);
				// Accept the sibling_connect
				if (sdp) {
					await routing_table.source_route(back_path_parsed, {
						type: 'connect',
						nonce: body.nonce,
						sdp
					});
				}
			} else {
				// Try to route the sibling_connect onward
				const {body, body_sig, back_path} = JSON.parse(data);
				await routing_table.kad_route_data(origin.kad_id, {body, body_sig, back_path}, (a, b) => a !== b);
				// TODO: reply with a routing acknowledgement?
			}
		}
	} else if (body.type == 'connect') {
		// TODO: Check to make sure that this connect either came from a connect_request that we sent or would otherwise fit into our routing table.
		const sdp = await PeerConnection.handle_connect(origin, body.sdp);
		if (sdp) {
			await routing_table.source_route(back_path_parsed, {
				type: 'connect',
				nonce: body.nonce,
				sdp
			});
		}
	}
	// if (body.type == 'lookup_node') {
	// 	if (origin == our_peerid) return;
	// 	const node = await PeerId.from_encoded(body.node);
	// 	let closer = routing_table.lookup(node.kad_id);
	// 	await source_route(back_path_parsed, {
	// 		type: 'lookup_ack',
	// 		nonce: body.nonce,
	// 		closer: closer.map(conn => conn.other_id.public_key_encoded)
	// 	});
	// 	// Only consider routing the lookup to peers that are closer than our own peer_id, and also not the original sender
	// 	const our_dst = kad_dst(our_peerid.kad_id, node.kad_id);
	// 	closer = closer.filter(con => con.other_id != origin && kad_dst(con.other_id.kad_id, node.kad_id) < our_dst);

	// 	// If there's still a closer peer, that we have a connection to, then route the lookup to that peer
	// 	if (closer.length > 0) {
	// 		// Route the lookup to the closest node:
	// 		const {body, body_sig, back_path} = JSON.parse(data);
	// 		const back_path_sig = await our_peerid.sign(closer[0].other_id.public_key_encoded + body_sig);
	// 		closer[0].send(JSON.stringify({
	// 			body, body_sig,
	// 			back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path]
	// 		}));
	// 	}

	// 	// TODO: Sniff the back path for any peers we'd like to connect to?
	// } else if (body.type == 'lookup_value') {
	// 	// TODO: check our stored values
	// } else if (body.type == 'lookup_ack') {
	// 	const peers = await Promise.all(body.closer.map(encoded => PeerId.from_encoded(encoded)));
	// 	for (const peer of peers) {
	// 		sniff_backpath([peer, ...back_path_parsed]);
	// 	}
	// } else if (body.type == 'connect') {
	// 	const sdp = await PeerConnection.handle_connect(origin, body.sdp);
	// 	if (sdp) {
	// 		await source_route(back_path_parsed, {
	// 			type: 'connect',
	// 			nonce: body.nonce,
	// 			sdp
	// 		});
	// 	}
	// }
}