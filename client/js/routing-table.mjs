import { our_peerid } from "./peer-id.mjs";
import { PeerConnection } from "./webrtc.mjs";

// There are existing k-bucket implementations out there but I don't think they use bigint.

// Constraint functions:
export function constraint_backpath(back_path_parsed, dst_func = xor_dst) {
	const back_path_kad_ids = back_path_parsed.map(pid => pid.kad_id);
	return (a, b) => {
		// Make sure that b is closer to the destination than our own peer_id:
		dst_func(a, b) < dst_func(a, our_peerid.kad_id) &&
		// Make sure that we don't route to somewhere that the message has already been.
		!back_path_kad_ids.includes(b);
	};
}

// k is the max number of items that can be held inside a KBucketLeaf
const k = 2;
// s is the number of siblings we store greater and less than ourself
const s = 3;

// Can't use Math.abs on bigint
export function lin_dst(a, b) {
	const ret = a - b;
	return (ret < 0n) ? ret * -1n : ret;
}
export function xor_dst(a, b) {
	return a ^ b;
}
export function bucket_index(kad_id, b = our_peerid.kad_id) {
	// if (kad_id == our_peerid.kad_id) throw new Error("There's no bucket for our own peer_id.");
	let t = kad_id ^ b;
	if (t == 0n) return 256;
	let i = 0;
	while ((t >>= 1n) > 0n) ++i;
	return 255 - i;
}
class RoutingTable {
	events = new EventTarget();
	#siblings_above = [];
	#siblings_below = [];
	// Kbuckets is an array of sets:
	// TODO: Also store the buckets in a list by when they were refreshed so that we can refresh lists as needed.
	#kbuckets = new Array(255);
	// TODO: maintain a pending list of connections that we can use to backfill our routing_table if it starts to empty.  It would contain the connections that we keep open to let peers bootstrap into the network.
	random_kad_id(bucket) {
		// Generate a random 256bit number:
		let rand = crypto.getRandomValues(new Uint8Array(32));
		rand = Array.from(rand).map(v => v.toString(16).padStart(2, '0')).join('');
		rand = BigInt('0x' + rand);
		
		// Get rid of the top bits of the random number:
		rand = BigInt.asUintN(256 - bucket, rand);

		// Get bucket_index prefix from our_peerid
		const shift = 256n - BigInt(bucket);
		const prefix = (our_peerid.kad_id >> shift) << shift;

		// There's a 50/50 chance that our random number shares more of the prefix than we want.  If it does then we bitwise negate rand.
		if (bucket_index(prefix | rand) != bucket) {
			rand = ~rand;
		}

		return BigInt.asUintN(256, prefix | rand);
	}
	first_empty() {
		for (let i = 0; i < this.#kbuckets.length; ++i) {
			const bucket = this.#kbuckets[i];
			if (bucket == undefined || bucket.size < k) {
				return i;
			}
		}
	}
	#bucket(kad_id) {
		return this.#kbuckets[bucket_index(kad_id)];
	}
	sibling_range() {
		const sib_belowest = this.#siblings_below[this.#siblings_below.length - 1]?.other_id?.public_key_encoded;
		const sib_below_count = this.#siblings_below.length;
		const sib_aboveest = this.#siblings_above[this.#siblings_above.length - 1]?.other_id?.public_key_encoded;
		const sib_above_count = this.#siblings_above.length;
		return {sib_aboveest, sib_above_count, sib_belowest, sib_below_count};
	}
	space_available_sibling_list(kad_id) {
		// Check if we have space in our sibling list
		const list = (kad_id < our_peerid.kad_id) ? this.#siblings_below : this.#siblings_above;
		if (list.length < s) return list;
		if (s > 0 && lin_dst(our_peerid.kad_id, kad_id) < lin_dst(our_peerid.kad_id, list[list.length - 1].other_id.kad_id)) return list;
	}
	space_available_bucket(kad_id) {
		// TODO: walk up and check if there's an open bucket anywhere greater than the bucket it actually belongs in?  If we do that then we would potentially have a problem with needing to displace connections in our kbuckets.
		const i = bucket_index(kad_id);
		if (this.#kbuckets[i]?.size ?? k < k) {
			return i;
		} else {
			return -1;
		}
	}
	*siblings() {
		yield* this.#siblings_below;
		yield* this.#siblings_above;
	}
	is_sibling(kad_id) {
		for (const s of this.siblings()) {
			if (s.other_id.kad_id == kad_id) return s;
		}
	}
	insert(connection, already_claimed = false) {
		const kad_id = connection.other_id.kad_id;
		const sib_list = this.space_available_sibling_list(kad_id);
		if (sib_list) {
			let displaced;
			if (sib_list.length >= s) {
				displaced = sib_list.pop();
			}
			sib_list.push(connection);
			if (!already_claimed) connection.claim();
			sib_list.sort(({other_id: {kad_id: a}}, {other_id: {kad_id: b}}) => {
				const dst_a = lin_dst(our_peerid.kad_id, a);
				const dst_b = lin_dst(our_peerid.kad_id, b);
				return (dst_a < dst_b) ? -1 : 1;
			});
			this.events.dispatchEvent(new CustomEvent('new-sibling', { detail: connection }));
			if (displaced) {
				this.insert(displaced, true);
				this.events.dispatchEvent(new CustomEvent('old-sibling', { detail: displaced }));
			}
		} else {
			const i = bucket_index(kad_id);
			if (this.#kbuckets[i] == undefined) this.#kbuckets[i] = new Set();
			const bucket = this.#kbuckets[i];
			if (bucket.size < k) {
				bucket.add(connection);
				if (!already_claimed) connection.claim();
			} else if (already_claimed) {
				connection.release();
			}
		}
	}
	delete(connection) {
		const below_ind = this.#siblings_below.indexOf(connection);
		const above_ind = this.#siblings_above.indexOf(connection);
		let displaced;
		if (below_ind != -1) displaced = this.#siblings_below.splice(below_ind, 1)[0];
		if (above_ind != -1) displaced = this.#siblings_above.splice(above_ind, 1)[0];
		if (displaced) {
			// TODO: Backfill the sibling list from our routing table?
			displaced.release();
			this.events.dispatchEvent(new CustomEvent('old-sibling', { detail: displaced }));
			return;
		}

		// Remove from the rest of the table:
		const bucket = this.#bucket(connection.other_id.kad_id);
		if (bucket) bucket.delete(connection);
	}
	// TODO: lookup values?
	// TODO: add the ability to lookup only values that are greater than kad_id or only less than kad_id (needed for sibling connect)
	lookup(kad_id, constraint = (_kad_a, _kad_b) => true, dst_func = xor_dst) {
		let closest, dst;
		for (const s of this.siblings()) {
			const t = dst_func(kad_id, s.other_id.kad_id);
			if (constraint(kad_id, s.other_id.kad_id) && (dst === undefined || t < dst)) {
				closest = s;
				dst = t;
			}
		}
		for (let i = bucket_index(kad_id); i >= 0; --i) {
			let bucket = this.#kbuckets[i];
			if (bucket?.size ?? 0 > 0) {
				for (const c of bucket) {
					const t = dst_func(kad_id, c.other_id.kad_id);
					if (constraint(kad_id, c.other_id.kad_id) && (dst === undefined || t < dst)) {
						closest = c;
						dst = t;
					}
				}
			}
		}
		return closest;
	}

	// Routing:
	async source_route(path, msg) {
		const body = JSON.stringify(msg);
		const body_sig = await our_peerid.sign(body);
		const forward_path = path.map(pid => pid.public_key_encoded).join(',');
		const forward_sig = await our_peerid.sign(forward_path);

		await this.source_route_data(path, {forward_path, forward_sig, body, body_sig, back_path: []});
	}
	// source_route_data is also used for forwarding
	async source_route_data(path, {forward_path, forward_sig, body, body_sig, back_path}) {
		// Check for loops in the path:
		const loop_check = new Set();
		for (const pid of path) {
			if (loop_check.has(pid)) throw new Error("Found a routing loop in the path");
			loop_check.add(pid);
		}
		
		for (const pid of path) {
			const con = PeerConnection.connections.get(pid);
			if (con !== undefined && con.is_open()) {
				// Only include the forward path if we aren't sending directly to the intended target
				if (path[0] === con.other_id) {
					forward_path = undefined;
					forward_sig = undefined;
				}
				const back_path_sig = await our_peerid.sign(pid.public_key_encoded + body_sig);
				const new_back_path = [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path];
	
				con.send(JSON.stringify({
					origin: our_peerid.public_key_encoded,
					forward_path, forward_sig,
					body, body_sig,
					back_path: new_back_path
				}));
				return;
			}
		}
		throw new Error('Routing Failed: Path');
	}
	async sibling_broadcast(msg) {
		const body = JSON.stringify(msg);
		const body_sig = await our_peerid.sign(body);
		const back_path = [];
		await this.sibling_broadcast_data({ body, body_sig, back_path });
	}
	async sibling_broadcast_data({body, body_sig, back_path}) {
		const all_siblings = [...this.#siblings_below, ...this.#siblings_above];
		for (const sib of all_siblings) {
			const back_path_sig = await our_peerid.sign(sib.other_id.public_key_encoded + body_sig);
			sib.send(JSON.stringify({
				body, body_sig,
				back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path]
			}));
		}
	}
	async kad_route(kad_id, msg, constraint) {
		const body = JSON.stringify(msg);
		const body_sig = await our_peerid.sign(body);
		const back_path = [];
		await this.kad_route_data(kad_id, {body, body_sig, back_path}, constraint);
	}
	async kad_route_data(kad_id, { body, body_sig, back_path }, constraint) {
		let connection = this.lookup(kad_id, constraint);
		if (!connection) throw new Error('Routing Failed: Kad');

		const back_path_sig = await our_peerid.sign(connection.other_id.public_key_encoded + body_sig);
		connection.send(JSON.stringify({
			body, body_sig,
			back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path]
		}));
		// TODO: send a routing_acknowledge
	}
}
export const routing_table = new RoutingTable();
console.log(routing_table);

routing_table.events.addEventListener('new-sibling', ({ detail: new_sib}) => {
	console.log('new sibling', new_sib);
});
routing_table.events.addEventListener('old-sibling', ({ detail: new_sib}) => {
	console.log('new sibling', new_sib);
});