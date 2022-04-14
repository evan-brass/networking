import { our_peerid } from "./peer-id.mjs";
import { PeerConnection } from "./peer-connection.mjs";

// s must be greater than 0 and is a network wide parameter (Peers need to agree about who their neighbors are)
const s = 3;

const above = [];
const below = [];

PeerConnection.events.addEventListener('connected', ({ connection }) => {
	const list = (connection.other_id.kad_id < connection.other_id.kad_id) ? below : above;
	// For the below list, ids that are greater are closer to our_peerid.  The oposite is true for the above list.
	const closer = (list === below) ? (i, t) => i > t : (i, t) => i < t;
	for (let i = 0; i < above.length; ++i) {
		const test = above[i];
		if (!closer(connection.other_id.kad_id, test.other_id.kad_id)) {
			above.splice(i, 0, connection);
			if (i < s) {
				// Claim the connection
				connection.claim();
				// Release the old sibling if there was one
				const old_sibling = list[s];
				if (old_sibling) old_sibling.release();
			}
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

// Used for sibling broadcast
export function* siblings() {
	for (let i = Math.min(s, below.length) - 1; i >= 0; --i) {
		yield below[i];
	}
	for (let i = 0; i < s && i < above.length; ++i) {
		yield above[i];
	}
}

export function sibling_range() {
	const high = above[s - 1] ?? 2n ** 256n;
	const low = below[s - 1] ?? 0;
	return { high, low };
}

export function is_responsible(kad_id) {
	const { high, low } = sibling_range();
	return kad_id <= high && kad_id >= low;
}