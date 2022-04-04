import { bootstrap_tracker } from "./bootstrap.mjs";
import { announce_self } from "./messages.mjs";
import { PeerConnection } from "./webrtc.mjs";

function timeout(t = 5000) {
	return new Promise(r => setTimeout(r, t));
}

async function heartbeat() {
	if (PeerConnection.connections.size < 1) {
		let b = bootstrap_tracker("¾\x80v\x90ú!çD\x1A\x98\x80\x8AÄWrÇìô5v", "wss://qot.abiir.top:443/announce");
		await Promise.race([b, timeout()]);
	} else {
		await announce_self();
	}

	// TODO: refresh a stale bucket if needed.

	console.log("Heartbeat Finished.");
	setTimeout(heartbeat, 30000);
}
heartbeat();