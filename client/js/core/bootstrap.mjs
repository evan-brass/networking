import { PeerConnection } from "./peer-connection.mjs";


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
					if (ws.readyState == ws.OPEN) {
						ws.send(JSON.stringify({
							action: 'announce',
							peer_id, info_hash,
							numwant: 1,
							event: 'completed', downloaded: 600, left: 0, uploaded: 0
						}));
					}
				}, msg.interval * 1000));
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