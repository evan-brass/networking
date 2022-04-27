// const certificates = [await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' })];
const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']}];

function channel_openned(peer, e) {
	const channel = e.channel ?? e.srcElement;
	document.body.insertAdjacentHTML('beforeend', `<p>${channel.label} was openned on ${peer}</p>`);
}

const a = new RTCPeerConnection({ iceServers });
const b = new RTCPeerConnection({ iceServers });
a.createDataChannel('dc_a').onopen = channel_openned.bind(null, 'a');
a.ondatachannel = channel_openned.bind(null, 'a');
b.createDataChannel('dc_b').onopen = channel_openned.bind(null, 'b');
b.ondatachannel = channel_openned.bind(null, 'b');


async function on_ice({ candidate }) {
	// while (!this.remoteDescription) {
	// 	await new Promise(res => this.addEventListener('signalingstatechanged', res));
	// }
	if (candidate) {
		const other = (a == this) ? b : a;
		await other.addIceCandidate(candidate);
	}
}
a.onicecandidate = on_ice;
b.onicecandidate = on_ice;

function parse_sdp(sdp) {
	const ice_ufrag = /a=ice-ufrag:(.+)/.exec(sdp)[1];
	const ice_pwd = /a=ice-pwd:(.+)/.exec(sdp)[1];
	let dtls_fingerprint = /a=fingerprint:sha-256 (.+)/.exec(sdp)[1];
	dtls_fingerprint = dtls_fingerprint.split(':');
	dtls_fingerprint = new Uint8Array(dtls_fingerprint.map(s => parseInt(s, 16)));
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
a=fingerprint:sha-256 ${Array.from(dtls_fingerprint).map(b => b.toString(16).padStart(2, '0')).join(':')}
a=setup:${server ? 'passive' : 'active'}
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
` };
}

(async function() {
	// Both connections create an offer
	await a.setLocalDescription();
	await b.setLocalDescription();
	
	// Turn each peer's local description (an offer) into an answer
	// We make a the DTLS server (by telling a that b will be active) and we make b the DTLS client (by telling b that a will be passive).
	const b_ans = rehydrate_answer(parse_sdp(b.localDescription.sdp), true);
	console.log(b_ans);
	const a_ans = rehydrate_answer(parse_sdp(a.localDescription.sdp), false);
	console.log(a_ans);
	await a.setRemoteDescription(b_ans);
	await b.setRemoteDescription(a_ans);
	
	// Inspect the final local descriptions' sdp (which should include ice candidates at this point.)
	await new Promise(res => setTimeout(res, 5000));
	console.log(a.localDescription.sdp);
	console.log(b.localDescription.sdp);
})();