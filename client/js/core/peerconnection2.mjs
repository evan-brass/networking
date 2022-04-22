
/**
 * I'm realizing that managing connections and being able to send messages are tightly entwined.  In order to establish a connection we need to be able to route ice / sdp messages.  And if the path breaks, then we need to kademlia route the messages.
 */

// PeerConnection -> PeerId on the other side of the connection (authenticated using sdp munging)
const other_id = new Map();

// PeerId -> PeerConnection
const connection_table = new Map();
// Directed Asyclic Graph of: PeerId -> PeerId + num_hops
const routing_table = new WeakMap();

// We need a list of messages that we've sent so that we can retransmit them if we receive a broken_path message.  But also, we need to be able to retransmit if we don't receive an answer.  Alternatively, we need a way for requests (including peerconnections) to timeout and be cleaned up.  The problem with this is that we would then try the same request and would lose all the information about what happened in the previous request.  For instance, how do we accumulate reputation information?
// We need to put a target / destination in every packet so that it can be routed, and that destination can be different from the forwarding path (so that we can source route a message part of the way, and then use kad routing for the rest).
// If we can route all messages, then we don't really need the path / lost_path messages.


export async function try_send_msg(destination, msg) {
	// TODO: implement:
}

/**
 * ROUTING:
 * 1. Check the connection_table for a PeerConnection with an open / ready message_channel
 * 2. Check the routing_table for a valid source path.
 * 3. If there's no valid path, then do a kbucket lookup
 * 4. If there's nothing in the kbuckets, then look for a peer that is closest 
 */
export class PeerConnection extends RTCPeerConnection {
	#making_offer = false; // Used by the perfect negotiation pattern.
	data_channels = new Map(); // Label -> rtcdatachannel
	static handle_connect(origin, { sdp, ice }) {

	}
	async #negotiationneeded() {
		try {
			this.#making_offer = true;
			await this.setLocalDescription();
			await PeerConnection.source_route(path, {
				type: 'connect',
				expiration: get_expiration(),
				sdp: pc.localDescription
			});
		} catch (e) {
			console.error(e);
		} finally {
			this.#making_offer = false;
		}
	}
	constructor(origin) {
		super({ iceServers });

		this.origin = origin;
		if (origin) connection_table.set(origin, this);

		this.createDataChannel('message-channel').addEventListener('open', this.#handle_channel.bind(this));
		this.addEventListener('datachannel', this.#handle_channel.bind(this));

		// TODO: add handlers for sending negotiation / ice candidates
		this.addEventListener('negotiationneeded', this.#negotiationneeded);
		pc.onicecandidate = async function ({ candidate }) {
			console.log(this === pc);
			if (candidate == null) return;
			await PeerConnection.source_route(path, {
				type: 'connect',
				expiration: get_expiration(),
				ice: candidate
			});
		};

	}
	#handle_channel(channel) {

	}
}