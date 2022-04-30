import { bootstrap_tracker } from "./core/bootstrap.mjs";
import { PeerConnection } from "./core/peer-connection.mjs";
import { send, send_data } from "./core/routing.mjs";
import { messages } from "./core/message.mjs";
import { k, buckets, bucket_index, could_fit, random_kad_id } from "./core/kbuckets.mjs";
import { our_peerid } from "./core/peer-id.mjs";

function rand_conn(constraint = () => true) {
	// Pick a random connection
	const all_conns = [];
	for (const c of PeerConnection.connections.values()) {
		if (constraint(c)) all_conns.push(c);
	}
	const rand = Math.trunc(Math.random() * all_conns.length);
	return all_conns[rand];
}

messages.addEventListener('im-here', async ({ origin, msg, body, body_sig, back_path, back_path_parsed }) => {
	if (msg.bucket !== undefined) {
		if (could_fit(origin) && bucket_index(our_peerid.kad_id, origin.kad_id)) {
			PeerConnection.connect(origin);
		}
	} else {
		if (back_path.length > 3) return;

		const conn = rand_conn(c => !back_path_parsed.includes(c.other_id));
		if (conn) {
			await send_data(conn, { body, body_sig, back_path });
		}
	}
});

async function announce_self() {
	const conn = rand_conn();
	// Send them an I'm here message
	await send(conn, {
		type: 'im-here'
	});
}
async function refresh_bucket() {
	// Find the first bucket that has space:
	let i;
	for (i = 0; i < buckets.length; ++i) {
		const bucket = buckets[i];
		if (bucket === undefined || bucket.length < k) {
			break;
		}
	}
	// If our buckets aren't full, then create a connection request to fill that bucket
	if (i < 255) {
		const target = random_kad_id(i);
		// TODO: Store the body_sig into the waiting_connects table.
		await send(target, {
			type: 'im-here',
			bucket: i
		});
	}
}

async function heartbeat() {
	if (PeerConnection.connections.size < 1) {
		await bootstrap_tracker("¾\x80v\x90ú!çD\x1A\x98\x80\x8AÄWrÇìô5v", "ws://localhost:8000");
	} else {
		if (Math.random() > 0.5) {
			await announce_self();
		} else {
			await refresh_bucket();
		}
	}

	// TODO: refresh a stale bucket if needed.
	setTimeout(heartbeat, 3000);
}
heartbeat();