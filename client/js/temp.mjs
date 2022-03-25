import { webtorrent_trackers, seed_info_hashes } from "./network-props.mjs";
import { PeerConnection } from "./webrtc.mjs";


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
            ws.onmessage = async ({data}) => {
                const msg = JSON.parse(data);
                console.log('track', msg);
                if (msg.interval) {
                    setInterval(() => {
                        if (ws.readyState == ws.OPEN) {
                            ws.send(JSON.stringify({
                                action: 'announce',
                                peer_id, info_hash: msg.info_hash,
                                numwant: 1, // TODO: create more offers?
                                event: 'completed', downloaded: 600, left: 0, uploaded: 0
                            }));
                        }
                    }, 1000 * msg.interval);
                }
                if (msg.offer) {
                    const pc = new PeerConnection();
                    peer_conns.set(msg.offer_id, pc);
                    const answer = await pc.negotiate(msg.offer);
                    ws.send(JSON.stringify({
                        action: 'announce',
                        peer_id, info_hash: msg.info_hash,
                        to_peer_id: msg.peer_id,
                        offer_id: msg.offer_id,
                        answer
                    }));
                } else if (msg.answer) {
                    await peer_conns.get(msg.offer_id).negotiate(msg.answer);
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