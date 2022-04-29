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
	if (test) {
		const t_dst = big_abs(test.other_id.kad_id - kad_id);
		if (t_dst < our_dst) {
			return test;
		}
	}
}

export function sibling_range() {
	const high = above[s - 1]?.other_id?.kad_id ?? 2n ** 256n;
	const low = below[s - 1]?.other_id?.kad_id ?? 0;
	return { high, low };
}
export function sib_fit(pid) {
	const {high, low} = sibling_range();
	return (pid.kad_id > low && pid.kad_id < high);
}

export function is_responsible(kad_id) {
	const { high, low } = sibling_range();
	return kad_id <= high && kad_id >= low;
}

export function add_conn(peer_connection) {
	const kad_id = peer_connection.other_id.kad_id;
	const list = (kad_id < our_peerid.kad_id) ? below : above;
	const the_spot = (kad_id < our_peerid.kad_id) ? t => t < kad_id : t => t > kad_id;

	for (let i = 0; i < list.length; ++i) {
		const t = list[i];
		if (the_spot(t.other_id.kad_id)) {
			list.splice(i, 0, peer_connection);
			return;
		}
	}
	list.push(peer_connection);
}
export function remove_conn(peer_connection) {
	const list = (peer_connection.other_id.kad_id < our_peerid.kad_id) ? below : above;
	const i = list.indexOf(peer_connection);
	if (i !== -1) list.splice(i, 1);
}