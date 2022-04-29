import { bootstrap_tracker } from "./core/bootstrap.mjs";
import { PeerConnection } from "./core/peer-connection.mjs";
import { send, send_data } from "./core/routing.mjs";
import { messages } from "./core/message.mjs";

function rand_conn(constraint = () => true) {
	// Pick a random connection
	const all_conns = [];
	for (const c of PeerConnection.connections.values()) {
		if (constraint(c)) all_conns.push(c);
	}
	const rand = Math.trunc(Math.random() * all_conns.length);
	return all_conns[rand];
}

messages.addEventListener('im-here', async ({ origin, body, body_sig, back_path, back_path_parsed }) => {
	if (back_path.length > 3) return;
	const conn = rand_conn(c => !back_path_parsed.includes(c.other_id));
	if (conn) {
		await send_data(conn, { body, body_sig, back_path });
	}
});

async function announce_self() {
	const conn = rand_conn();
	// Send them an I'm here message
	await send(conn, {
		type: 'im-here'
	});
}

async function heartbeat() {
	if (PeerConnection.connections.size < 1) {
		await bootstrap_tracker("¾\x80v\x90ú!çD\x1A\x98\x80\x8AÄWrÇìô5v", "ws://localhost:8000");
	} else {
		await announce_self();

		// await refresh_bucket();
	}

	// TODO: refresh a stale bucket if needed.
	setTimeout(heartbeat, 3000);
}
heartbeat();