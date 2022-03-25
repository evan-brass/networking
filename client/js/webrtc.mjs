import { message_handler } from "./messages.mjs";
import { iceServers } from "./network-props.mjs";
import { publicKey_encoded, privateKey } from "./peer-id.mjs";
import { base64_decode, base64_encode, P256 } from "./lib.mjs";
import { our_kad_id, kad_id } from "./kad.mjs";


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
	sdp = sdp.replace(/^s=.+/gm, `s=${publicKey_encoded}.${base64_encode(new Uint8Array(signature))}`);
	return {type, sdp};
}

/**
 * Our peer connection is a special RTCPeerConnection that also manages the RTCDataChannel for the hyperspace-network, as well as any other datachannels that are signalled (For GossipSub, or blockchain needs).  I'm trying to not have a separation between the routing table (peer_id -> websocket | rtcdatachannel) and the peer table (peer_id -> rtcpeerconnection) as that wasn't working very well.
 */
export class PeerConnection extends RTCPeerConnection {
	#hn_dc = null;
	#polite = false;
	#connecting_timeout = false;
	static connections = new Set();
	#making_offer = false;
	constructor() {
		super({
			bundlePolicy: "max-bundle", // Bundling is supported by browsers, just not voip-phones and such.
			iceCandidatePoolSize: 3,
			iceServers
		});

		this.ondatachannel = this.#ondatachannel.bind(this);
		this.onconnectionstatechange = this.#onconnectionstatechange.bind(this);

		// Set a timeout so that we don't get a peer connection that lives in new forever.
		this.#connecting_timeout = setTimeout(this.#abandon.bind(this), 5000);

		PeerConnection.connections.add(this);
	}
	#abandon() {
		this.close();
		this.#onconnectionstatechange();
	}
	#onconnectionstatechange() {
		if (this.#connecting_timeout) {
			clearTimeout(this.#connecting_timeout);
			this.#connecting_timeout = false;
		}
		if (this.connectionState == 'failed') {
			this.#abandon();
		}
		if (this.connectionState == 'connecting') {
			// Set a timeout so that we don't get a peer connection that lives in connecting forever.
			this.#connecting_timeout = setTimeout(this.#abandon.bind(this), 5000);
		}
		if (this.connectionState == 'closed') {
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
	async negotiate({ type, sdp } = {}) {
		if (type === undefined) {
			// Negotiate will be called without a description when we are initiating a connection to another peer, or when we are generating offers for webtorrent trackers.
			this.#making_offer = true;
			// This is a brand new connection - add our data channel and make an offer:
			// We're creating an offer.  We want our offer to include an SCTP for our data channelss
			const hy_datachannel = this.createDataChannel('hyperspace-network');
			hy_datachannel.onopen = () => {
				this.#hn_dc = hy_datachannel;
				this.#hn_dc.onopen = undefined;
				this.#hn_dc.onmessage = message_handler;
				console.log("New Connection:", this.other_id);
			};

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
		const public_key_bytes = base64_decode(public_key_str);
		const offer_pk = await crypto.subtle.importKey("raw", public_key_bytes, P256, false, ['verify']);
		if (!await crypto.subtle.verify(P256, offer_pk, base64_decode(signature_str), fingerprints_bytes)) {
			debugger;
			throw new Error("The signature in the offer didn't match the DTLS fingerprint.");
		}

		// Check to make sure that we don't switch what peer is on the other side of this connection.
		if (this.other_id && this.other_id !== public_key_str) {
			throw new Error("Something bad happened - this massage shouldn't have been sent to this peer.");
		}
		this.other_id = public_key_str;
		
		const their_kad_id = kad_id(public_key_bytes);
		this.#polite = our_kad_id < their_kad_id;

		const offer_collision = type == 'offer' && (this.#making_offer || this.signalingState !== 'stable');
		if (this.#polite || !offer_collision) {
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
		if (channel.label == 'hyperspace-network') {
			// This channel might be immediately closed, but we still want to handle any messages that come over it.
			channel.onmessage = message_handler;
			console.log("New Connection:", this.other_id);
			this.#hn_dc = channel;
		}
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
		return pc.negotiate(description);
	}
}