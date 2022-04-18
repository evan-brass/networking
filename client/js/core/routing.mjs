import { our_peerid } from "./peer-id.mjs";
import { lookup } from "./kbuckets.mjs";
import { siblings } from "./siblings.mjs";
import { PeerConnection } from "./peer-connection.mjs";
import { get_expiration } from "./lib.mjs";

// TODO: add a cache of messages that we've seen recently so that we don't handle the same message more than once.  I think we can do this using the body_sig of the message.  The cache also might belong in messages instead of routing.  The goal is to once again limit the affects of replay attacks.  The cache only needs to contain messaegs until they expire.



// Route a message as close to a target as possible.
const closer_cnt = 5;
export async function route(target, msg) {
	const body = JSON.stringify(msg);
	const body_sig = await our_peerid.sign(body);
	const back_path = [];
	await route_data(target, body, body_sig, back_path);
}
export async function route_data(target, body, body_sig, back_path, back_path_parsed) {
	const closer = [];
	for (const conn of lookup(target)) {
		closer.push(conn);
		if (closer.length >= closer_cnt) break;
	}
	const closest = closer[0];
	if (closest !== undefined) {
		// Pass the message onward toward the target
		const back_path_sig = await our_peerid.sign(pid.public_key_encoded + body_sig);
		await closest.send(JSON.stringify({
			body, body_sig,
			back_path: [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path]
		}));
	}
	if (back_path.length > 0) {
		// TODO: send a routing acknowledgement.
		await forward(back_path_parsed, {
			type: 'route_ack',
			expiration: get_expiration(),
			closer: closer.map(c => c.other_id.public_key_encoded),
			acknowledging: body_sig
		});
	}
}