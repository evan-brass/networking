import { bootstrap_tracker } from "./core/bootstrap.mjs";
import { PeerConnection } from "./core/peer-connection.mjs";
import { send } from "./core/routing.mjs";
import { messages } from "./core/message.mjs";

messages.addEventListener('im-here', ({ origin }) => {

});

async function announce_self() {
	// Pick a random connection
	const all_conns = [...PeerConnection.connections.values()];
	const rand = Math.trunc(Math.random() * all_conns.length);
	const selected_conn = all_conns[rand];

	// Send them an I'm here message
	await send(selected_conn, {
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