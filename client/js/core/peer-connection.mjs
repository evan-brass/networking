import { PeerId, our_peerid } from "./peer-id.mjs";

// TODO: let the user edit their ICE configuration
const iceServers = [{
	// A list of stun/turn servers: https://gist.github.com/sagivo/3a4b2f2c7ac6e1b5267c2f1f59ac6c6b
	urls: [
		'stun:stun.l.google.com:19302',
		'stun:stun1.l.google.com:19302'
	]
}];

// We use a special SDP attribute to identify the rtcpeerconnection:
// s=<base64-public-key>.<base64 sec-1 signature>
// Technically, the s field is the session description which is required in SDP but browsers don't use it to convey any useful information.
function get_fingerprints_bytes(sdp) {
	const fingerprint_regex = /^a=fingerprint:sha-256 (.+)/gm;
	
	const fingerprints = [];
	let result;
	while ((result = fingerprint_regex.exec(sdp)) !== null) {
		const { 0: str } = result;
		fingerprints.push(...str.split(':').map(b => Number.parseInt(b, 16)));
	}
	return new Uint8Array(fingerprints);
}
async function mung_sdp({type, sdp}) {
	// Modify the offer with a signature of our DTLS fingerprint:
	const fingerprints_bytes = get_fingerprints_bytes(sdp);
	const signature = await our_peerid.sign(fingerprints_bytes);
	sdp = sdp.replace(/^s=.+/gm, `s=${our_peerid.public_key_encoded}.${signature}`);
	return {type, sdp};
}

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
	#hn_dc = null;
	#connecting_timeout = false;
	#making_offer = false;
	#claimed = 0;
	#claimed_timeout = false;
	constructor() {
		super({
			bundlePolicy: "max-bundle", // Bundling is supported by browsers, just not voip-phones and such.
			iceCandidatePoolSize: 3,
			iceServers
		});

		// TODO: Add a sub-protocol?
		// Create the main hyperspace data channel which carries routing and signaling traffic.
		this.#hn_dc = this.createDataChannel('hyperspace-network', {
			negotiated: true,
			id: 42
		});
		// We use the main network channel to know when a PeerConnection is officially open.
		this.#hn_dc.onopen = () => {
			clearTimeout(this.#connecting_timeout);
			this.#claimed_timeout = setTimeout(this.#claimed_timeout_func.bind(this), 5000);
			PeerConnection.events.dispatchEvent(new ConnectedEvent(this));
		};
		this.#hn_dc.onclose = () => {
			if (this.other_id) {
				PeerConnection.events.dispatchEvent(new DisconnectedEvent(this));
			}
			// Closing the hyperspace-network data channel closes the connection.  (in the future this might not always be true?)
			if (this.connectionState !== 'closed') this.abandon();
		};
		this.#hn_dc.onmessage = ({ data }) => {
			PeerConnection.events.dispatchEvent(new NetworkMessageEvent(this, data));
		};
		this.ondatachannel = ({ channel }) => {
			PeerConnection.events.dispatchEvent(new DataChannelEvent(this, channel));
		};

		// Set a timeout so that we don't get a peer connection that lives in new forever.
		this.#connecting_timeout = setTimeout(this.abandon.bind(this), 10000);
		// Close connections that get disconnected or fail (alternatively we could restartice and then timeout);
		this.onconnectionstatechange = () => {
			if (this.connectionState == 'disconnected' || this.connectionState == 'failed') this.abandon();
		};
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
		return this.#hn_dc.readyState == 'open';
	}
	send(data) {
		if (this.is_open()) {
			this.#hn_dc.send(data);
		} else {
			throw new Error("The datachannel for this peer connection is not in an open readyState.");
		}
	}
	abandon() {
		this.close();
		PeerConnection.connections.delete(this.other_id);
		this.ondatachannel = undefined;
		this.#hn_dc.onmessage = undefined;
	}
	async #ice_done() {
		while (this.iceGatheringState != 'complete') {
			await new Promise(res => {
				this.addEventListener('icegatheringstatechange', res, { once: true });
			});
		}
	}
	// Should really only be used by bootstrap which needs to create peer connections without an other_id
	async negotiate({ type, sdp } = {}) {
		// Ignore any changes if the peer connection is closed.
		if (this.signalingState == 'closed') return;

		if (type === undefined) {
			// Skip trying to create an offer if we're already connected to this peer.
			if (this.iceConnectionState == 'connected' || this.iceConnectionState == 'completed') return;
			
			// Negotiate will be called without a description when we are initiating a connection to another peer, or when we are generating offers for webtorrent trackers.
			this.#making_offer = true;

			await this.setLocalDescription();
			await this.#ice_done();

			this.#making_offer = false;
			return mung_sdp(this.localDescription);
		}
		// We're creating an answer.
		// Get the DTLS fingerprint(s) from the sdp (In our case, there should always just be a single fingerprint, but just in case...)
		const fingerprints_bytes = get_fingerprints_bytes(sdp);

		// Get the peer-id and signature from the sdp
		const sig_regex = /^s=([^\.\s]+)\.([^\.\s]+)/gm;
		const result = sig_regex.exec(sdp);
		if (result == null) throw new Error("Offer didn't include a signature.");
		const { 1: public_key_str, 2: signature_str } = result;
		const other_id = await PeerId.from_encoded(public_key_str);
		const valid = await other_id.verify(signature_str, fingerprints_bytes);
		if (!valid) throw new Error("The signature in the offer didn't match the DTLS fingerprint(s).");

		// Check to make sure that we don't switch what peer is on the other side of this connection.
		if (other_id == our_peerid || (this.other_id && this.other_id !== other_id)) {
			throw new Error("Something bad happened - this massage shouldn't have been sent to this peer.");
		}
		const existing = PeerConnection.connections.get(other_id)
		if (existing === undefined) {
			PeerConnection.connections.set(other_id, this);
			this.other_id = other_id;
		} else if (existing !== this) {
			this.abandon();
			throw new Error("Cannot negotiate multiple connections with the same peer.");
		}

		const offer_collision = type == 'offer' && (this.#making_offer || this.signalingState !== 'stable');
		if (this.other_id.polite() || !offer_collision) {
			if (type == 'answer' && this.signalingState == 'stable') return;

			// Now that we know that this offer came from another Hyperspace Peer, we can answer it.
			await this.setRemoteDescription({ type, sdp });
			if (type == 'offer') {
				await this.setLocalDescription();
				await this.#ice_done();
				return mung_sdp(this.localDescription);
			}
		}
	}

	static async handle_connect(origin, description) {
		// Find the peerconnection that has origin and try to negotiate it:
		const existing = PeerConnection.connections.get(origin);
		if (existing !== undefined) {
			return await existing.negotiate(description);
		} else {
			// If there is no active peer connection, and this is an offer, then create one.
			const pc = new PeerConnection();
			pc.other_id = origin;
			PeerConnection.connections.set(origin, pc);
			return await pc.negotiate(description);
		}
	}

	// Routing (Routing along a path doesn't require any tables - we just route across all connections):
	async source_route(path, msg) {
		const body = JSON.stringify(msg);
		const body_sig = await our_peerid.sign(body);
		const forward_path = path.map(pid => pid.public_key_encoded).join(',');
		const forward_sig = await our_peerid.sign(forward_path);

		return await PeerConnection.source_route_data(path, {forward_path, forward_sig, body, body_sig, back_path: []});
	}
	// source_route_data is also used for forwarding
	async source_route_data(path, {forward_path, forward_sig, body, body_sig, back_path}) {
		// Check for loops in the path (TODO: simplify around the loops?):
		const loop_check = new Set();
		for (const pid of path) {
			if (loop_check.has(pid)) throw new Error("Found a routing loop in the path");
			loop_check.add(pid);
		}
		
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
					origin: our_peerid.public_key_encoded,
					forward_path, forward_sig,
					body, body_sig,
					back_path: new_back_path
				}));
				return;
			}
		}
		// TODO: handle broken paths by sending back a broken_path message instead.
		throw new Error('Routing Failed: Path');
	}
}