import { get_expiration } from "./lib.mjs";
import { PeerId, sign, our_peerid } from "./peer-id.mjs";
import { add_conn as k_add_conn, remove_conn as k_remove_conn, lookup, could_fit } from "./kbuckets.mjs";
import { add_conn as s_add_conn, remove_conn as s_remove_conn, closer, sib_fit } from "./siblings.mjs";

export const wanted_conns = new EventTarget();
class WantedEvent extends CustomEvent {
	constructor(pid) {
		super('wanted');
		this.peer_id = pid;
	}
}

/**
 * Routing:
 * We have several topologies that we want to maintain:
 * 1. Siblings
 * 2. Kademlia
 * 
 * We also have a Source Routing tree that lets us send messages to any peers we've heard about.  At the same time, we don't want to store 
 * information for every possible peer in the network (hopefully millions) so we use a weakmap.  That way the information gets cleaned up
 * as neccessary.
 * 
 * We can either send a message to a specific peer or we can send a message to the closest peer to a particular kad-id.
 * What distinguishes the two is that a message to a specific peer won't have a target field.
 * Both kinds of messages can have a path (which is a source route to a specific peer).  The reason for this is that we may need to source
 * route around malicious / non-responsive / faulty peers while trying to send a message to a perticular kad-id.
 * 
 * The path field is a suggestion.  If the path is broken, and this is a kad-id message, then we need to route to the closest peer to the kad-id.  If the path is broken, and this is not a kad-id message then we route the message to the closest peer to the first item in
 * the path.  Whenever there's no path or when the path is broken, we send routing acknowledgement messages back to the sender.
 * If we receive a kad-id message and we don't know any closer peers, then we handle the message ourself.  If we receive a non-kad-id
 * message and we don't know any closer peers to the destination's kad-id, then we drop the message.  This will trigger the sender's timeout.
 */

// PeerId -> PeerId | PeerConnection
const sr_tree = new WeakMap();

export function known_path(from, to) {
	const from_entry = sr_tree.get(from);
	if (!from_entry) return;

	const existing = sr_tree.get(to);
	if (existing == undefined || existing instanceof PeerId) {
		sr_tree.set(to, from);

		// If the discovered peer is one we want a connection to then we should send it to wanted_conns
		if (could_fit(to) || sib_fit(to)) {
			wanted_conns.dispatchEvent(new WantedEvent(to));
		}
	}
}

export function add_conn(peer_connection) {
	sr_tree.set(peer_connection.other_id, peer_connection);

	// Add to buckets
	k_add_conn(peer_connection);

	// Add to siblings
	s_add_conn(peer_connection);
}
export function remove_conn(peer_connection) {
	const existing = sr_tree.get(peer_connection.other_id);
	if (existing === peer_connection) {
		sr_tree.delete(peer_connection.other_id)
	}

	// Remove from kbucket:
	k_remove_conn(peer_connection);

	// Remove siblings
	s_remove_conn(peer_connection);
}
export function closest_conn(kad_id) {
	// Pick the closest connection by kad_id
	let conn;
	for (const c of lookup(kad_id)) {
		conn = c;
		break;
	}
	if (conn) return conn;

	// If we don't have a peer that's closer in Kademlia space, then send to a peer that is closer in linear space.
	return closer(kad_id);
}
export async function send(connOrPidOrTarget, msg) {
	// Add any required message fields if they're not present:
	if (!msg.expiration) msg.expiration = get_expiration();

	let path, target, conn;
	if (connOrPidOrTarget instanceof PeerId) {
		let entry = connOrPidOrTarget;
		path = [];
		for (; entry instanceof PeerId; entry = sr_tree.get(entry)) {
			path.push(entry.encoded);
		}
		if (entry === undefined) {
			// The path must be broken.
			path = [connOrPidOrTarget.encoded];
			conn = closest_conn(connOrPidOrTarget.kad_id);
		} else {
			conn = entry;
		}

		// Encrypt data if needed:
		if (msg.encrypted) msg.encrypted = await connOrPidOrTarget.encrypt(JSON.stringify(msg.encrypted));
	} else if (connOrPidOrTarget instanceof BigInt) {
		target = connOrPidOrTarget.toString(16);

		// Find the conn closest to the target
		conn = closest_conn(target);
	} else {
		// I wish that I could add an instanceof check that it's a PeerConnection, but that would introduce a recursive dependency.
		conn = connOrPidOrTarget;
	}
	const body = JSON.stringify({
		path, target,
		...msg
	});
	const body_sig = await sign(body);
	const back_path = [];

	await send_data(conn, { body, body_sig, back_path });
}
export async function send_data(conn, { body, body_sig, back_path }) {
	const back_path_sig = await sign(conn.other_id.encoded + body_sig);
	const new_back_path = [`${our_peerid.encoded}.${back_path_sig}`, ...back_path];
	if (conn?.dc?.readyState === 'open') {
		await conn.dc.send(JSON.stringify({
			body, body_sig,
			back_path: new_back_path
		}));
	}
}