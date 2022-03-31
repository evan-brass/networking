import { PeerConnection } from "./webrtc.mjs";
import { our_peerid } from "./peer-id.mjs";
import { kad_dst } from "./kad.mjs";

// There are existing k-bucket implementations out there but I don't think they use bigint.

// k is the max number of items that can be held inside a KBucketLeaf
const k = 1;
// Maximum number of values to return from the routing table:
const num_ret = 5;
// We maintain at least the _ closest peers (even if they don't fit exactly in the same bucket as our peer_id)
const sibling_list_size = 2;
// TODO: Sort the returned items by their distance to the kad_id being looked up.
// The Routing table stores kad_id -> PeerConnections
// We'll need a separate table to store kad_id -> values if we want DHT functionality
function linear_dist(a, b) {
	if (typeof a != 'bigint' || typeof b != 'bigint') throw new Error('Must be bigints');
	let ret = a - b;
	if (ret < 0n) ret *= -1n;
	return ret;
}
class RoutingTable {
	root = new KBucketLeaf(255n, this);
	sibling_list = [];
	could_insert(kad_id) {
		// TODO: check to make sure that we don't already have kad_id in the routing table?
		if (this.sibling_list < sibling_list_size) return true;
		if (this.sibling_list_size > 0) {
			// Check if this could displace a sibling:
			const new_dist = linear_dist(our_peerid.kad_id, kad_id);
			const dist_head = linear_dist(our_peerid.kad_id, this.sibling_list[0].other_id.kad_id);
			if (new_dist < dist_head) return true;
			const dist_tail = linear_dist(our_peerid.kad_id, this.sibling_list[this.sibling_list.length - 1].other_id.kad_id);
			if (new_dist < dist_tail) return true;
		}
		return this.root.could_insert(kad_id);
	}
	lookup(kad_id) {
		// Check the sibling_list first
		let ret = Array.from(this.sibling_list);
		ret.push(...this.root.lookup(kad_id));
		// Sort the results:
		ret.sort((con_a, con_b) => {
			const dst_a = kad_dst(kad_id, con_a.other_id.kad_id);
			const dst_b = kad_dst(kad_id, con_b.other_id.kad_id);
			if (dst_a < dst_b) {
				return -1;
			} else {
				return 1;
			}
		});

		return ret.slice(0, num_ret);
	}
	insert(peer_connection) {
		// Check if the peer_connection should go into our sibling list:
		if (this.sibling_list.length < sibling_list_size) {
			this.sibling_list.push(peer_connection);
			this.sibling_list.sort((con_a, con_b) => (con_a.other_id.kad_id < con_b.other_id.kad_id) ? -1 : 1);
			return true;
		} else if (sibling_list_size > 0) {
			const new_dist = linear_dist(our_peerid.kad_id, peer_connection.other_id.kad_id);
			const dist_head = linear_dist(our_peerid.kad_id, this.sibling_list[0].other_id.kad_id);
			const dist_tail = linear_dist(our_peerid.kad_id, this.sibling_list[this.sibling_list.length - 1].other_id.kad_id);
			let displaced;
			if (new_dist < dist_head) {
				displaced = this.sibling_list.shift();
				this.sibling_list.unshift(peer_connection);
			} else if (new_dist < dist_tail) {
				displaced = this.sibling_list.pop();
				this.sibling_list.push(peer_connection);
			} else {
				return this.root.insert(peer_connection);
			}
			this.sibling_list.sort((con_a, con_b) => (con_a.other_id.kad_id < con_b.other_id.kad_id) ? -1 : 1);
			if (!this.root.insert(displaced)) {
				// TODO: release the displaced peer_connection
				displaced.abandon();
			}
			return true;
		} else {
			return this.root.insert(peer_connection);
		}
	}
	remove(peer_connection) {
		const index = this.sibling_list.indexOf(peer_connection);
		if (index != -1) {
			this.sibling_list.splice(index, 1);
			const candidates = this.root.lookup(our_peerid.kad_id);
			candidates.sort((con_a, con_b) => {
				const dst_a = kad_dst(our_peerid.kad_id, con_a.other_id.kad_id);
				const dst_b = kad_dst(our_peerid.kad_id, con_b.other_id.kad_id);
				if (dst_a < dst_b) {
					return -1;
				} else {
					return 1;
				}
			});
			if (candidates.length > 0) {
				const new_sibling = candidates[0];
				this.root.remove(new_sibling);
				// Reinsert the new_sibling so that it get's put into the sibling list.
				this.insert(new_sibling);
			}
		} else {
			this.root.remove(peer_connection);
		}
	}
}
class KBucketInternal {
	left = undefined;
	right = undefined;
	parent = null;
	bit;
	constructor(bit, parent) { this.bit = bit; this.parent = parent; }
	#side(kad_id) {
		const mask = 1n << this.bit;
		const side = ((kad_id & mask) == 0n) ? this.left : this.right;
		return side;
	}
	could_insert(kad_id) {
		const side = this.#side(kad_id);
		return side.could_insert(kad_id);
	}
	lookup(kad_id) {
		const side = this.#side(kad_id);
		const ret_side = side.lookup(kad_id);
		if (ret_side.length < k) {
			// Include results from the other side as well
			const other_side = (side == this.left) ? this.right : this.left;
			return [...ret_side, ...other_side.lookup(kad_id)];
		}
		return ret_side;
	}
	insert(peer_connection) {
		const side = this.#side(peer_connection.other_id.kad_id);
		return side.insert(peer_connection);
	}
	remove(peer_connection) {
		const side = this.#side(peer_connection.other_id.kad_id);
		side.remove(peer_connection);
	}
}
class KBucketLeaf {
	inner = new Set();
	parent = null;
	bit;
	// Our bit space is 256, so we mask the msb with 1n << 256n
	constructor(bit = 255n, parent = null) { this.bit = bit; this.parent = parent; }
	#can_split() {
		if (this.bit == 0n) {
			// If we're already at the end of the id_space then we can't split any further.
			return false;
		} else if (this.parent instanceof KBucketInternal) {
			// Check if we are the left(0) or right(1) child of our parent
			const we_left = this.parent.left == this;
			// Check if our peerid at this bit is left(0) or right(1)
			const peer_id_left = (our_peerid.kad_id & (1n << this.bit)) == 0n;
			// If we are the same as our_peerid at this bit then we can be split
			return we_left == peer_id_left;
		} else {
			return true; // If we're the top node, then we deffinitely include our_peerid
		}
	}
	could_insert(_kad_id) {
		return this.inner.size < k;
	}
	lookup(_kad_id) {
		// Clone our inner array
		return Array.from(this.inner);
	}
	insert(peer_connection) {
		if (!this.inner.has(peer_connection) && this.inner.size < k) {
			this.inner.add(peer_connection);
			return true;
		} else if (this.#can_split()) {
			// Split
			const new_internal = new KBucketInternal(this.bit, this.parent);
			new_internal.left = new KBucketLeaf(this.bit - 1n, new_internal);
			new_internal.right = new KBucketLeaf(this.bit - 1n, new_internal);
			if (this.parent.left == this) {
				this.parent.left = new_internal;
			} else if (this.parent.right == this) {
				this.parent.right = new_internal;
			} else if (this.parent.root) {
				this.parent.root = new_internal;
			}
			// Insert our existing items into the new buckets
			for (const connection of this.inner) {
				new_internal.insert(connection);
			}
			// Insert the new item that we were asked to insert
			return new_internal.insert(peer_connection);
		}
		return false;
	}
	remove(peer_connection) {
		if (this.inner.has(peer_connection)) {
			this.inner.delete(peer_connection);
			if (this.inner.size == 0 && this.parent instanceof KBucketInternal) {
				// Remove this K-Bucket and replace its parent with the other side of the internal node
				const other_side = (this.parent.left == this) ? this.parent.right : this.parent.left;
				other_side.bit += this.parent.bit;
				other_side.parent = this.parent.parent;
				// Update our parent's parent
				if (this.parent.parent.left == this.parent) {
					this.parent.parent.left = other_side;
				} else if (this.parent.parent.right == this.parent) {
					this.parent.parent.right = other_side;
				} else if (this.parent.parent.root == this.parent) {
					this.parent.parent.root = other_side;
				}
			}
		}
	}
}
export const routing_table = new RoutingTable();

// Insert / Remove PeerConnections into our k_buckets
PeerConnection.events.addEventListener('connected', ({ detail: new_connection }) => {
	if (!routing_table.insert(new_connection)) {
		console.log("didn't insert new connection", new_connection);
		setTimeout(() => new_connection.abandon(), 5000);
	}
});
PeerConnection.events.addEventListener('disconnected', ({ detail: old_connection }) => {
	routing_table.remove(old_connection);
});

export function get_routing_table() {
	// This time around, I'm trying to have the routing table be a snapshot of the current connections.  In the future when more complex routing is needed it can't be that way (we may need to store routing paths not just datachannels) but we'll cross that bridge when we come to it.
	// peer_id -> rtcdatachannel
	const routing_table = new Map();
	for (const pc of PeerConnection.connections) {
		if (pc.other_id) {
			const dc = pc.get_hn_dc();
			if (dc?.readyState == 'open') routing_table.set(pc.other_id, dc);
		}
	}
	return routing_table;
}
// Get all of the peer_ids that we have even if they aren't routable yet:
export function get_peer_id_set() {
	const peer_set = new Set();
	for (const pc of PeerConnection.connections) {
		if (pc.other_id) {
			peer_set.add(pc.other_id);
		}
	}
	return peer_set;
}

export async function source_route(path, body) {
	// Sorry about the naming... Things have changed around quite a few times, but the peer_table is a table of all the peers that we have direct webrtc connections to, that also has an open rtcdatachannel.
	const peer_table = get_routing_table();
	for (const pid of path) {
		const connection = peer_table.get(pid);
		if (connection) {
			console.log('Snd:', body, connection.other_id);
			body = JSON.stringify(body);
			const body_sig = await our_peerid.sign(body);
			// TODO: only include the forward path if we aren't sending directly to the intended target
			const forward_path = path.map(pid => pid.public_key_encoded).join(',');
			const forward_sig = await our_peerid.sign(forward_path);
			const back_path_sig = await our_peerid.sign(pid.public_key_encoded + body_sig);
			const back_path = [`${our_peerid.public_key_encoded}.${back_path_sig}`];
			connection.send(JSON.stringify({
				origin: our_peerid.public_key_encoded,
				forward_path, forward_sig,
				body, body_sig,
				back_path
			}));
			return;
		}
	}
	throw new Error('Destination Unreachable');
}