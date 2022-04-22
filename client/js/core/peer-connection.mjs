import { PeerId, our_peerid } from "./peer-id.mjs";
import { get_expiration } from "./lib.mjs";
import { check_expiration } from "./lib.mjs";

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

// Message that can only be sent directly from peer to peer
const routable = ['kbucket'];
// Messages which can only be source_routed (no kademlia routing)
const forwardable = ['siblings', 'not_siblings', 'connect', 'route_ack'];

// Messages that have been verified will be sent as events on this object.
// Additionally, we have the special 'route' message
export const messages = new EventTarget();

class MessageEvent extends CustomEvent {
	constructor(props = {}, type = props.msg?.type) {
		super(type, { cancelable: true });
		for (const key in props) {
			Object.defineProperty(this, key, {
				value: props[key],
				writable: false
			});
		}
	}
	async reply(msg) {
		this.stopImmediatePropagation();
		await PeerConnection.source_route(this.back_path_parsed, msg);
	}
}

export async function verify_message(data, last_pid = our_peerid) {
	let {
		forward_path, forward_sig,
		body, body_sig,
		back_path
	} = JSON.parse(data);

	// Verify the back_path
	if (!Array.isArray(back_path)) throw new Error('missing back_path');
	const back_path_parsed = [];
	if (back_path.length < 1) throw new Error("back path can't be empty.");
	for (const hop of back_path) {
		if (typeof hop != 'string') throw new Error('non-string in back_path');
		let [peer_id, signature] = hop.split('.');
		peer_id = await PeerId.from_encoded(peer_id ?? '');
		if (!await peer_id.verify(signature ?? '', last_pid.public_key_encoded + body_sig ?? '')) throw new Error('signature failed in back_path.');
		back_path_parsed.unshift(peer_id);

		nd_connect(last_pid, peer_id);

		// TODO: The following check might not work, when verifying forwarded subscribe messages
		if (peer_id == our_peerid) throw new Error('Routing cycle detected in the back-path');

		last_pid = peer_id;
	}
	const origin = back_path_parsed[0];

	// Verify the forward_path:
	let forward_path_parsed;
	if (typeof forward_path == 'string') {
		if (!origin.verify(forward_sig ?? '', forward_path)) throw new Error('forward_sig invalid.');
		// Parse the forward_path:
		forward_path_parsed = await Promise.all(forward_path.split(',').map(PeerId.from_encoded));
	}

	// Verify the body:
	if (typeof body != 'string') throw new Error('message was missing a body');
	if (!origin.verify(body_sig ?? '', body)) throw new Error('body_sig invalid.');

	// Parse the body
	const msg = JSON.parse(body);

	// Check if the body has all required fields?
	if (typeof msg?.type != 'string') throw new Error('Message was missing a type.');

	// Routable messages need an expiration so that they can't be replayed.  Unroutable messages don't need an expiration because we the message comes directly from the sender.
	let target;
	if (routable.includes(msg.type)) {
		target = BigInt('0x' + msg.target);
		check_expiration(msg.expiration);
	} else if (forwardable.includes(msg.type)) {
		check_expiration(msg.expiration);
	} else {
		if (back_path_parsed.length != 1) throw new Error("Unroutable message was not sent directly to use.");
	}

	// TODO: Handle encryption

	return {
		origin, target,
		forward_path_parsed, forward_path, forward_sig,
		msg, 
		body, body_sig,
		back_path_parsed, back_path
	};
}

// Together connection_table + routing_table form a tree 
// PeerId -> PeerConnection
const connection_table = new Map();
// PeerId -> PeerId + num_hops
const routing_table = new WeakMap();
export function insert_back_path(back_path_parsed) {

}

// KBuckets
const kbuckets = new Array(255);

/**
 * ROUTING:
 * 1. Check the connection_table for a PeerConnection with an open / ready message_channel
 * 2. Check the routing_table for a valid source path.
 * 3. If there's no valid path, then do a kbucket lookup
 * 4. If there's nothing in the kbuckets, then look for a peer that is closest 
 */
export async function try_send_msg(destination, msg) {
	const path = [];
	for (let step = destination; step !== undefined && !connection_table.has(step); step = routing_table.get(step)) {
		path.push(step);
	}
	if (!connection_table.has(step)) {
		// TODO: Send the message using the discovered path
	} else {
		// TODO: Send the message to the peer that is closest to the destination
	}
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

