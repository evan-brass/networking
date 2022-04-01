import { our_peerid } from "./peer-id.mjs";

// There are existing k-bucket implementations out there but I don't think they use bigint.

// k is the max number of items that can be held inside a KBucketLeaf
const k = 2;
// s is the number of siblings we store greater and less than ourself
const s = 3;

// Can't use Math.abs on bigint
function lin_dst(a, b) {
	const ret = a - b;
	return (ret < 0n) ? ret * -1n : ret;
}
function bucket_index(kad_id) {
	// if (kad_id == our_peerid.kad_id) throw new Error("There's no bucket for our own peer_id.");
	let t = kad_id ^ our_peerid.kad_id;
	let i = 0;
	while ((t >>= 1n) > 0n) ++i;
	return 254 - i;
}
class RoutingTable {
	#siblings_above = [];
	#siblings_below = [];
	// Kbuckets is an array of sets:
	#kbuckets = new Array(255);
	#bucket(kad_id) {
		return this.#kbuckets[bucket_index(kad_id)];
	}
	#sibling_range() {
		// Return the lowest kad_id of a sibling and the highest kad_id of a sibling
		let low;
		if (this.#siblings_below.length > 0) {
			low = this.#siblings_below[this.#siblings_below.length - 1].other_id.kad_id;
		} else {
			low = our_peerid.kad_id;
		}
		let high;
		if (this.#siblings_above.length > 0) {
			high = this.#siblings_above[this.#siblings_above.length - 1].other_id.kad_id;
		} else {
			high = our_peerid.kad_id;
		}
		return { low, high };
	}
	#sibling_list(kad_id) {
		// Check if we have space in our sibling list
		const list = (kad_id < our_peerid.kad_id) ? this.#siblings_below : this.#siblings_above;
		if (list.length < s) return list;
		if (s > 0 && lin_dst(our_peerid.kad_id, kad_id) < lin_dst(our_peerid.kad_id, list[list.length - 1].other_id.kad_id)) return list;
	}
	is_sibling(kad_id) {
		for (const sib of this.#siblings_below) {
			if (sib.other_id.kad_id == kad_id) return sib;
		}
		for (const sib of this.#siblings_above) {
			if (sib.other_id.kad_id == kad_id) return sib;
		}
	}
	space_available(kad_id) {
		if (this.#sibling_list(kad_id)) return true;
		// Check if there's space in the kbuckets:
		return (this.#bucket(kad_id)?.size ?? k) < k;
	}
	insert(connection, already_claimed = false) {
		const kad_id = connection.other_id.kad_id;
		const sib_list = this.#sibling_list(kad_id);
		if (sib_list) {
			let displaced;
			if (sib_list.length >= s) {
				displaced = sib_list.pop();
			}
			sib_list.push(connection);
			connection.claim();
			sib_list.sort((a, b) => {
				(lin_dst(our_peerid.kad_id, a.other_id.kad_id) < lin_dst(our_peerid.kad_id, b.other_id.kad_id)) ? -1 : 1;
			});
			if (displaced) this.insert(displaced, true);
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
			// Backfill the sibling list from our routing table?
			displaced.release();
			return;
		}

		// Remove from the rest of the table:
		this.#bucket(connection.other_id.kad_id).delete(connection);
	}
	// TODO: lookup values?
	*lookup(kad_id) {
		const {low, high} = this.#sibling_range();
		if (kad_id >= low && kad_id <= high) {
			// If a lookup falls within our sibling range, check for an exact match.
			const below = this.#siblings_below.find(c => c.other_id.kad_id == kad_id);
			if (below) return below;
			const above = this.#siblings_above.find(c => c.other_id.kad_id == kad_id);
			if (above) return above;
		}
		// Look through our kbuckets for closer peers:
		let first_bucket = true;
		let any_found = false;
		for (let i = bucket_index(kad_id); i >= 0; --i) {
			let bucket = this.#kbuckets[i];
			if (bucket?.size ?? 0 > 0) {
				if (first_bucket) {
					any_found = true;
					// If we're in the first bucket (which is the bucket that kad_id would be in) then first check if we have the exact kad_id in the bucket.  Otherwise return the items in oldest connection order as usual.
					let conns = [];
					for (const conn of bucket) {
						if (conn.other_id.kad_id == kad_id) {
							return conn;
						}
						conns.push(conn);
					}
					bucket = conns;
				}
				yield* bucket;
			}
			first_bucket = false;
		}

		// If we didn't have any results from our kbuckets, then try to return a sibling that is closer to the kad_id than we are.
		const our_dst = lin_dst(our_peerid.kad_id, kad_id);
		let closest, closest_dst;
		if (!any_found) {
			const list = (kad_id < our_peerid.kad_id) ? this.#siblings_below : this.#siblings_above;
			for (const sibling of list) {
				const sib_dst = lin_dst(sibling.other_id.kad_id, kad_id);
				if (sib_dst < our_dst && (!closest || sib_dst < closest_dst)) {
					closest = sibling;
					closest_dst = sib_dst;
				}
			}
		}
		if (closest) yield closest;
	}

	// Routing:
	async source_route(path, msg) {
		for (const pid of path) {
			const { value: connection, done: is_exact} = this.lookup(pid.kad_id).next();
			if (is_exact && connection) {
				console.log('Snd:', body, connection.other_id);
				const body = JSON.stringify(msg);
				const body_sig = await our_peerid.sign(body);
				// TODO: only include the forward path if we aren't sending directly to the intended target
				let forward_path, forward_sig;
				if (path[0] !== connection.other_id) {
					forward_path = path.map(pid => pid.public_key_encoded).join(',');
					forward_sig = await our_peerid.sign(forward_path);
				}
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
		throw new Error('Routing Failed: Path');
	}
	async sibling_broadcast(msg) {
		const body = JSON.stringify(msg);
		console.log('SBc:', msg);
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
	async forward(forward_path_parsed, data) {
		const {forward_path, forward_sig, body, body_sig, back_path} = JSON.parse(data);
		for (const pid of forward_path_parsed) {
			if (pid == our_peerid) break;
			const {value: connection, done: is_exact} = this.lookup(pid.kad_id).next();
			if (is_exact && connection) {
				console.log('Fwd:', body);
				const back_path_sig = await our_peerid.sign(connection.other_id.public_key_encoded + body_sig);
				connection.send(JSON.stringify({
					forward_path, forward_sig,
					body, body_sig,
					back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path]
				}));
				return;
			}
		}
		throw new Error("Destination Unreachable");
	}
	async kad_route(kad_id, msg) {
		const body = JSON.stringify(msg);
		const body_sig = await our_peerid.sign(body);
		const back_path = [];
		await this.kad_route_data(kad_id, {body, body_sig, back_path});
	}
	async kad_route_data(kad_id, { body, body_sig, back_path }) {
		let { value: connection } = this.lookup(kad_id).next();
		if (!connection) throw new Error('Routing Failed: Kad');

		console.log('Snd:', body, connection.other_id)

		const back_path_sig = await our_peerid.sign(connection.other_id.public_key_encoded + body_sig);
		connection.send(JSON.stringify({
			body, body_sig,
			back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path]
		}));
	}
}
export const routing_table = new RoutingTable();
console.log(routing_table);