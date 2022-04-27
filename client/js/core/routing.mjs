import { PeerId } from "./peer-id.mjs";

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

const k = 2;
// [[PeerConnection: k]: 255]
const buckets = new Array(255);

const s = k;
// [PeerConnection]
const siblings_above = [];
const siblings_below = [];

// PeerId -> PeerConnection
const connections = new Map();
// PeerId -> PeerId
const sr_tree = new WeakMap();

export function known_path(from, to) {
	// TODO: implement
}

export function add_conn(peer_connection) {
	console.log(peer_connection);
}
export function remove_conn(peer_connection) {
	console.log(peer_connection);
}
export async function send(pidOrTarget, msg) {
	let path, target;
	if (pidOrTarget instanceof PeerId) {

	} else {

	}
}
export async function send_data({ body, body_sig, back_path }) {
	// Routing algorithm:
	// 1. Try to route to the closest entry in the source_route entry
	// 2. Try to kademlia route towards the target or kad_id of the last entry of the source_route
	// 3. Try to route to the target in linear distance or 
}