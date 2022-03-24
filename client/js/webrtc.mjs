import { sign_message, verify_message, message_handler } from "./messages.mjs";
import { iceServers } from "./network-props.mjs";
import { connection_table } from "./routing-table.mjs";
import { publicKey_encoded, privateKey } from "./peer-id.mjs";

/**
 * Our peer connection is a special RTCPeerConnection that also manages the RTCDataChannel for the hyperspace-network, as well as any other datachannels that are signalled.  Once the connection is established and the identity of the peer on the other side is verified then, it can be put into the routing table.
 */
export class PeerConnection extends RTCPeerConnection {
	#hn_dc = null;
	constructor() {
		super({
			bundlePolicy: "max-bundle",
			iceCandidatePoolSize: 3,
			iceServers,
			certificates: [
				RTCPeerCertificate
			]
		});
		this.addEventListener("datachannel", this.#ondatachannel.bind(this));
	}
	async negotiate(offer_sdp = false) {
		if (offer_sdp) {
			// We're creating an answer.
			// Get the fingerprint from the sdp

		} else {
			// We're creating an offer.
		}
	}
	#ondatachannel({ dataChannel }) {

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