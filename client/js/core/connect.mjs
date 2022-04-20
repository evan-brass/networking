import { get_expiration } from "./lib.mjs";
import { messages } from "./messages.mjs";
import { PeerConnection } from "./peer-connection.mjs";

// TODO: In order to do the encryption, we need to have a map of encryption keys for outstanding connections.  We also need to cleanup that map as the connection initiation messages expire.
// The map will serve two purposes: encryption and identifying which incoming connect messages are a response to a request_connect that we sent out.  We can also use it to deduplicate request_connect messages so that we don't accidentally try to connect to the same peer more than once.  Although, I think the PeerConnection.connections map should be deduplication enough.

messages.addEventListener('connect', async e => {
	e.stopImmediatePropagation();
	const { origin, msg, back_path_parsed } = e;
	// TODO: handle encrypting sdp
	// TODO: Check to make sure that this connect either came from a connect_request that we sent or would otherwise fit into our routing table.
	const { sdp, ice } = msg;
	const pc = PeerConnection.connections.get(origin) ?? create_pc(back_path_parsed);

	if (sdp) {
		try {
			const offer_collision = (sdp.type == 'offer') && (pc.making_offer || pc.signalingState != 'stable');
			const ignore_offer = !origin.polite() && offer_collision;

			if (ignore_offer) return;

			await pc.setRemoteDescription(sdp);
			if (sdp.type == 'offer') {
				await pc.setLocalDescription();
				await PeerConnection.source_route(back_path_parsed, {
					type: 'connect',
					expiration: get_expiration(),
					sdp: pc.localDescription
				});
			}
		} catch (e) {
			console.error(e);
		}
	}
	if (ice) {
		try {
			await pc.addIceCandidate(ice);
		} catch {}
	}
});

function create_pc(path) {
	const origin = path[0];
	const pc = new PeerConnection();
	pc.other_id = origin;
	PeerConnection.connections.set(origin, pc);
	pc.onnegotiationneeded = async () => {
		try {
			pc.making_offer = true;
			await pc.setLocalDescription();
			await PeerConnection.source_route(path, {
				type: 'connect',
				expiration: get_expiration(),
				sdp: pc.localDescription
			});
		} catch (e) {
			console.error(e);
		} finally {
			pc.making_offer = false;
		}
	};
	pc.onicecandidate = async function ({ candidate }) {
		console.log(this === pc);
		if (candidate == null) return;
		await PeerConnection.source_route(path, {
			type: 'connect',
			expiration: get_expiration(),
			ice: candidate
		});
	};
	return pc;
}

export function connect(path) {
	// TODO: encrypt the sdp
	const _pc = PeerConnection.connections.get(origin) ?? create_pc(path);
}