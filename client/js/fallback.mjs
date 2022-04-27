import { bootstrap_tracker } from "./core/bootstrap.mjs";
import { PeerId } from "./core/peer-id.mjs";
import { PeerConnection } from "./core/peer-connection.mjs";

function timeout(t = 10000) {
	return new Promise(r => setTimeout(r, t));
}

async function heartbeat() {
	if (PeerConnection.connections.size < 1) {
		await bootstrap_tracker("¾\x80v\x90ú!çD\x1A\x98\x80\x8AÄWrÇìô5v", "wss://tracker.btorrent.xyz");
	} else {
		// await announce_self();

		// await refresh_bucket();
	}

	// TODO: refresh a stale bucket if needed.
	setTimeout(heartbeat, 3000);
}
heartbeat();