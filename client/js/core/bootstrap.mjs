import { PeerConnection } from "./peer-connection.mjs";
import { PeerId, our_peerid } from "./peer-id.mjs";


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
async function unmung_sdp({ type, sdp }) {
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

	return other_id;
}

async function ice_done(pc) {
	while (pc.iceGatheringState != 'complete') {
		await new Promise(res => {
			pc.addEventListener('icegatheringstatechange', res, { once: true });
		});
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
				const pid = await unmung_sdp(msg.offer);
				if (!PeerConnection.connections.has(pid)) {
					const pc = new PeerConnection(pid);
					await pc.setRemoteDescription(msg.offer);
					await pc.setLocalDescription();
					const answer = await mung_sdp(pc.localDescription);
					ws.send(JSON.stringify({
						action: 'announce',
						peer_id, info_hash: msg.info_hash,
						to_peer_id: msg.peer_id,
						offer_id: msg.offer_id,
						answer
					}));
				}
			} else if (msg.answer) {
				const pid = await unmung_sdp(msg.answer);
				const pc = peer_conns.get(msg.offer_id);
				if (pc) {
					await pc.setRemoteDescription(msg.answer);
					pc.other_id = pid;
					PeerConnection.connections.set(pid, pc);
					peer_conns.delete(msg.offer_id);
				}
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
	await pc.setLocalDescription();
	await ice_done(pc);
	const offer = await mung_sdp(pc.localDescription);
	const offers = [{
		offer_id,
		offer
	}];

	ws.send(JSON.stringify({
		action: 'announce',
		peer_id, info_hash,
		numwant: offers.length, offers,
		event: "started", downloaded: 100, left: 500, uploaded: 0
	}));

	await new Promise(r => bootstrap_waiters.add(r));
}