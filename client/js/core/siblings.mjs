import { our_peerid } from "./peer-id.mjs";

// s must be greater than 0
const s = 3;

const siblings_above = [];
const siblings_below = [];

export function lin_dst(a, b) {
	const ret = a - b;
	return (ret < 0n) ? ret * -1n : ret;
}

// Check if a key is within our responsible range:
export function is_responsible(kad_id) {
	const list = (kad_id < our_peerid.kad_id) ? siblings_below : siblings_above;
	if (list.length < s) return true;
	return lin_dst(our_peerid.kad_id, kad_id) < lin_dst(our_peerid.kad_id, list[list.length - 1]);
}

export function sibling_range() {
	const sib_belowest = siblings_below[siblings_below.length - 1]?.other_id?.public_key_encoded;
	const sib_below_count = siblings_below.length;
	const sib_aboveest = siblings_above[siblings_above.length - 1]?.other_id?.public_key_encoded;
	const sib_above_count = siblings_above.length;
	return {sib_aboveest, sib_above_count, sib_belowest, sib_below_count};
}

export function space_available_sibling_list(kad_id) {
	// Check if we have space in our sibling list
	const list = (kad_id < our_peerid.kad_id) ? siblings_below : siblings_above;
	if (list.length < s) return list;
	if (s > 0 && lin_dst(our_peerid.kad_id, kad_id) < lin_dst(our_peerid.kad_id, list[list.length - 1].other_id.kad_id)) return list;
}

export function* siblings() {
	// Iterate over the siblings
	for (let i = siblings_below.length - 1; i > 0; --i) {
		yield siblings_below[i];
	}
	yield* siblings_above;
}