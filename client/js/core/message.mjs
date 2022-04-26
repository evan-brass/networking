import { decrypt, PeerId, sign } from "./peer-id.mjs";
import { check_expiration } from "./lib.mjs";
import { known_connection } from "./routing.mjs";


// Message that can only be sent directly from peer to peer
const routable = ['kbucket'];
// Messages which can only be source_routed (no kademlia routing)
const forwardable = ['siblings', 'not_siblings', 'connect', 'route_ack'];

// Messages that have been verified will be sent as events on this object.
// Additionally, we have the special 'route' message
export const messages = new EventTarget();

export class MessageEvent extends CustomEvent {
	constructor(props = {}, type = props.msg?.type) {
		super(type, { cancelable: true });
		for (const key in props) {
			Object.defineProperty(this, key, {
				value: props[key],
				writable: false
			});
		}
	}
	async reply(msg) {
		this.stopImmediatePropagation();
		await PeerConnection.source_route(this.back_path_parsed, msg);
	}
}

export async function verify_message(data, last_pid = our_peerid) {
	let {
		forward_path, forward_sig,
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
		if (!await peer_id.verify(signature ?? '', last_pid.public_key_encoded + body_sig ?? '')) throw new Error('signature failed in back_path.');
		back_path_parsed.unshift(peer_id);

		// nd_connect(last_pid, peer_id);

		known_connection(last_pid, peer_id);

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
	if (typeof body != 'string') throw new Error('message was missing a body');
	if (!origin.verify(body_sig ?? '', body)) throw new Error('body_sig invalid.');

	// Parse the body
	const msg = JSON.parse(body);

	// Decrypt any encrypted message data
	if (msg.encrypted) {
		Object.assign(msg, JSON.parse(await decrypt(msg.encrypted)));
	}

	// Check if the body has all required fields?
	if (typeof msg?.type != 'string') throw new Error('Message was missing a type.');

	// Routable messages need an expiration so that they can't be replayed.  Unroutable messages don't need an expiration because we the message comes directly from the sender.
	let target;
	if (routable.includes(msg.type)) {
		target = BigInt('0x' + msg.target);
		check_expiration(msg.expiration);
	} else if (forwardable.includes(msg.type)) {
		check_expiration(msg.expiration);
	} else {
		if (back_path_parsed.length != 1) throw new Error("Unroutable message was not sent directly to use.");
	}

	// TODO: Handle encryption

	return {
		origin, target,
		forward_path_parsed, forward_path, forward_sig,
		msg, 
		body, body_sig,
		back_path_parsed, back_path
	};
}