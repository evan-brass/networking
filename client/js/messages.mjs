import { our_peerid, PeerId } from "./peer-id.mjs";
import { get_peer_id_set, get_routing_table, route, routing_table } from "./routing-table.mjs";
import { PeerConnection } from "./webrtc.mjs";

function create_nonce() {
    return Array.from(crypto.getRandomValues(new Uint8Array(4))).map(v => v.toString(16).padStart(2, '0')).join('');
}

export async function verify_message(data) {
	let {
		origin,
		forward_path, forward_sig,
		body, body_sig,
		back_path
	} = JSON.parse(data);

	// Import the sender's peer_id
	if (!(typeof origin == 'string')) throw new Error("Data missing origin");
	origin = await PeerId.from_encoded(origin);

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

	// Verify the back_path
	if (!Array.isArray(back_path)) throw new Error('missing back_path');
	let last_pid = our_peerid;
	const back_path_parsed = [];
	for (const hop of back_path) {
		if (typeof hop != 'string') throw new Error('non-string in back_path');
		let [peer_id, signature] = hop.split('.');
		peer_id = await PeerId.from_encoded(peer_id ?? '');
		if (!await peer_id.verify(signature ?? '', last_pid.public_key_encoded + body_sig ?? '')) throw new Error('signature failed in back_path.');
		back_path_parsed.unshift(peer_id);
		last_pid = peer_id;
	}
	back_path_parsed.reverse();

	return {
		origin,
		forward_path_parsed,
		body,
		back_path_parsed
	};
}

// Trigger a lookup_node
export async function lookup_node(peer_id) {
	const candidates = routing_table.lookup(peer_id.kad_id, true);
	if (candidates.length > 0) {
		const {value: closest} = candidates[0];
		const body = JSON.stringify({
			type: 'lookup_node',
			nonce: create_nonce(),
			node: peer_id.public_key_encoded
		});
		const body_sig = await our_peerid.sign(body);
		const back_path_sig = await our_peerid.sign(closest.other_id.public_key_encoded + body_sig);
		closest.send(JSON.stringify({
			origin: our_peerid.public_key_encoded,
			body, body_sig,
			back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`]
		}));
		console.log('Snd:', body, closest.other_id);
		return;
	}
	throw new Error("Destination Unreachable");
}

export async function message_handler({ data }) {
	const {origin, forward_path_parsed, body, back_path_parsed} = await verify_message(data);

	// Forward the message if we're not the intended target:
	if (forward_path_parsed && forward_path_parsed[0] !== our_peerid) {
		const {origin, forward_path, forward_sig, body, body_sig, back_path} = JSON.parse(data);
		const routing_table = get_routing_table();
		for (const peer_id of forward_path) {
			if (peer_id == our_peerid) break;
			const peer_connection = routing_table.get(peer_id);
			if (peer_connection) {
				const back_path_sig = await our_peerid.sign(peer_id.public_key_encoded + body_sig);
				peer_connection.send(JSON.stringify({
					origin, forward_path, forward_sig, body, body_sig,
					back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path]
				}));
				console.log('Fwd:', body, origin);
				return;
			}
		}
		throw new Error("Destination Unreachable");
	}

	// Create our reply function:
	async function reply(body) {
		// Create a forward path from the parsed back path:
		const forward_path = back_path_parsed.map(pid => pid.public_key_encoded).join(',');
		const forward_sig = await our_peerid.sign(forward_path);
		if (typeof body != 'string') {
			body = JSON.stringify(body);
		}
		const body_sig = await our_peerid.sign(body);
		const routing_table = get_routing_table();
		// Route the message to the first peer in the back_path that we have a direct connection to.
		for (const peer_id of back_path_parsed) {
			const peer_connection = routing_table.get(peer_id);
			if (peer_connection) {
				const back_path_sig = await our_peerid.sign(peer_id.public_key_encoded + body_sig);
				peer_connection.send(JSON.stringify({
					origin: our_peerid.public_key_encoded,
					forward_path, forward_sig,
					body, body_sig,
					back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`]
				}));
				console.log('Rep:', body);
				return;
			}
		}
		throw new Error("Destination Unreachable");
	}

	console.log('Rec:', body, origin);

	// Handle the message:
	if (body.type == 'lookup_node') {
		if (origin == our_peerid) return;
		const node = await PeerId.from_encoded(body.node);
		const closer = routing_table.lookup(node.kad_id).map(({value}) => value);
		await reply({
			type: 'lookup_ack',
			nonce: body.nonce,
			closer: closer.map(conn => conn.other_id.public_key_encoded)
		});
		if (closer.length > 0) {
			// Route the lookup to the closest node:
			const {origin, body, body_sig, back_path} = JSON.parse(data);
			const back_path_sig = await our_peerid.sign(closer[0].other_id.public_key_encoded + body_sig);
			closer[0].send(JSON.stringify({
				origin, body, body_sig,
				back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path]
			}));
		}
	} else if (body.type == 'lookup_value') {
		// TODO: check our stored values
	} else if (body.type == 'lookup_ack') {
		const peers = await Promise.all(body.closer.map(encoded => PeerId.from_encoded(encoded)));
		const peer_id_set = get_peer_id_set();
		for (const peer of peers) {
			if (peer != our_peerid && !peer_id_set.has(peer) && routing_table.should_add(peer.kad_id)) {
				// Create a peerconnection for this peer:
				const pc = new PeerConnection();
				pc.other_id = peer;
				const offer = pc.negotiate();
				await reply({
					type: 'connect',
					nonce: create_nonce(),
					sdp: offer
				});
				peer_id_set.add(peer);
			}
		}
	} else if (body.type == 'connect') {
		const ret_description = await PeerConnection.handle_connect(origin, body.sdp);
		if (ret_description) {
			await reply({
				type: 'connect',
				nonce: body.nonce,
				sdp: ret_description
			});
		}
	}
}

const message_format = {
	// Encoded public key of the original sender:
	origin: "",
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