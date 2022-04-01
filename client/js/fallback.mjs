import { bootstrap } from "./bootstrap.mjs";
import { our_peerid } from "./peer-id.mjs";
import { announce_self } from "./messages.mjs";
import { PeerConnection } from "./webrtc.mjs";

async function heartbeat() {
	if (PeerConnection.connections.size < 1) {
		await bootstrap();
	}
	await announce_self();
	// TODO: Only perform a lookup if we haven't overheard enough information recently:
	// Lookup our own kad_id to update get new neighbors and such.
	// We can't lookup our exact kad_id because nothing is closer to us than us
	// await lookup_node(our_peerid);
	// await route(our_peerid.kad_id, {
	// 	type: 'lookup',
	// 	key: our_peerid.kad_id.toString(16)
	// }, true);
	// Lookup our own peer_id and try to connect peers that we don't have in our routing table:

	// else if (routing_table.size < min_connections) {
	// 	// Lookup our own key:
	// 	console.log(PeerConnection.connections);
	// 	// Find a random peer and see who they're connected to.
	// 	const keys = Array.from(routing_table.keys());
	// 	const key = keys[Math.trunc(Math.random() * keys.length)];
	// 	await route([key], {
	// 		type: 'query',
	// 		routing_table: true
	// 	});
	// }

	console.log("Heartbeat Finished.");
	setTimeout(heartbeat, 30000);
}
heartbeat();