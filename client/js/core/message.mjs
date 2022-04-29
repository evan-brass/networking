import { decrypt, PeerId, sign, our_peerid } from "./peer-id.mjs";
import { check_expiration } from "./lib.mjs";
import { known_path, closest_conn } from "./routing.mjs";

export const messages = new EventTarget();

class MessageEvent extends CustomEvent {
	constructor(props, type = props?.msg?.type ?? "unknown") {
		super(type, { cancelable: true });
		Object.assign(this, props);
	}
}

export async function handle_data(conn, { data }) {
	const {origin, msg, body, body_sig, back_path_parsed, back_path} = await verify_message(data);

	// Check to make sure that whoever forwarded this to us put themself into the back_path properly
	if (back_path_parsed[back_path_parsed.length - 1] !== conn.other_id) {
		throw new Error("The other_id of the connection that this message came in on didn't put itself in the back_path properly.");
	}

	// Forward the message if we're not the intended target:
	if (msg.target instanceof BigInt || (msg.path && msg.path[0] != our_peerid)) {
		// Check if we know of any closer peers:
		const target = msg.target ?? msg.path[0].kad_id;
		const conn = closest_conn(target);
		if (conn) {
			await send_data(conn, {body, body_sig, back_path});
			// TODO: send an ack message and then return.
			return;
		}
	}

	// Try to encrypt any data if we are the intended recipient
	if (msg.target == our_peerid.kad_id || msg.path && msg.path[0] == our_peerid) {
		if (msg.encrypted) {
			Object.assign(msg, JSON.parse(await decrypt(msg.encrypted)));
		}
	}

	// Issue the message as an event:
	console.log('recv', msg);

	messages.dispatchEvent(new MessageEvent({ origin, msg, body, body_sig, back_path_parsed, back_path }));
}

export async function verify_message(data, last_pid = our_peerid) {
	let {
		body, body_sig,
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
		if (!await peer_id.verify(signature ?? '', last_pid.encoded + body_sig ?? '')) throw new Error('signature failed in back_path.');
		back_path_parsed.unshift(peer_id);

		// nd_connect(last_pid, peer_id);

		known_path(last_pid, peer_id);

		// TODO: The following check might not work, when verifying forwarded subscribe messages
		if (peer_id == our_peerid) throw new Error('Routing cycle detected in the back-path');

		last_pid = peer_id;
	}
	const origin = back_path_parsed[0];

	// Verify the body:
	if (typeof body != 'string') throw new Error('message was missing a body');
	if (!origin.verify(body_sig ?? '', body)) throw new Error('body_sig invalid.');

	// Parse the body
	const msg = JSON.parse(body);

	// Decode the entries in the path field (if there are any)
	if (msg.path) {
		msg.path = msg.path.map(e => PeerId.from_encoded(e));
	}

	// If there's no path, then there must be a target field:
	if (msg.target) {
		msg.target = BigInt('0x' + msg.target);
	}

	// Check the expiration
	check_expiration(msg.expiration);

	// Check if the body has all required fields?
	if (typeof msg?.type != 'string') throw new Error('Message was missing a type.');

	return {
		origin, msg, back_path_parsed,

		body, body_sig, back_path
	};
}