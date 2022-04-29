import { our_peerid } from "./peer-id.mjs";

const s = 2;

export const above = [];
export const below = [];

function big_abs(bigint) {
	if (bigint > 0) {
		return bigint;
	} else {
		return -1n * bigint;
	}
}

export function closer(kad_id) {
	const our_dst = big_abs(our_peerid.kad_id - kad_id);
	const test = ((kad_id < our_peerid.kad_id) ? below : above)[0];
	const t_dst = big_abs(test.other_id.kad_id - kad_id);
	if (t_dst < our_dst) {
		return test;
	}
}

export function sibling_range() {
	const high = above[s - 1]?.other_id?.kad_id ?? 2n ** 256n;
	const low = below[s - 1]?.other_id?.kad_id ?? 0;
	return { high, low };
}

export function is_responsible(kad_id) {
	const { high, low } = sibling_range();
	return kad_id <= high && kad_id >= low;
}

export function add_conn(peer_connection) {
	if (peer_connection.other_id.kad_id < our_peerid.kad_id) {
		for (let i = 0; i < below.length; ++i) {
			const t = below[i];
			if (t.other_id.kad_id < peer_connection.other_id.kad_id) {
				below.splice(i, 0, peer_connection);
				break;
			}
		}
	} else {
		for (let i = 0; i < above.length; ++i) {
			const t = above[i];
			if (t.other_id.kad_id > peer_connection.other_id.kad_id) {
				above.splice(i, 0, peer_connection);
				break;
			}
		}
	}
}
export function remove_conn(peer_connection) {
	const list = (peer_connection.other_id.kad_id < our_peerid.kad_id) ? below : above;
	const i = list.indexOf(peer_connection);
	list.splice(i, 1);
}