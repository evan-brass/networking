import { our_peerid } from "./core/peer-id.mjs";
import { PeerConnection } from "./core/peer-connection.mjs";
import { messages } from "./messages.mjs";

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
export function xor_dst(a, b) {
	return a ^ b;
}
class RoutingTable {
	events = new EventTarget();
	#siblings_above = [];
	#siblings_below = [];
	// Kbuckets is an array of sets:
	// TODO: Also store the buckets in a list by when they were refreshed so that we can refresh lists as needed.
	#kbuckets = new Array(255);
	// TODO: maintain a pending list of connections that we can use to backfill our routing_table if it starts to empty.  It would contain the connections that we keep open to let peers bootstrap into the network.
	#bucket(kad_id) {
		return this.#kbuckets[bucket_index(kad_id)];
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
}
export const routing_table = new RoutingTable();

PeerConnection.events.addEventListener('connected', ({ connection }) => {
	routing_table.insert(connection);
});
PeerConnection.events.addEventListener('disconnected', ({ connection }) => {
	routing_table.delete(connection);
});