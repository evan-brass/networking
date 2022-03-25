import { sign_message, verify_message, message_handler } from "./messages.mjs";
import { iceServers } from "./network-props.mjs";
import { connection_table } from "./routing-table.mjs";
import { publicKey_encoded, privateKey } from "./peer-id.mjs";
import { base64_decode, base64_encode, P256 } from "./lib.mjs";
import { our_kad_id, kad_id } from "./kad.mjs";


// We use a special SDP attribute to identify the rtcpeer connection:
// a=hy-sig:<base64-public-key>.<base64 sec-1 signature>
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
		// this.onnegotiationneeded = this.#onnegotiationneeded.bind(this);

		PeerConnection.connections.add(this);
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
			this.#making_offer = true;
			// This is a brand new connection - add our data channel and make an offer:
			// We're creating an offer.  We want our offer to include an SCTP for our data channelss
			const hy_datachannel = this.createDataChannel('hyperspace-network');
			hy_datachannel.onopen = () => {
				this.#hn_dc = hy_datachannel;
				console.log("New Connection:", this.other_id);
				hy_datachannel.onopen = undefined;
			};

			const offer = await this.createOffer();
			await this.setLocalDescription(offer);
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

		const their_kad_id = kad_id(public_key_bytes);
		const polite = our_kad_id < their_kad_id;

		// Check to make sure that we don't switch what peer is on the other side of this connection.
		if (this.other_id && this.other_id !== public_key_str) {
			throw new Error("Something bad happened - this massage shouldn't have been sent to this peer.");
		}
		this.other_id = public_key_str;

		const offer_collision = type == 'offer' && (this.#making_offer || this.signalingState !== 'stable');
		if (polite || !offer_collision) {
			// Now that we know that this offer came from another Hyperspace Peer, we can answer it.
			await this.setRemoteDescription({ type, sdp });
			if (type == 'offer') {
				const answer = await this.createAnswer();
				await this.setLocalDescription(answer);
				return mung_sdp(this.localDescription);
			}
		}
	}
	#onconnectionstatechange() {
		if (this.connectionState == 'closed' || this.connectionState == 'failed') {
			PeerConnection.connections.delete(this);
		}
	}
	#ondatachannel({ channel }) {
		if (channel.label == 'hyperspace-network') {
			this.#hn_dc = channel;
			console.log("New Connection:", this.other_id);
		}
	}
}

// Send an address message to the connection and wait until we've received an address message so that we know who is on the other end.
export function identify_connection(channel) {
	return new Promise((resolve, reject) => {
		channel.addEventListener('open', async () => {
			channel.send(await sign_message({
				type: 'addresses',
				addresses: []
			}));
		});
		channel.addEventListener('close', reject);
		channel.addEventListener('error', reject);
		channel.onmessage = async ({ data }) => {
			const valid = await verify_message(data);
			if (valid) {
				const {origin} = valid;
				resolve(origin);
				channel.onmessage = null;
				channel.addEventListener('message', message_handler);
				message_handler({ data });
			}
		};
	});
}

export function channel_established(channel) {
	return new Promise((resolve, reject) => {
		channel.addEventListener('open', resolve);
		channel.addEventListener('close', reject);
	});
}

export function create_peer_connection() {
	const peer_connection = new RTCPeerConnection({ iceServers });
	const data_channel = peer_connection.createDataChannel('hyperspace-network', {
		negotiated: true,
		id: 42
	});
	setTimeout(() => {
		if (peer_connection.connectionState == 'disconnected' || peer_connection.connectionState == 'failed') {
			data_channel.close();
			peer_connection.close();
		}
	}, 5000);
	data_channel.addEventListener('close', () => peer_connection.close());
	data_channel.addEventListener('error', () => peer_connection.close());
	// peer_connection.onconnectionstatechange = () => console.log('conn state', peer_connection.connectionState);
	// peer_connection.onicegatheringstatechange = () => console.log('icegather state', peer_connection.iceConnectionState);
	// peer_connection.onnegotiationneeded = () => console.log('negotiation needed');
	// peer_connection.onsignalingstatechange = () => console.log('signal state', peer_connection.signalingState);
	return {peer_connection, data_channel};
}

export async function negotiate_connection(peer_connection, offer = false) {
	const ice_done = new Promise(res => {
		peer_connection.onicecandidate = ({candidate}) => {
			if (candidate == null) res();
		}
	});
	if (offer) {
		// We're answering an existing connection
		peer_connection.setRemoteDescription(offer);
		const answer = await peer_connection.createAnswer();
		await peer_connection.setLocalDescription(answer);
	} else {
		// This connection will be offered to other peers by the tracker
		const offer = await peer_connection.createOffer();
		await peer_connection.setLocalDescription(offer);
	}
	// Wait for ice gather to complete before returning the offer / answer;
	await ice_done;

	return peer_connection.localDescription;
}