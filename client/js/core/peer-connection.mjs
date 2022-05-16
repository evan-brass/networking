import { P256 } from "./lib.mjs";
// import { routing_table, route_msg } from "./routing.mjs";
import { handle_data, messages } from "./message.mjs";
import { add_conn, remove_conn, send, wanted_conns } from "./routing.mjs";

// We don't care what this certificate is, but we want it to be reused long enough for all peers that might still have a peerconnection for our peerid have closed it.  That way the DTLS fingerprint never changes underneath a peerConnection.
const certificates = [await RTCPeerConnection.generateCertificate(P256)];

// TODO: let the user edit their ICE configuration
const iceServers = [
	// A list of stun/turn servers: https://gist.github.com/sagivo/3a4b2f2c7ac6e1b5267c2f1f59ac6c6b
	{
		urls: [
			'stun:stun.l.google.com:19302',
			'stun:stun1.l.google.com:19302'
		]
	},
	// {
	// 	urls: "stun:openrelay.metered.ca:80"
	// }, {
	// 	urls: [
	// 		"turns:openrelay.metered.ca:443",
	// 		"turn:openrelay.metered.ca:80",
	// 		"turn:openrelay.metered.ca:443?transport=tcp"
	// 	],
	// 	username: "openrelayproject",
	// 	credential: "openrelayproject"
	// }
];

class DataChannelEvent extends CustomEvent {
	constructor(peer_connection, channel) {
		super('datachannel', { cancelable: true });
		this.connection = peer_connection;
		this.channel = channel;
	}
}

// For data-channels, it seems we don't need to follow the normal offer-answer flow.  Instead we can just send a few important pieces of information from the sdp and then we can pass ice candidates.
export function parse_sdp(sdp) {
	const ice_ufrag = /a=ice-ufrag:(.+)/.exec(sdp)[1];
	const ice_pwd = /a=ice-pwd:(.+)/.exec(sdp)[1];
	const dtls_fingerprint = /a=fingerprint:sha-256 (.+)/.exec(sdp)[1];
	return { ice_ufrag, ice_pwd, dtls_fingerprint };
}
function rehydrate_answer({ ice_ufrag, ice_pwd, dtls_fingerprint }, server = true) {
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
	dc;
	#connecting_timeout = false;
	
	// PeerId -> PeerConnection (The PeerConnection may not be open yet.)
	static connections = new Map();

	// Events announces when our peer connections open or close.
	static events = new EventTarget();

	static connect(other_id) {
		let c = PeerConnection.connections.get(other_id);
		if (c) return c;

		// Create a new PeerConnection
		return new PeerConnection(other_id);
	}
	static async handle_connect({origin, msg: { ice, ice_ufrag, ice_pwd, dtls_fingerprint }}) {
		const pc = PeerConnection.connect(origin);
		// Wait until our offer has been successfully applied before we start adding remote information.
		while (pc.localDescription == null) {
			await new Promise(res => pc.addEventListener('signalingstatechange', res, {once: true}));
		}
		// TODO: if the dtls_fingerprint doesn't match, then we need to kill the peerconnection and open a new one.
		if (ice_ufrag && (ice_ufrag !== pc.ice_ufrag || ice_pwd !== pc.ice_pwd)) {
			const answer = rehydrate_answer({ ice_ufrag, ice_pwd, dtls_fingerprint }, origin.polite());
			pc.ice_ufrag = ice_ufrag;
			pc.ice_pwd = ice_pwd;
			pc.dtls_fingerprint = dtls_fingerprint;
			await pc.setRemoteDescription(answer);
		}
		if (ice) {
			try {
				await pc.addIceCandidate(ice);
			} catch {}
		}
	}

	constructor(other_id) {
		super({ iceServers, certificates });

		if (other_id) {
			this.other_id = other_id;
			PeerConnection.connections.set(other_id, this);
	
			this.addEventListener('negotiationneeded', async () => {
				await this.setLocalDescription();
				const { ice_ufrag, ice_pwd, dtls_fingerprint } = parse_sdp(this.localDescription.sdp);
				await send(this.other_id, {
					type: 'connect',
					encrypted: {
						ice_ufrag, ice_pwd,
						dtls_fingerprint
					}
				});
			});
			this.addEventListener('icecandidate', async ({ candidate }) => {
				if (!candidate) return;
	
				await send(this.other_id, {
					type: 'connect',
					encrypted: {
						ice: candidate
					}
				});
			});
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
		// We deduplicate hyperspace-network channels, but we don't deduplicate other channels.
		if (channel.label == 'hyperspace-network') {
			channel.onmessage = handle_data.bind(null, this);
			if (this.#connecting_timeout !== undefined) {
				clearTimeout(this.#connecting_timeout);
				this.#connecting_timeout = undefined;
			}
			if (this.dc) {
				if (channel.id > this.dc.id) {
					this.dc.close();
					this.dc = channel;
				}
			} else {
				this.dc = channel;
				console.log(`Connected, , ${this.other_id.kad_id}, ${performance.now()}`);
				add_conn(this);
			}
		} else {
			const not_handled = PeerConnection.events.dispatchEvent(new DataChannelEvent(this, channel));
			if (not_handled) channel.close();
		}
	}
	#channel_close({ target: channel }) {
		if (this.dc === channel) {
			this.dc = null;
			console.log(`Disconnected, , ${this.other_id.kad_id}, ${performance.now()}`);
			remove_conn(this);
		}
	}
	is_open() {
		return this.dc?.readyState === 'open';
	}
	abandon() {
		this.close();
		PeerConnection.connections.delete(this.other_id);
		if (this.other_id) {
			remove_conn(this);
		}
	}
}
messages.addEventListener('connect', PeerConnection.handle_connect);
wanted_conns.addEventListener('wanted', ({peer_id}) => {
	PeerConnection.connect(peer_id);
});