import { PeerConnection } from "./peer-connection.mjs";


// We use a special SDP attribute to identify the rtcpeerconnection:
// s=<base64-public-key>.<base64 sec-1 signature>
// Technically, the s field is the session description which is required in SDP but browsers don't use it to convey any useful information.
// We only need to mung the sdp during bootstrapping, because our signaling messages will be signed + encrypted otherwise.
// TODO: Move the SDP munging into bootstrap.mjs
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

// Random bytestring of length 20 (Used by webtorrent a lot):
function r20bs() {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	const str = Array.from(bytes).map(v => String.fromCharCode(v)).join('');
	return str;
}

const peer_id = r20bs();
// offer_id -> PeerConnection
const peer_conns = new Map();
// tracker address -> WebSocket
const tracker_conns = new Map();
async function get_ws(tracker) {
	let ws = tracker_conns.get(tracker);
	if (!ws || ws.readyState == 2 || ws.readyState == 3) {
		ws = new WebSocket(tracker);
		tracker_conns.set(tracker, ws);
		await new Promise(r => ws.onopen = r);

		const intervals = new Map();

		ws.onmessage = async ({data}) => {
			const msg = JSON.parse(data);

			if (msg.interval) {
				const info_hash = msg.info_hash;
				const old_interval = intervals.get(msg.info_hash);
				if (old_interval) clearInterval(old_interval);

				intervals.set(info_hash, setInterval(() => {
					console.log('tracker_interval ran');
					if (ws.readyState == ws.OPEN) {
						ws.send(JSON.stringify({
							action: 'announce',
							peer_id, info_hash,
							numwant: 1,
							event: 'completed', downloaded: 600, left: 0, uploaded: 0
						}));
					}
				}, 30000)); // I really don't know why using the actual interval that the tracker sends us doesn't work, but oh well.
			}
			if (msg.offer) {
				const pc = new PeerConnection();
				const answer = await pc.negotiate(msg.offer);
				ws.send(JSON.stringify({
					action: 'announce',
					peer_id, info_hash: msg.info_hash,
					to_peer_id: msg.peer_id,
					offer_id: msg.offer_id,
					answer
				}));
			} else if (msg.answer) {
				const pc = peer_conns.get(msg.offer_id)
				await pc.negotiate(msg.answer);
				peer_conns.delete(msg.offer_id);
			}
		};
		ws.onclose = () => {
			for (const i of intervals.values()) {
				clearInterval(i);
			}
		};
	}
	return ws;
}

let bootstrap_waiters = new Set();
PeerConnection.events.addEventListener('connected', () => {
	for (const r of bootstrap_waiters) {
		r();
	}
	bootstrap_waiters.clear();
});

export async function bootstrap_tracker(info_hash, tracker) {
	// Soo... Even closed RTCPeerConnections count against our limit (in chrome the limit is 500 connections)
	// So we have to cleanup the peer_conns map of closed connections as the first thing before we start trying to create more:
	for (const [key, conn] of peer_conns.entries()) {
		if (conn.connectionState == 'closed') {
			peer_conns.delete(key);
		}
	}

	const ws = await get_ws(tracker);

	const offer_id = r20bs();
	let pc = new PeerConnection();
	peer_conns.set(offer_id, pc);
	const offers = [{
		offer_id,
		offer: await pc.negotiate()
	}];

	ws.send(JSON.stringify({
		action: 'announce',
		peer_id, info_hash,
		numwant: offers.length, offers,
		event: "started", downloaded: 100, left: 500, uploaded: 0
	}));

	await new Promise(r => bootstrap_waiters.add(r));
}