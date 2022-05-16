// const certificates = [await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' })];
const rtc_options = {
	iceServers: [
		{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']}
	]
};

function channel_openned(peer, e) {
	const channel = e.channel ?? e.srcElement;
	document.body.insertAdjacentHTML('beforeend', `<p>${channel.label} was openned on ${peer}</p>`);
}

const a = new RTCPeerConnection(rtc_options);
const b = new RTCPeerConnection(rtc_options);
// Create a datachannel so that both RTCPeerConnection's will try to negotiate SCTP
const dc_a = a.createDataChannel('dc_a');
dc_a.onopen = channel_openned.bind(null, 'a');
dc_a.onerror = console.error;
a.ondatachannel = channel_openned.bind(null, 'a');
const dc_b = b.createDataChannel('dc_b');
dc_b.onopen = channel_openned.bind(null, 'b');
dc_b.onerror = console.error;
b.ondatachannel = channel_openned.bind(null, 'b');

window.getstatsa = async function () {
	return Object.fromEntries(await (await a.getStats()).entries());
};
window.getstatsb = async function () {
	return Object.fromEntries(await (await b.getStats()).entries());
};

// Only transmit ice candidates one way.  The otherway will be picked up automatically via peer reflexive candidates.
const candidates = [];
a.onicecandidate = async ({ candidate }) => {
	if (candidate) {
		candidates.push(candidate);
		console.log(candidate.candidate);
	} else while(candidates.length) {
		while (b.remoteDescription == null) await new Promise(res => b.addEventListener('signalingstatechange', res, {once: true}));

		const candidate = candidates.shift();
		console.log(candidate);
		await b.addIceCandidate(candidate);
	}
};

function parse_sdp(sdp) {
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

(async function() {
	// Both connections create an offer
	await a.setLocalDescription();
	await b.setLocalDescription();

	console.log(a);
	console.log(a.sctp);
	console.log(a.sctp.transport);
	a.sctp.transport.addEventListener('error', console.log);
	console.log(a.sctp.transport.iceTransport);

	console.log(b);
	console.log(b.sctp);
	console.log(b.sctp.transport);
	b.sctp.transport.addEventListener('error', console.log);
	console.log(b.sctp.transport.iceTransport);
	
	// Turn each peer's local description (an offer) into an answer
	// We make a the DTLS server (by telling a that b will be active) and we make b the DTLS client (by telling b that a will be passive).
	const b_ans = rehydrate_answer(parse_sdp(b.localDescription.sdp), false);

	// Break the DTLS layer (hoping to get an error that might leak information.)
	const props = parse_sdp(a.localDescription.sdp);
	props.dtls_fingerprint = (new Array(32).fill(0).map(n => n.toString(16).padStart(2, '0')).join(':'));
	const a_ans = rehydrate_answer(props, true);

	// Inspect the final local descriptions' sdp (which should include ice candidates at this point.)
	// await new Promise(res => setTimeout(res, 5000));
	
	await a.setRemoteDescription(b_ans);
	await b.setRemoteDescription(a_ans);
	
	// Inspect the final local descriptions' sdp (which should include ice candidates at this point.)
	await new Promise(res => setTimeout(res, 5000));

	// Inspect the various transports: SCTP -> DTLS -> ICE
	console.log(a.sctp.transport.iceTransport.getSelectedCandidatePair());
	console.log(b.sctp.transport.iceTransport.getSelectedCandidatePair());
})();