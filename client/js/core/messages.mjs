import { our_peerid, PeerId } from "./peer-id.mjs";
import { PeerConnection } from './peer-connection.mjs';
import { check_expiration } from "./lib.mjs";

const unroutable = ['topic_broadcast'];
const fwd_only = ['siblings', 'not_siblings', 'connect'];

// Messages that have been verified will be sent as events on this object.
// Additionally, we have the special 'route' message
export const messages = new EventTarget();

class MessageEvent extends CustomEvent {
	constructor(props = {}, type = props.msg?.type) {
		super(type);
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

PeerConnection.events.addEventListener('network-message', async ({ connection, data }) => {
	const parts = await verify_message(data);
	parts.connection = connection;

	if (parts.back_path_parsed[parts.back_path_parsed.length - 1] !== connection.other_id) {
		throw new Error("The other_id of the connection that this message came in on didn't put itself in the back_path properly.");
	}

	// Forward the message if we're not the intended target:
	if (parts.forward_path_parsed && parts.forward_path_parsed[0] !== our_peerid) {
		await PeerConnection.source_route_data(parts.forward_path_parsed, parts);
		return;
	}

	// Issue the message as an event:
	console.log('recv', parts.msg);
	const not_handled = messages.dispatchEvent(new MessageEvent(parts));

	// If the event does not have its propagation stopped, then route the message to a closer peer
	if (not_handled && !unroutable.includes(parts.body.type)) {
		messages.dispatchEvent(new MessageEvent(parts, 'route'));
	}
});

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

	// Check if the body has all required fields?
	if (typeof msg?.type != 'string') throw new Error('Message was missing a type.');

	// Routable messages need an expiration so that they can't be replayed.  Unroutable messages don't need an expiration because we the message comes directly from the sender.
	let target;
	if (!unroutable.includes(msg.type)) {
		check_expiration(msg.expiration);

		if (!fwd_only.includes(msg.type)) {
			if (typeof msg.target != 'string') {
				throw new Error('Routable messages need a target which is the destination that we are trying to route toward.');
			} else {
				target = BigInt('0x' + msg.target);
			}
		}
	} else {
		if (forward_path_parsed) throw new Error("Can't have a forward path on an unroutable message");
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