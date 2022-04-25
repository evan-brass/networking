import { PeerId, our_peerid } from "./peer-id.mjs";
import { get_expiration } from "./lib.mjs";
import { routing_table, send_msg } from "./routing.mjs";
import { messages, verify_message, MessageEvent } from "./message.mjs";

// TODO: TESTING / VISUALIZATION
// PeerId -> Set<PeerId>
export const network_diagram = new Map();
setInterval(() => network_diagram.clear(), 5000);
export function nd_connect(a, b) {
	let nd = network_diagram.get(a);
	if (!nd) {
		nd = new Set();
		network_diagram.set(a, nd);
	}
	nd.add(b);
}

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
class DataChannelEvent extends CustomEvent {
	constructor(peer_connection, channel) {
		super('datachannel');
		this.connection = peer_connection;
		this.channel = channel;
	}
}

// For data-channels, it seems we don't need to follow the normal offer-answer flow.  Instead we can just send a few important pieces of information from the sdp and then we can pass ice candidates.
function parse_sdp(sdp) {
	const ice_ufrag = /a=ice-ufrag:(.+)/.exec(sdp)[1];
	const ice_pwd = /a=ice-pwd:(.+)/.exec(sdp)[1];
	let dtls_fingerprint = /a=fingerprint:sha-256 (.+)/.exec(sdp)[1];
	dtls_fingerprint = dtls_fingerprint.split(':');
	dtls_fingerprint = new Uint8Array(dtls_fingerprint.map(s => parseInt(s, 16)));
	return { ice_ufrag, ice_pwd, dtls_fingerprint };
}
function rehydrate_answer({ ice_ufrag, ice_pwd, dtls_fingerprint }, server = true) {
	dtls_fingerprint = Array.from(dtls_fingerprint).map(b => b.toString(16).padStart(2, '0')).join(':');
	return { type: 'answer', sdp:
`v=0
o=- 5721234437895308592 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=extmap-allow-mixed
a=msid-semantic: WMS
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=ice-ufrag:${ice_ufrag}
a=ice-pwd:${ice_pwd}
a=ice-options:trickle
a=fingerprint:sha-256 ${dtls_fingerprint}
a=setup:${server ? 'passive' : 'active'}
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
` };
}

/**
 * Our peer connection is a special RTCPeerConnection that also manages the RTCDataChannel for the hyperspace-network, as well as any other datachannels that are signalled (For GossipSub, or blockchain needs).  I'm trying to not have a separation between the routing table (peer_id -> websocket | rtcdatachannel) and the peer table (peer_id -> rtcpeerconnection) as that wasn't working very well.
 */
export class PeerConnection extends RTCPeerConnection {
	// Set of all the open / openning PeerConections
	// The primary key for the a connection is: (other_id, dtls-fingerprint)
	// The ice-ufrag and ice-pwd can change because of ice-restarts.  If the dtls-fingerprint is the same, then we don't need to create a new connection.  We only need a new peerconnection if the dtls fingerprint is different.
	static connections = new Set();
	static async connect(other_id) {

	}
	// Events announces when our peer connections open or close.
	static events = new EventTarget();
	// Label -> RTCDataChannel
	data_channels = new Map();
	#claimed = 0;

	#connecting_timeout = false;
	#claimed_timeout = false;
	constructor(other_id) {
		super({ iceServers });

		if (other_id) {
			this.other_id = other_id;
			PeerConnection.connections.set(other_id, this);
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
			connection_table.set(this.other_id, channel);
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
	async #network_msg({ data }) {
		const parts = await verify_message(data);
		parts.connection = this;

		if (parts.back_path_parsed[parts.back_path_parsed.length - 1] !== this.other_id) {
			throw new Error("The other_id of the connection that this message came in on didn't put itself in the back_path properly.");
		}

		// Forward the message if we're not the intended target:
		if (parts.forward_path_parsed && parts.forward_path_parsed[0] !== our_peerid) {
			await PeerConnection.source_route_data(parts.forward_path_parsed, parts);
			return;
		}

		// Issue the message as an event:
		console.log('recv', parts.msg);
		const not_handled = messages.dispatchEvent(new MessageEvent(parts));

		// If the event does not have its propagation stopped, then route the message to a closer peer
		if (not_handled && routable.includes(parts.msg.type)) {
			messages.dispatchEvent(new MessageEvent(parts, 'route'));
		}
	}

	#claimed_timeout_func() {
		if (this.#claimed == 0) {
			this.abandon();
		}
		this.#claimed_timeout = false;
	}
	claim() {
		// this.#claimed += 1;
		// if (this.#claimed_timeout) clearTimeout(this.#claimed_timeout);
		// this.#claimed_timeout = false;
	}
	release() {
		// this.#claimed -= 1;
		// if (this.#claimed == 0 && this.#claimed_timeout == false) {
		// 	this.#claimed_timeout = setTimeout(this.#claimed_timeout_func.bind(this), 5000);
		// }
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

	static async handle_connect(origin, back_path_parsed, { ice, sdp }) {
		const pc = PeerConnection.connections.get(origin) ?? new PeerConnection(origin);
		if (sdp) {
			try {
				const offer_collision = (sdp.type == 'offer') && (pc.making_offer || pc.signalingState != 'stable');
				const ignore_offer = !origin.polite() && offer_collision;

				if (ignore_offer) return;

				await pc.setRemoteDescription(sdp);
				if (sdp.type == 'offer') {
					await pc.setLocalDescription();
					// TODO: use try_send_msg instead
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

