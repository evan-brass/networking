import { PeerConnection, messages } from "./peer-connection.mjs";
import { our_peerid } from "./peer-id.mjs";
import { connect } from "./connect.mjs";
import { get_expiration } from "./lib.mjs";

/**
 * So... If we end up deciding that not all peers need to be part of the DHT, then we probably want that decision to be based on a self-tuning huristic.
 * Browser peers will likely have high churn so if we detect that the network is suffering under high churn then the browser could switch itself into being a DHT client instead of being a DHT server.
 * I'm thinking that the default will be for browsers to participate in the DHT until they determine that the DHT doesn't need them (or would benefit from them not participating).
 * Browsers should participate in the DHT if the DHT is small (there aren't very many nodes) or if the DHT is under excessive load.  I'm not quite sure how to measure the DHT load.  Long query times?
 * Whatever design decisions we make, we'll need to eventually simulate the network and verify that it performs well under various attack methods.
 */

const k = 2;

const buckets = [];

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

// Insert / remove connections from the kbuckets table
PeerConnection.events.addEventListener('connected', ({ connection }) => {
	const i = bucket_index(connection.other_id.kad_id);
	if (buckets[i] === undefined) {
		buckets[i] = [];
	}
	const bucket = buckets[i];
	bucket.push(connection);
	// We claim the first k entries in the bucket.  We still store the rest of the connections to automatically back-fill when a connection closes.
	if (bucket.length <= k) connection.claim();
});
PeerConnection.events.addEventListener('disconnected', ({ connection }) => {
	// We don't need to release connections from the disconnect handler, because the connections are already closed.
	const i = bucket_index(connection.other_id.kad_id);
	const bucket = buckets[i];
	if (bucket !== undefined) {
		const index = bucket.indexOf(connection);
		if (index !== -1) {
			if (index < k) {
				// This connection was claimed, so claim the connection that replaces it (If there is a replacement)
				const unclaimed = bucket[k];
				if (unclaimed !== undefined) unclaimed.claim();
			}
			bucket.splice(index, 1); 
		}
	}
});

// Listen for incoming request_connect messages with a bits field
messages.addEventListener('request_connect', async e => {
	const { msg, origin, back_path_parsed } = e;
	if (msg.bits !== undefined) {
		// TODO: check if we would fit inside the requester's kbucket and check if we have space in our kbucket for the requestor.
		if (could_fit(origin) && bucket_index(our_peerid.kad_id, origin.kad_id) === msg.bits) {
			e.stopImmediatePropagation();
			// Connect to the peer:
			await connect(back_path_parsed);
		}
	}
});

// Route a message as close to a target as possible.
const closer_cnt = 5;
export async function route(target, msg) {
	const body = JSON.stringify(msg);
	const body_sig = await our_peerid.sign(body);
	const back_path = [];
	await route_data(target, {body, body_sig, back_path});
}
async function route_data(target, {body, body_sig, back_path, back_path_parsed}) {
	const closer = [];
	for (const conn of lookup(target)) {
		closer.push(conn);
		if (closer.length >= closer_cnt) break;
	}
	const closest = closer[0];
	if (closest !== undefined) {
		// Pass the message onward toward the target
		const back_path_sig = await our_peerid.sign(closest.other_id.public_key_encoded + body_sig);
		await closest.send(JSON.stringify({
			body, body_sig,
			back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path]
		}));
	}
	if (back_path.length > 0) {
		// TODO: send a routing acknowledgement.
		await PeerConnection.source_route(back_path_parsed, {
			type: 'route_ack',
			expiration: get_expiration(),
			closer: closer.map(c => c.other_id.public_key_encoded),
			acknowledging: body_sig
		});
	}
}

// Route routable messages which end up not being handled closer to their intended destination
messages.addEventListener('route', async e => {
	const { msg } = e;
	if (msg.target) {
		e.stopImmediatePropagation();

		const target = BigInt('0x' + msg.target);

		await route_data(target, e);
	}
});

export async function refresh_bucket() {
	// Find the first bucket that has space:
	let i;
	for (i = 0; i < buckets.length; ++i) {
		const bucket = buckets[i];
		if (bucket === undefined || bucket.size < k) {
			break;
		}
	}
	// If our buckets aren't full, then create a connection request to fill that bucket
	if (i < buckets.length) {
		const target = random_kad_id(i);
		// TODO: Store the body_sig into the waiting_connects table.
		await route(target, {
			type: 'request_connect',
			expiration: get_expiration(),
			target: target.toString(16),
			bucket: i
		});
	}
}