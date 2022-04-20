import { PeerId, our_peerid } from "./peer-id.mjs";
import { get_expiration } from "./lib.mjs";

// TODO: let the user edit their ICE configuration
const iceServers = [{
	// A list of stun/turn servers: https://gist.github.com/sagivo/3a4b2f2c7ac6e1b5267c2f1f59ac6c6b
	urls: [
		'stun:stun.l.google.com:19302',
		'stun:stun1.l.google.com:19302'
	]
}];

class ConnectedEvent extends CustomEvent {
	constructor(peer_connection) {
		super('connected');
		this.connection = peer_connection;
	}
}
class DisconnectedEvent extends CustomEvent {
	constructor(peer_connection) {
		super('disconnected');
		this.connection = peer_connection;
	}
}
class NetworkMessageEvent extends CustomEvent {
	constructor(peer_connection, data) {
		super('network-message');
		this.connection = peer_connection;
		this.data = data;
	}
}
class DataChannelEvent extends CustomEvent {
	constructor(peer_connection, channel) {
		super('datachannel');
		this.connection = peer_connection;
		this.channel = channel;
	}
}

/**
 * Our peer connection is a special RTCPeerConnection that also manages the RTCDataChannel for the hyperspace-network, as well as any other datachannels that are signalled (For GossipSub, or blockchain needs).  I'm trying to not have a separation between the routing table (peer_id -> websocket | rtcdatachannel) and the peer table (peer_id -> rtcpeerconnection) as that wasn't working very well.
 */
export class PeerConnection extends RTCPeerConnection {
	// Connections is a map from PeerId -> PeerConnection  We use it to make sure we don't open two connections to the same peer.
	static connections = new Map();
	// Events announces when our peer connections open or close.
	static events = new EventTarget();
	// Label -> RTCDataChannel
	data_channels = new Map();
	#making_offer = false;
	#claimed = 0;

	#connecting_timeout = false;
	#claimed_timeout = false;
	constructor(other_id) {
		super({ iceServers });

		this.other_id = other_id;
		if (this.other_id !== undefined) {
			// TODO: setup automatic renegotiation / ice signaling
			PeerConnection.connections.set(origin, this);

		}

		// TODO: Add a sub-protocol?
		// Create the main hyperspace data channel which carries routing and signaling traffic.
		// This channel also forces the rtcpeerconnection to create an sctp transport so that we have something to negotiate around.
		this.#channel({ channel: this.createDataChannel('hyperspace-network') });
		this.ondatachannel = this.#channel;

		// Set a timeout so that we don't get a peer connection that lives in new forever.
		this.#connecting_timeout = setTimeout(() => {
			this.abandon();
		}, 10000);
		// Close connections that get disconnected or fail (alternatively we could restartice and then timeout);
		this.onconnectionstatechange = () => {
			if (this.connectionState == 'disconnected' || this.connectionState == 'failed') this.abandon();
		};
	}
	#channel({ channel }) {
		if (channel.readyState == 'open') {
			this.#channel_open({ target: channel });
		} else if (channel.readyState == 'closed') {
			this.#channel_close({ target: channel });
		} else {
			channel.onopen = this.#channel_open.bind(this);
			channel.onclose = this.#channel_close.bind(this);
		}
		channel.onerror = console.error;
	}
	#channel_open({ target: channel }) {
		const existing = this.data_channels.get(channel.label);
		// Only keep one of each datachannel:
		if (channel.label == 'hyperspace-network') {
			channel.onmessage = this.#network_msg.bind(this);
			if (this.#connecting_timeout !== undefined) {
				clearTimeout(this.#connecting_timeout);
				this.#connecting_timeout = undefined;
			}
		} else {
			PeerConnection.events.dispatchEvent(new DataChannelEvent(this, channel));
		}
		if (existing) {
			if (existing.id < channel.id) {
				this.data_channels.set(channel.label, channel);
				existing.close();
			} else {
				channel.close();
			}
		} else {
			this.data_channels.set(channel.label, channel);
			if (channel.label == 'hyperspace-network') {
				PeerConnection.events.dispatchEvent(new ConnectedEvent(this));
			}
		}
	}
	#channel_close({ target: channel }) {
		const existing = this.data_channels.get(channel.label);
		if (existing === channel) {
			this.data_channels.delete(channel.label);
			if (channel.label == 'hyperspace-network') {
				PeerConnection.events.dispatchEvent(new DisconnectedEvent(this));
			}
		}
	}
	#network_msg({ data }) {
		PeerConnection.events.dispatchEvent(new NetworkMessageEvent(this, data));
	}

	#claimed_timeout_func() {
		if (this.#claimed == 0) {
			this.abandon();
		}
		this.#claimed_timeout = false;
	}
	claim() {
		this.#claimed += 1;
		if (this.#claimed_timeout) clearTimeout(this.#claimed_timeout);
		this.#claimed_timeout = false;
	}
	release() {
		this.#claimed -= 1;
		if (this.#claimed == 0 && this.#claimed_timeout == false) {
			this.#claimed_timeout = setTimeout(this.#claimed_timeout_func.bind(this), 5000);
		}
	}
	is_open() {
		const nc = this.data_channels.get('hyperspace-network');
		return nc?.readyState == 'open';
	}
	send(data) {
		const nc = this.data_channels.get('hyperspace-network');
		if (nc?.readyState == 'open') {
			nc.send(data);
		} else {
			throw new Error("The datachannel for this peer connection is not in an open readyState.");
		}
	}
	abandon() {
		this.close();
		PeerConnection.connections.delete(this.other_id);
		if (this.other_id) {
			PeerConnection.events.dispatchEvent(new DisconnectedEvent(this));
		}
	}

	static handle_connect(origin, { ice, sdp }) {
		const pc = PeerConnection.connections.get(origin) ?? new PeerConnection(origin);
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
	}

	// Source route a message along a designated path.
	static async source_route(path, msg) {
		// Check for routing loops:
		const loop_check = new Map();
		for (let i = 0; i < path.length; ++i) {
			const pid = path[i];
			const first_seen = loop_check.get(pid);
			if (first_seen !== undefined) {
				// Snip the loop
				console.log("snipped a loop while source routing: ", path, first_seen, i - first_seen);
				path.splice(first_seen, i - first_seen);
				i = first_seen + 1;
			} else {
				loop_check.set(pid, i);
			}
		}

		const body = JSON.stringify(msg);
		const body_sig = await our_peerid.sign(body);
		const back_path = [];
		const forward_path = path.map(pid => pid.public_key_encoded).join(',');
		const forward_sig = await our_peerid.sign(forward_path);
		console.log('send', msg);
		await PeerConnection.source_route_data(path, {forward_path, forward_sig, body, body_sig, back_path, back_path_parsed: []});
	}
	static async source_route_data(path, {forward_path, forward_sig, body, body_sig, back_path, back_path_parsed}) {		
		for (const pid of path) {
			const con = PeerConnection.connections.get(pid);
			if (con !== undefined && con.is_open()) {
				// Only include the forward path if we aren't sending directly to the intended target
				if (path[0] === con.other_id) {
					forward_path = undefined;
					forward_sig = undefined;
				}
				const back_path_sig = await our_peerid.sign(pid.public_key_encoded + body_sig);
				const new_back_path = [`${our_peerid.public_key_encoded}.${back_path_sig}`, ...back_path];

				con.send(JSON.stringify({
					forward_path, forward_sig,
					body, body_sig,
					back_path: new_back_path
				}));
				return;
			}
		}
		const is_broken_path = JSON.parse(body).type == 'broken_path';
		if (back_path_parsed.length > 0 && !is_broken_path) {
			await PeerConnection.source_route(back_path_parsed, {
				type: 'broken_path',
				expiration: get_expiration(),
				broken_forward_path: forward_path,
				broken_forward_sig: forward_sig
			});
		}
	}
}
PeerConnection.events.addEventListener('connected', ({connection}) => console.log('connected', connection));
PeerConnection.events.addEventListener('disconnected', ({connection}) => console.log('disconnected', connection));