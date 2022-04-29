import { our_peerid } from "./peer-id.mjs";

/**
 * So... If we end up deciding that not all peers need to be part of the DHT, then we probably want that decision to be based on a self-tuning huristic.
 * Browser peers will likely have high churn so if we detect that the network is suffering under high churn then the browser could switch itself into being a DHT client instead of being a DHT server.
 * I'm thinking that the default will be for browsers to participate in the DHT until they determine that the DHT doesn't need them (or would benefit from them not participating).
 * Browsers should participate in the DHT if the DHT is small (there aren't very many nodes) or if the DHT is under excessive load.  I'm not quite sure how to measure the DHT load.  Long query times?
 * Whatever design decisions we make, we'll need to eventually simulate the network and verify that it performs well under various attack methods.
 */

const k = 1;

const buckets = [];
function get_bucket(i) {
	if (!Array.isArray(buckets[i])) {
		buckets[i] = [];
	}
	return buckets[i];
}

// Currently we're returning a boolean for could fit, but eventually we will use a better weighting system.  Perhaps we weight new connections based on how far they are from our first unfilled bucket?  I'm not quite sure how the weighting will end up working.
export function could_fit(peer_id) {
	const i = bucket_index(peer_id.kad_id);
	const bucket = buckets[i];
	return bucket === undefined || bucket.length < k;
}
export function bucket_index(kad_id, b = our_peerid.kad_id) {
	// if (kad_id == our_peerid.kad_id) throw new Error("There's no bucket for our own peer_id.");
	let t = kad_id ^ b;
	if (t == 0n) return 256;
	let i = 0;
	while ((t >>= 1n) > 0n) ++i;
	return 255 - i;
}
export function add_conn(peer_connection) {
	const i = bucket_index(peer_connection.other_id.kad_id);
	get_bucket(i).push(peer_connection);
}
export function remove_conn(peer_connection) {
	const i = bucket_index(peer_connection.other_id.kad_id);
	const bucket = buckets[i];
	if (bucket) {
		const ii = bucket.indexOf(peer_connection);
		bucket.splice(ii, 1);
	}
}

export function random_kad_id(bucket) {
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

// The default constraint on lookups is to only return connections who are closer (by xor distance) than our_peerid
export function default_constraint(kad_id) {
	const our_dst = kad_id ^ our_peerid.kad_id;
	return connection => (kad_id ^ connection.other_id.kad_id) < our_dst;
}
export function* lookup(kad_id, constraint = default_constraint(kad_id)) {
	for (let i = bucket_index(kad_id); i >= 0; --i) {
		if (buckets[i] === undefined) continue;
		const items = [];
		for (const conn of buckets[i]) {
			if (constraint(conn)) items.push(conn);
		}
		items.sort((a, b) => {
			const dst_a = kad_id ^ a.other_id.kad_id;
			const dst_b = kad_id ^ b.other_id.kad_id;
			return (dst_a < dst_b) ? -1 : 1;
		});
		yield* items;
	}
}