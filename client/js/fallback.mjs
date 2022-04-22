import { bootstrap_tracker } from "./core/bootstrap.mjs";
import { PeerId } from "./core/peer-id.mjs";
import { PeerConnection } from "./core/peer-connection.mjs";
import { refresh_bucket } from "./core/kbuckets.mjs";
import { announce_self } from "./core/siblings.mjs";

function timeout(t = 10000) {
	return new Promise(r => setTimeout(r, t));
}

async function heartbeat() {
	if (PeerConnection.connections.size < 1) {
		let b = bootstrap_tracker("¾\x80v\x90ú!çD\x1A\x98\x80\x8AÄWrÇìô5v", "wss://qot.abiir.top:443/announce");
		await Promise.race([b, timeout()]);
	} else {
		await announce_self();

		await refresh_bucket();
	}

	// TODO: refresh a stale bucket if needed.

	PeerId.cleanup_cache();

}
heartbeat();
setInterval(heartbeat, 3000);