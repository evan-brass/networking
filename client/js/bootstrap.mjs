import { webtorrent_trackers, seed_info_hashes } from "./network-props.mjs";
import { PeerConnection } from "./webrtc.mjs";

export function bootstrap() {
	// TODO: attempt to connect to the trackers (if we don't already have a connection to them.)
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

for (const tracker of webtorrent_trackers) {
    try {
        const ws = new WebSocket(tracker);
        ws.onopen = async () => {
			const intervals = new Map();
            ws.onmessage = async ({data}) => {
                const msg = JSON.parse(data);
                console.log('track', msg);
                if (msg.interval) {
					if (intervals.has(msg.info_hash)) {
						clearInterval(intervals.get(msg.info_hash));
						intervals.delete(msg.info_hash);
					}
					intervals.set(msg.info_hash, setInterval(() => {
                        if (ws.readyState == ws.OPEN) {
                            ws.send(JSON.stringify({
                                action: 'announce',
                                peer_id, info_hash: msg.info_hash,
                                numwant: 1, // TODO: create more offers?
                                event: 'completed', downloaded: 600, left: 0, uploaded: 0
                            }));
                        }
                    }, 100 * msg.interval));
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
            for (const info_hash of seed_info_hashes) {
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
            }
        };
    } catch (e) {
        console.warn(e);
    }
}