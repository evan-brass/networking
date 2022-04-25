import { our_peerid } from "./peer-id.mjs";

/**
 * We have two options: store the connections inside the topology data structures, or store the 
 * peer id in the data structure.  In either case, we can't solely rely on garbage collection to cleanup the connections.
 * We either need to manually cleanup the connections: either by reference counting or by an intermittent cleanup pass.
 * Currently I've been planning to use reference counting, but I actually like the idea of using strong / weak references
 * instead.  We can use a finalityRegistry to close the connection if the peerid is collected, but we can also actively
 * search the topologies to collect unused connections.  I like this because the difference between claimed and unclaimed
 * is a strong reference vs a weak reference.  Upgrading a connection or downgrading it is easy and doesn't require 
 * calling anything on the connection.
 */

// KBuckets
const k = 2;
const kbuckets = new Array(255);

// Siblings
const siblings_above = [];
const siblings_below = [];

// PeerId -> RTCDataChannel | PeerId
export const routing_table = new WeakMap();

export function known_connection(from, to) {
	const from_entry = routing_table.get(from);
	// If we don't have a path / connection to `from` then there's no point in trying to add a path to `to` through it
	if (!from_entry) return;

	const to_entry = routing_table.get(to);
	// If we already have a direct connection then there's no point in adding a source path.
	if (to_entry instanceof RTCPeerConnection) return;

	// Only replace the existing path entry if we don't have a path to that peer or if it would improve the number of hops in the path
	if (
		!existing ||
		(from_entry instanceof RTCPeerConnection && existing.hops > 1) || // TODO: Take more into account than just the hop count?
		((from_entry.hops + 1) < existing.hops)
	) {
		routing_table.set(to, {
			from,
			hops: (from_entry instanceof RTCPeerConnection) ? 1 : from_entry.hops + 1
		});
	}
}

/**
 * ROUTING:
 * 1. Check the connection_table for a PeerConnection with an open / ready message_channel
 * 2. Check the routing_table for a valid source path.
 * 3. If there's no valid path, then do a kbucket lookup
 * 4. If there's nothing in the kbuckets, then look for a peer that is closest 
 */
/**
 * Eventually, sadly, we will need the ability to send messages reliably.  That means handling broken_path messages by 
 * resending the message without a path.
 */
export async function send_msg(destination /* :Kademlia ID */, msg) {
	const body = JSON.stringify(msg);
	const body_sig = await our_peerid.sign(body);

	const path = [destination];
	let step = routing_table.get(destination);
	while (step !== undefined && !(step instanceof RTCPeerConnection)) {
		path.push(step.from);
		step = routing_table.get(step.from);
	}

	let peer_connection;

	let forward_path, forward_sig;
	if (step === undefined) {
		path.push(step);

		// This is a broken path: Try to route the message to the closest peer (by xor distance).
		
		// If no peer is found, then try to route to the closest peer in linear distance.
	} else {
		peer_connection = step;
		// We have a path, send it to step and pass the forwarding path we collected.
		forward_path = path.map(pid => pid.public_key_encoded).join(',');
		forward_sig = await our_peerid.sign(forward_path);
	}

	// TODO: Use better signatures.  Use recoverable signatures.
	const back_path_sig = await our_peerid.sign(step.public_key_encoded + body_sig);
	const back_path = [`${our_peerid.public_key_encoded}.${back_path_sig}`];

	const data = JSON.stringify({
		forward_path, forward_sig,
		body, body_sig,
		back_path
	});

	await peer_connection.send(data);
}