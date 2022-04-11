import { message_handler } from "./messages.mjs";
import { iceServers } from "./network-props.mjs";
import { privateKey, PeerId, our_peerid } from "./peer-id.mjs";
import { base64_decode, base64_encode, P256 } from "./lib.mjs";
import { routing_table } from "./routing-table.mjs";


// We use a special SDP attribute to identify the rtcpeerconnection:
// s=<base64-public-key>.<base64 sec-1 signature>
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
	const signature = await crypto.subtle.sign(P256, privateKey, fingerprints_bytes);
	sdp = sdp.replace(/^s=.+/gm, `s=${our_peerid.public_key_encoded}.${base64_encode(new Uint8Array(signature))}`);
	return {type, sdp};
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
		this.#hn_dc.onopen = () => {
			clearTimeout(this.#connecting_timeout);
			this.#claimed_timeout = setTimeout(this.#claimed_timeout_func.bind(this), 5000);
			PeerConnection.events.dispatchEvent(new CustomEvent('connected', { detail: this }));
			routing_table.insert(this);
		};
		this.#hn_dc.onclose = () => {
			if (this.other_id) {
				PeerConnection.events.dispatchEvent(new CustomEvent('disconnected', { detail: this }));
				routing_table.delete(this);
			}
		};
		this.#hn_dc.onmessage = message_handler;

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
		if (this.#hn_dc?.readyState == 'open') {
			console.warn('Abandoning a peerconnection that is routable:', this);
		}
		this.close();
		PeerConnection.connections.delete(this.other_id);
		this.ondatachannel = undefined;
		this.#hn_dc.onmessage = undefined;
	}
	#ice_done() {
		return new Promise(res => {
			this.onicegatheringstatechange = () => {
				if (this.iceGatheringState == 'complete') {
					res();
					this.onicegatheringstatechange = undefined;
				}
			};
			this.onicegatheringstatechange();
		});
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
			if (this.localDescription == null) debugger;
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
		const valid = await other_id.verify(base64_decode(signature_str), fingerprints_bytes);
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
}