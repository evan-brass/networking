import { message_handler } from "./messages.mjs";
import { iceServers } from "./network-props.mjs";
import { privateKey, PeerId, our_peerid } from "./peer-id.mjs";
import { base64_decode, base64_encode, P256 } from "./lib.mjs";


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
	static connections = new Set();
	static events = new EventTarget();
	#hn_dc = null;
	#connecting_timeout = false;
	#making_offer = false;
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
			PeerConnection.events.dispatchEvent(new CustomEvent('connected', { detail: this }));
		};
		this.#hn_dc.onclose = () => {
			PeerConnection.events.dispatchEvent(new CustomEvent('disconnected', { detail: this }));
		};
		this.#hn_dc.onmessage = message_handler;

		this.ondatachannel = this.#ondatachannel.bind(this);
		this.oniceconnectionstatechange = this.#oniceconnectionstatechange.bind(this);

		// Set a timeout so that we don't get a peer connection that lives in new forever.
		this.#connecting_timeout = setTimeout(this.abandon.bind(this), 10000);

		PeerConnection.connections.add(this);
	}
	send(data) {
		if (this.#hn_dc?.readyState == 'open') {
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
		this.#oniceconnectionstatechange();
	}
	#oniceconnectionstatechange() {
		if (this.#connecting_timeout) {
			clearTimeout(this.#connecting_timeout);
			this.#connecting_timeout = false;
		}
		if (this.iceConnectionState == 'failed' || this.iceConnectionState == 'disconnected') {
			this.abandon();
		} else if (this.iceConnectionState == 'checking') {
			// Set a timeout so that we don't get a peer connection that lives in connecting forever.
			this.#connecting_timeout = setTimeout(this.abandon.bind(this), 5000);
		} else if (this.iceConnectionState == 'connected' || this.iceConnectionState == 'completed') {
			// Set a timeout so that if this peer connection doesn't get picked up by our routing tables, it gets closed eventually.
			// The timeout here is a little longer so that if a peer connects to us and tries to bootstrap, it has a little bit of time to do so.
			// if (this.#claimed_timeout == false) {
			// 	this.#claimed_timeout = setTimeout(() => {
			// 		if (this.#claimed <= 0) {
			// 			this.abandon();
			// 		}
			// 		this.#claimed_timeout = false;
			// 	}, 10000);
			// }
		} if (this.iceConnectionState == 'closed') {
			// Cleanup as much as we can:
			PeerConnection.connections.delete(this);
			this.ondatachannel = undefined;
			this.onconnectionstatechange = undefined;
			if (this.#hn_dc) this.#hn_dc.onmessage = undefined;
		}
	}
	get_hn_dc() {
		if (this.#hn_dc?.readyState == 'open') {
			return this.#hn_dc;
		}
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
		const valid = await other_id.verify(base64_decode(signature_str), fingerprints_bytes);
		if (!valid) throw new Error("The signature in the offer didn't match the DTLS fingerprint(s).");

		// Check to make sure that we don't switch what peer is on the other side of this connection.
		if (this.other_id && this.other_id !== other_id) {
			throw new Error("Something bad happened - this massage shouldn't have been sent to this peer.");
		}
		this.other_id = other_id;

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
	#ondatachannel({ channel }) {
		console.log('new Channel:', channel);
	}
	static async handle_connect(origin, description) {
		// Find the peerconnection that has origin and try to negotiate it:
		for (const pc of PeerConnection.connections) {
			if (pc.other_id == origin) {
				return await pc.negotiate(description);
			}
		}

		// If there is no active peer connection, and this is an offer, then create one.
		const pc = new PeerConnection();
		pc.other_id = origin;
		return await pc.negotiate(description);
	}
}