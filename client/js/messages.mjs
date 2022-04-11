import { our_peerid, PeerId } from "./peer-id.mjs";
import { bucket_index, constraint_backpath, lin_dst, routing_table } from "./routing-table.mjs";
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

		if (peer_id == our_peerid) throw new Error('Routing cycle detected in the back-path');

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

export async function announce_self() {
	await routing_table.sibling_broadcast({
		type: "siblings",
		nonce: create_nonce(),
		siblings: Array.from(routing_table.siblings()).map(c => c.other_id.public_key_encoded)
	});
}
export async function refresh_bucket() {
	const bucket = routing_table.first_empty();
	const target = routing_table.random_kad_id(bucket);
	await routing_table.kad_route(target, {
		type: 'request_connect',
		nonce: create_nonce(),
		target: target.toString(16),
		bucket
	});
}
function sibling_request_connect() {
	return {
		type: 'request_connect',
		nonce: create_nonce(),
		...routing_table.sibling_range()
	};
}

routing_table.events.addEventListener('old-sibling', async () => {
	await announce_self();
});
routing_table.events.addEventListener('new-sibling', async () => {
	await announce_self();
});

export async function message_handler({ data }) {
	const {origin, forward_path_parsed, body, back_path_parsed} = await verify_message(data);

	// Forward the message if we're not the intended target:
	if (forward_path_parsed && forward_path_parsed[0] !== our_peerid) {
		await routing_table.source_route_data(forward_path_parsed, JSON.parse(data));
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
		await routing_table.source_route([closer, ...back_path_parsed], sibling_request_connect());
	} else if (body.type == 'request_connect') {
		const target = (body.bucket !== undefined) ? BigInt('0x' + body.target) : origin.kad_id;
		let sdp;
		if (PeerConnection.have_conn(origin.kad_id)) {
			// Do nothing.
		} else if (body.bucket !== undefined) {
			if (bucket_index(our_peerid.kad_id, origin.kad_id) == body.bucket && routing_table.space_available_bucket(origin.kad_id)) {
				sdp = await PeerConnection.handle_connect(origin);
			}
		} else {
			// This is a sibling connect_request
			// TODO: make sure that their sibling list would have space for us.
			if (routing_table.space_available_sibling_list(origin.kad_id)) {
				sdp = await PeerConnection.handle_connect(origin);
			}
		}
		if (sdp) {
			await routing_table.source_route(back_path_parsed, {
				type: 'connect',
				nonce: body.nonce,
				sdp
			});
		} else {
			// Since we couldn't fit the sender into our routing table, just route the message onward.
			const {body, body_sig, back_path} = JSON.parse(data);
			await routing_table.kad_route_data(target, {body, body_sig, back_path}, constraint_backpath(back_path_parsed));
			// TODO: Routing acknowledgement
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

	// Sniff Back path and consider connecting to the peers in it:
	// (We sniff the back_path after handling the message so that we don't send a connect_request after having already sent back a connect message)
	// sniff_backpath(back_path_parsed);
}

async function sniff_backpath(back_path_parsed,) {
	for (let i = 0; i < back_path_parsed.length; ++i) {
		const pid = back_path_parsed[i];
		
		if (pid == our_peerid || PeerConnection.have_conn(pid.kad_id)) continue;

		const path = back_path_parsed.slice(i);
		let bucket_i = routing_table.space_available_bucket(pid.kad_id);
		
		if (routing_table.space_available_sibling_list(pid.kad_id)) {
			// Send a sibling connect message:
			await routing_table.source_route(path, sibling_request_connect());
		} else if (bucket_i != -1) {
			// Send a bucket connect message:
			// await routing_table.source_route(path, kbucket_request_connect(bucket_i));
		}
	}
}