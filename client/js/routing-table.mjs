import { sign_message } from "./messages.mjs";
import { PeerConnection } from "./webrtc.mjs";
import { our_peerid } from "./peer-id.mjs";
import { kad_dst } from "./kad.mjs";

// There are existing k-bucket implementations out there but I don't think they use bigint.

// k is the max number of items that can be held inside a KBucketLeaf
const k = 2;
// Maximum number of values to return from the routing table:
const num_ret = 5;
// We maintain at least the _ closest peers (even if they don't fit exactly in the same bucket as our peer_id)
const sibling_list_size = 3;
// TODO: Sort the returned items by their distance to the kad_id being looked up.
// The Routing table stores kad_id -> PeerConnections
// We'll need a separate table to store kad_id -> values if we want DHT functionality
class RoutingTable {
	root = new KBucketLeaf(255n, this);
	sibling_list = [];
	lookup(kad_id) {
		// Check the sibling_list first
		const ret = Array.from(this.sibling_list);
		ret.push(...this.root.lookup(kad_id));
		// Sort the results:
		ret.sort(({kad_id: a}, {kad_id: b}) => {
			const dst_a = kad_dst(kad_id, a);
			const dst_b = kad_dst(kad_id, b);
			if (dst_a < dst_b) {
				return -1;
			} else {
				return 1;
			}
		});
		return ret.slice(0, num_ret);
	}
	insert(kad_id, value) {
		// TODO: Insert the kad_id into the sibling list, sort the list, then displace the furthest item from our peer_id if the list is too long.
		value.claim();
		this.sibling_list.push({kad_id, value});
		this.sibling_list.sort(({kad_id: a}, {kad_id: b}) => (a < b) ? -1 : 1);

		if (this.sibling_list.length > sibling_list_size) {
			const dist_head = kad_dst(our_peerid.kad_id, this.sibling_list[0].kad_id);
			const dist_tail = kad_dst(our_peerid.kad_id, this.sibling_list[this.sibling_list.length - 1].kad_id);
			const displaced = (dist_head > dist_tail) ? this.sibling_list.shift() : this.sibling_list.pop();
			this.root.insert(displaced.kad_id, displaced.value);
		}
	}
	remove(kad_id) {
		// Remove from the sibling_list and the k_buckets
		this.sibling_list = this.sibling_list.filter(({kad_id: i, value}) => {
			if (i == kad_id) {
				value.release();
				return false;
			} else {
				return true;
			}
		});
		this.root.remove(kad_id);
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
	lookup(kad_id) {
		const side = this.#side(kad_id);
		const ret_side = side.lookup(kad_id);
		if (ret_side.size < k) {
			// Include results from the other side as well
			const other_side = (side == this.left) ? this.right : this.left;
			return [...ret_side, ...other_side.lookup(kad_id)];
		}
		return ret_side;
	}
	insert(kad_id, value) {
		const side = this.#side(kad_id);
		return side.insert(kad_id, value);
	}
	remove(kad_id) {
		const side = this.#side(kad_id);
		side.remove(kad_id);
	}
}
class KBucketLeaf {
	inner = [];
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
	lookup(_kad_id) {
		// Clone our inner array
		return Array.from(this.inner);
	}
	insert(kad_id, value) {
		if (this.inner.length < k) {
			this.inner.push({kad_id, value});
			return this;
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
			for (const {kad_id, item} of this.inner) {
				new_internal.insert(kad_id, item);
			}
			// Insert the new item that we were asked to insert
			new_internal.insert(kad_id, value);
		} else {
			value.release();
			return undefined;
		}
	}
	remove(kad_id) {
		this.inner = this.inner.filter(({kad_id: i, value}) => {
			if (i == kad_id) {
				value.release();
				return false;
			} else {
				return true;
			}
		});
		if (this.inner.length == 0 && this.parent instanceof KBucketInternal) {
			// Remove this K-Bucket and replace its parent with the other side of the internal node
			const other_side = (this.parent.left == this) ? this.parent.right : this.parent.left;
			other_side.bit += this.parent.bit;
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
const k_buckets = new RoutingTable();

// Insert / Remove PeerConnections into our k_buckets
PeerConnection.events.addEventListener('connected', ({ detail: new_connection }) => {
	k_buckets.insert(new_connection.other_id.kad_id, new_connection);
	console.log("added", k_buckets);
	draw_buckets();
});
PeerConnection.events.addEventListener('disconnected', ({ detail: old_connection }) => {
	if (old_connection.other_id) {
		k_buckets.remove(old_connection.other_id.kad_id);
		console.log("removed", k_buckets);
		draw_buckets();
	}
});

const draw_container = document.createElement('div');
draw_container.classList.add('buckets');
document.body.appendChild(draw_container);
function draw_buckets(el = draw_container, node = k_buckets) {
	if (node instanceof RoutingTable) {
		el.innerHTML = `<code style="color: red;">${our_peerid.kad_id.toString(2).padStart(256, '0')}</code><br>`;
		el.innerHTML += node.sibling_list.map(({kad_id}) => `<code>${kad_id.toString(2).padStart(256, '0')}</code><br>`).join('');
		const new_el = document.createElement('div');
		el.appendChild(new_el);
		draw_buckets(new_el, node.root);
	} else if (node instanceof KBucketInternal) {
		el.classList.add('internal');
		const left = document.createElement('div');
		left.classList.add('left');
		const right = document.createElement('div');
		right.classList.add('right');
		el.appendChild(left);
		el.appendChild(right);
		draw_buckets(left, node.left);
		draw_buckets(right, node.right);
	} else if (node instanceof KBucketLeaf) {
		el.innerHTML = node.inner.map(({ kad_id }) => `<code>${kad_id.toString(2).padStart(256, '0')}</code><br>`).join('');
	}
}

export function get_routing_table() {
	// This time around, I'm trying to have the routing table be a snapshot of the current connections.  In the future when more complex routing is needed it can't be that way (we may need to store routing paths not just datachannels) but we'll cross that bridge when we come to it.
	// peer_id -> rtcdatachannel
	const routing_table = new Map();
	for (const pc of PeerConnection.connections) {
		if (pc.other_id) {
			const dc = pc.get_hn_dc();
			if (dc) routing_table.set(pc.other_id, dc);
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

// Source route a msg based on a path
export async function route(path, msgOrData) {
	const routing_table = get_routing_table();
	for (let i = path.length - 1; i >= 0; --i) {
		const peer_id = path[i];
		if (peer_id == our_peerid) {
			// If we reach our own public_key then abort so that we don't route the message backwards.
			break;
		} else if (routing_table.has(peer_id)) {
			const route = routing_table.get(peer_id);
			try {
				if (typeof msgOrData !== 'string' && i < path.length - 1) {
					msgOrData = {
						type: 'source_route',
						path: path.slice(i).map(pid => pid.public_key_encoded),
						content: msgOrData
					};
				}
				if (typeof msgOrData !== 'string') {
					console.log("Send", msgOrData);
					msgOrData = await sign_message(msgOrData);
				}
				route.send(msgOrData);
				return;
			} catch (e) { console.error(e); }
		}
	}
	throw new Error('TODO: return path unreachable');
}

// The finite routing table space needs to be shared between DHT, GossipSub, etc.  While a connection might be quite important from a DHT distance perspective, it might not be useful with respect ot the topics we're subscribed to, or it might not have any of the same distributed applications running on it that we are running.