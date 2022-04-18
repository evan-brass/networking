import { our_peerid, PeerId } from "./peer-id.mjs";
import { PeerConnection } from "./peer-connection.mjs";
import { messages } from "./messages.mjs";
import { get_expiration } from "./lib.mjs";
import { connect } from "./connect.mjs";

/**
 * How should the sibling list route messages?  
 */

// s must be greater than 0 and is a network wide parameter (Peers need to agree about who their neighbors are)
const s = 3;

const above = [];
const below = [];

export function sibling_range() {
	const high = above[s - 1]?.other_id?.kad_id ?? 2n ** 256n;
	const low = below[s - 1]?.other_id?.kad_id ?? 0;
	return { high, low };
}

export function is_responsible(kad_id) {
	const { high, low } = sibling_range();
	return kad_id <= high && kad_id >= low;
}

// Used for sibling broadcast
export function* siblings() {
	for (let i = Math.min(s, below.length) - 1; i >= 0; --i) {
		yield below[i];
	}
	for (let i = 0; i < s && i < above.length; ++i) {
		yield above[i];
	}
}
function siblings_msg() {
	return {
		type: 'siblings',
		expiration: get_expiration(),
		siblings: Array.from(siblings()).map(c => c.other_id.public_key_encoded)
	};
}
function not_siblings_msg(back_path_parsed) {
	// The sender is not one of our siblings: send them a not_siblings message
	const kad_id = back_path_parsed[0].kad_id;
	const list = (kad_id < our_peerid.kad_id) ? below : above;
	const is_past = (list === above) ? t => t > kad_id : t => t < kad_id;
	let closest;
	for (let i = 0; i < list.length; ++i) {
		const t = list[i];
		if (back_path_parsed.includes(t.other_id)) continue;
		if (is_past(t.other_id.kad_id)) break;
		closest = t.other_id.public_key_encoded;
	}
	if (closest === undefined) debugger;
	return {
		type: 'not_siblings',
		expiration: get_expiration(),
		closest
	};
}
export async function announce_self() {
	for (const conn of siblings()) {
		await PeerConnection.source_route([conn.other_id], siblings_msg());
	}
}

// Insert / remove connections from the sibling lists:
PeerConnection.events.addEventListener('connected', ({ connection }) => {
	const list = (connection.other_id.kad_id < our_peerid.kad_id) ? below : above;
	// For the below list, ids that are greater are closer to our_peerid.  The oposite is true for the above list.
	const right_spot = (list === below) ? (i, t) => i > t : (i, t) => i < t;
	for (let i = 0; i <= list.length; ++i) {
		const test = list[i];
		if (test === undefined || right_spot(connection.other_id.kad_id, test.other_id.kad_id)) {
			list.splice(i, 0, connection);
			if (i < s) {
				// Claim the connection
				connection.claim();
				// Release the old sibling if there was one
				const old_sibling = list[s];
				if (old_sibling) old_sibling.release();
			}
			break;
		}
	}
});
PeerConnection.events.addEventListener('disconected', ({ connection }) => {
	const list = (connection.other_id.kad_id < our_peerid.kad_id) ? above : below;
	const i = list.indexOf(connection);
	list.splice(i, 1);
	if (i < s) {
		// The old connection was a sibling so claim the new sibling that replaces it (if there is one).
		const new_sibling = list[s - 1];
		if (new_sibling) new_sibling.claim();
	}
});

// Listen for incoming sibling messages
messages.addEventListener('siblings', async e => {
	const { msg, origin, back_path_parsed } = e;
	e.stopImmediatePropagation();
	// The sender thinks that we're siblings
	const { high, low } = sibling_range();

	if (origin.kad_id < low || origin.kad_id > high) {
		await PeerConnection.source_route(back_path_parsed, not_siblings_msg(back_path_parsed));
	} else if (!PeerConnection.connections.has(origin)) {
		await connect(back_path_parsed);
	}
	// Look through their siblings and if any of them should be in our sibling list, then send them a sibling message:
	for (const sib of msg.siblings) {
		const pid = await PeerId.from_encoded(sib);
		if (pid !== our_peerid && !PeerConnection.connections.has(pid) && pid.kad_id < high && pid.kad_id > low) {
			await PeerConnection.source_route([pid, ...back_path_parsed], siblings_msg());
		}
	}
});
// Listen for incoming not_siblings messages
messages.addEventListener('not_siblings', async e => {
	const { msg, back_path_parsed } = e;
	e.stopImmediatePropagation();
	const closest = await PeerId.from_encoded(msg.closest);
	const { high, low } = sibling_range();
	if (closest.kad_id > low && closest.kad_id < high) {
		await PeerConnection.source_route([closest, ...back_path_parsed], siblings_msg());
	}
});