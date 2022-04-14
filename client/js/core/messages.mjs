import { our_peerid, PeerId } from "./peer-id.mjs";
import { PeerConnection } from './peer-connection.mjs';
import { lookup } from "./kbuckets.mjs";

const unroutable = ['siblings', 'not_siblings', 'topic_broadcast'];

// Messages that have been verified will be sent as events on this object.
export const messages = new EventTarget();

export async function route(kad_id, msg) {
	const body = JSON.stringify(msg);
	const body_sig = await our_peerid.sign(body);
	await route_data(kad_id, body, body_sig, []);
}
export async function route_data(kad_id, body, body_sig, back_path) {
	const conns = [];
	for (const connection of lookup(kad_id)) {
		conns.push(connection);
		if (conns.length >= 5) break;
	}
	
	const connection = conns[0];
	if (connection) {
		// Route the message to the connection
		const back_path_sig = await our_peerid.sign(connection.other_id.public_key_encoded + body_sig);
		connection.send(JSON.stringify({
			body, body_sig,
			back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path]
		}));
	}

	// TODO: send a routing_acknowledge
}

class MessageEvent extends CustomEvent {
	constructor(origin, body, body_str, body_sig, back_path_parsed, back_path) {
		super(body.type);
		this.origin = origin;
		this.body = body;
		this.back_path = back_path;
		this.body_str = body_str;
		this.body_sig = body_sig;
		this.back_path_parsed = back_path_parsed;
	}
}
PeerConnection.events.addEventListener('network-message', async ({ connection, data }) => {
	const {origin, forward_path_parsed, body, body_str, body_sig, back_path_parsed, back_path} = await verify_message(data);

	if (back_path_parsed[0] !== connection.other_id) {
		throw new Error("The other_id of the connection that this message came in on didn't put itself in the back_path properly.");
	}

	// Forward the message if we're not the intended target:
	if (forward_path_parsed && forward_path_parsed[0] !== our_peerid) {
		PeerConnection.source_route_data(forward_path_parsed, )
		await routing_table.source_route_data(forward_path_parsed, JSON.parse(data));
		return;
	}

	// Issue the message as an event:
	const not_handled = messages.dispatchEvent(new MessageEvent(origin, body, body_str, body_sig, back_path_parsed, back_path));

	// If the event does not have its propagation stopped, then route the message to a closer peer
	if (not_handled) {
		// Route the message closer to the message's target.
		await route_data(body.target, {
			body: body_str, body_sig, back_path
		});
	}
});

export function get_expiration(future = 5 /* min. in the future that the expiration will expire. */) {
	// Timestamp for right now in seconds.
	return BigInt(Date.now() / 1000 + future * 1000 * 60).toString(16);
}

export async function verify_message(data, last_pid = our_peerid) {
	let {
		forward_path, forward_sig,
		body: body_str, body_sig,
		back_path
	} = JSON.parse(data);

	// Verify the back_path
	if (!Array.isArray(back_path)) throw new Error('missing back_path');
	const back_path_parsed = [];
	if (back_path.length < 1) throw new Error("back path can't be empty.");
	for (const hop of back_path) {
		if (typeof hop != 'string') throw new Error('non-string in back_path');
		let [peer_id, signature] = hop.split('.');
		peer_id = await PeerId.from_encoded(peer_id ?? '');
		if (!await peer_id.verify(signature ?? '', last_pid.public_key_encoded + body_sig ?? '')) throw new Error('signature failed in back_path.');
		back_path_parsed.unshift(peer_id);

		// TODO: The following check might not work, when verifying forwarded subscribe messages
		if (peer_id == our_peerid) throw new Error('Routing cycle detected in the back-path');

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
	let body;
	if (typeof body_str != 'string') throw new Error('message was missing a body');
	if (!origin.verify(body_sig ?? '', body_str)) throw new Error('body_sig invalid.');
	body = JSON.parse(body_str);
	
	// Parse the body:
	body = JSON.parse(body_str);

	// Check if the body has all required fields?
	if (typeof body?.type != 'string') throw new Error('Message was missing a type.');

	// Routable messages need an expiration so that they can't be replayed.  Unroutable messages don't need an expiration because we the message comes directly from the sender.
	let target;
	if (!unroutable.includes(body.type)) {
		if (typeof body.expiration != 'string') throw new Error('Message needs an expiration that is formated as a hex string.');
		if (typeof body.target != 'string') {
			throw new Error('Routable messages need a target which is the destination that we are trying to route toward.');
		} else {
			target = BigInt('0x' + body.target);
		}
		const expiration = BigInt('0x' + body.expiration);
		const now = BigInt(Date.now() / 1000);
		if (expiration < now) throw new Error('Message has expired.');
		// TODO: check if the expiration is too far out.  (what's a reasonable maximum expiration for messages? 10min? 30min?)
	} else {
		if (forward_path_parsed) throw new Error("Can't have a forward path on an unroutable message");
		if (back_path_parsed.length != 1) throw new Error("Unroutable message was not sent directly to use.");
	}

	// TODO: Handle encryption

	return {
		origin, target,
		forward_path_parsed,
		body, body_str, body_sig,
		back_path_parsed, back_path
	};
}