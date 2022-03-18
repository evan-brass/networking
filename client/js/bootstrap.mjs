import { seed_addresses } from "./network-props.mjs";
import { routing_table } from "./routing-table.mjs";
import { sign_message, verify_message, message_handler, create_RTCPeerConnection } from "./messages.mjs";

export async function bootstrap() {
	// Connect to our seed addresses
	for (const addr of seed_addresses) {
		let ws = new WebSocket(addr);
		ws.onopen = () => {
			sign_message({
				type: 'addresses',
				addresses: []
			}).then(d => ws.send(d));
		};
		ws.onmessage = async ({ data }) => {
			const valid = await verify_message(data);
			if (valid) {
				const {origin} = valid;
				routing_table.set(origin, ws);
				ws.onmessage = message_handler;
				ws.onclose = () => {
					const route = routing_table.get(origin);
					if (route == ws) routing_table.delete(origin);
				};
				message_handler({ data });

				// Try to replace the websocket with an RTCPeerConnection:
				create_RTCPeerConnection([origin], origin);

				return;
			}
		};
	}

	// TODO: Bootstrap using WebTorrent trackers
	// TODO: Bootstrap using 
}