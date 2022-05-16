/**
 * 1. Organizes all of the PeerConnections that we already have to maintain a structured network.
 * 2. Decided which peers (that we've heard about) that we should open a connection to
 * 2b. Order the connections we have so that the least significant ones can be closed.
 * 3. Lists which connections would move a packet closer to its intended destination
 */

const kbuckets = [];

export function add_connection(peer_id, channel) {

}

export function discovered_peer(peer_id) {
	// TODO: Return a weight indicating whether or not we should connect to this peer.
	return { weight: 1, replace: old_peer_id };
}

export function* next_hop(target) {
	// 
}