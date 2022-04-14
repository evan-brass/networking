import { bootstrap_tracker } from "./core/bootstrap.mjs";
import { PeerId } from "./core/peer-id.mjs";
import { PeerConnection } from "./core/peer-connection.mjs";

function timeout(t = 10000) {
	return new Promise(r => setTimeout(r, t));
}

async function announce_self() {
	// await routing_table.sibling_broadcast({
	// 	type: "siblings",
	// 	siblings: Array.from(routing_table.siblings()).map(c => c.other_id.public_key_encoded)
	// });
	// TODO: broadcast our subscribed topics.
}

async function heartbeat() {
	if (PeerConnection.connections.size < 1) {
		let b = bootstrap_tracker("¾\x80v\x90ú!çD\x1A\x98\x80\x8AÄWrÇìô5v", "wss://qot.abiir.top:443/announce");
		await Promise.race([b, timeout()]);
	} else {
		// await announce_self();

		// await refresh_bucket();
	}

	// TODO: refresh a stale bucket if needed.

	PeerId.cleanup_cache();

}
heartbeat();
setInterval(heartbeat, 10000);