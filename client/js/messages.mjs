import { our_peerid, PeerId } from "./peer-id.mjs";
import { routing_table } from "./routing-table.mjs";
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
		type: "we're siblings",
		nonce: create_nonce()
	});
}

async function sniff_backpath(back_path_parsed) {
	for (let i = 0; i < back_path_parsed.length; ++i) {
		const pid = back_path_parsed[i];
		if (pid != our_peerid && routing_table.space_available(pid.kad_id)) {
			// Try to create a peerconnection to this peer:
			const sdp = await PeerConnection.handle_connect(pid);
			if (sdp) {
				await source_route(back_path_parsed.slice(i), {
					type: 'connect',
					nonce: create_nonce(),
					sdp
				});
			}
		}
	}
}

export async function message_handler({ data }) {
	const {origin, forward_path_parsed, body, back_path_parsed} = await verify_message(data);

	// Sniff Back path and consider connecting to the peers in it:
	sniff_backpath(back_path_parsed);

	// Forward the message if we're not the intended target:
	if (forward_path_parsed && forward_path_parsed[0] !== our_peerid) {
		await routing_table.forward(forward_path_parsed, data);
	}

	console.log('Rec:', body);

	// Handle the message:
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

const message_format = {
	/**
	 * The forward path is the intended path that this message will take.
	 * The forward path is reversed (the target is the first item, the second to last hop is the second, etc.).
	 * A peer routes to the first peer it has a connection two in the list or until it reaches it's own peer_id in which case it aborts with an unreachable error.
	 * Because of this, hops that are in the forward_path can be skipped.
	 * Once the target of the forward_path is reached (if the message continues being forwarded) the forward_path and forward_sig can be removed because all the needed routing information is held in the back_path and the forward_path is no longer relevant.
	 */
	forward_path: '<public_key_encoded>,<public_key_encoded>,...',
	forward_sig: "", 
	body: { // The body will be a JSON string, however we show it as an object here.
		type: '',
		nonce: "",
		/* Additional Message Data */
	},
	body_sig: "", // The original sender's signature of the body.
	back_path: [
		'<public_key_encoded of the sender>.<signature of the public_key_encoded that they forwarded the message to>',
		/**
		 * The back_path is constructed as a message gets forwarded.  It reflects the actual path that a message takes.
		 * A peer can use the back_path to construct a forward_path.  This is how replying works.
		 * We need to make sure that it can't be tampered with by any intermediate routing peers:
		 * 1. It must not be reorderable
		 * 2. It must not be editable except to extend it at the tail.
		 * 3. TODO: It must be message specific so that old back_paths can't be added to new messages
		 * An entry in the backpath is the encoded public key of the sender + a signature of the public key of the peer that they are about to forward the message to (TODO: concatonated with the body_sig for the message).
		 * Like the forward_path, the back_path is edited at the front.
		 * By keeping the forward_path and (more importantly) the back_path separate from the body, we can sniff potentially useful routing information without needing to parse the message body.
		 * To Check the validity of the back_path and to construct a forward_path:
		 * 1. Check that the first entry is a signature of our encoded_public_key
		 * 2. Check that subsequent entries have a valid signature for the preceding encoded_public_key
		 */
	]
};

const message_types = [
	// Query type messages (these messages include a random nonce)
	{	type: 'lookup_node',
		node: '<public_key_encoded>'
	}, {
		type: 'lookup_value',
		key: '<kad_id as hex>'
	}, {
		// TDOO:
		type: 'store_value',
		key: '<kad_id as hex>',
		value: '<any reasonably sized string>'
	}, {
		// TODO: Message types to request / respond with addresses
	}, {
		// TODO: Send messages to siblings?
	},
	// Response type messages (these messages echo the nonce from the request)
	{	type: 'lookup_ack',
		closer: [ // max 5 closest peer_ids that this peer knows to that kad_id
			'<public_key_encoded>'
		]
	}, {
		// TODO:
		type: 'lookup_value',
		value: "<any reasonably sized string>"
	}
];