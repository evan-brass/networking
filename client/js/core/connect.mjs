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
	const sdp = await PeerConnection.handle_connect(origin, msg.sdp);
	if (sdp) {
		await PeerConnection.source_route(back_path_parsed, {
			type: 'connect',
			expiration: get_expiration(),
			sdp
		});
	}
});

export async function connect(back_path_parsed) {
	// TODO: encrypt the sdp
	// The sending peer is our sibling, and we don't have a connection to them: send them a connect message.
	const sdp = await PeerConnection.handle_connect(back_path_parsed[0]);
	if (sdp) {
		// TODO: make sdp handling part of PeerConnection.handle_connect?
		await PeerConnection.source_route(back_path_parsed, {
			type: 'connect',
			expiration: get_expiration(),
			sdp
		});
	}
}