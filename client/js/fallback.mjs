// import { openDB, deleteDB, wrap, unwrap } from 'https://cdn.jsdelivr.net/npm/idb/+esm';
import { min_connections } from "./network-props.mjs";
import { routing_table, route, cleanup_connection_table } from "./routing-table.mjs";
import { bootstrap } from "./bootstrap.mjs";

async function heartbeat() {
	cleanup_connection_table();

	if (routing_table.size < 1) {
		await bootstrap();
	} else if (routing_table.size < min_connections) {
		// Find a random peer and see who they're connected to.
		const keys = Array.from(routing_table.keys());
		const key = keys[Math.trunc(Math.random() * keys.length)];
		await route([key], {
			type: 'query',
			routing_table: true
		});
	}

	console.log("Heartbeat Finished.");
	setTimeout(heartbeat, 3000);
}
heartbeat();

if (window.parent === null) {
	throw new Error("The fallback hyperspace-client should be embedded in an iframe by the distributed web app.");
}

const {port1: app_port, port2} = new MessageChannel();

// Send half of the message channel to the app
window.parent.postMessage({
	hyperspace_client_message_port: port2
}, "*", [port2]);

// Handle messageson the app_port:
app_port.onmessage = ({ data, origin }) => {
	console.log(origin, data);
};