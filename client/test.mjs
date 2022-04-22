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

(async function() {
	// Both connections create an offer
	await a.setLocalDescription();
	await b.setLocalDescription();
	
	// Turn each peer's local description (an offer) into an answer
	// We make a the DTLS server (by telling a that b will be active) and we make b the DTLS client (by telling b that a will be passive).
	let b_sdp = b.localDescription.sdp;
	b_sdp = b_sdp.replace('a=setup:actpass', 'a=setup:active');
	let a_sdp = a.localDescription.sdp;
	a_sdp = a_sdp.replace('a=setup:actpass', 'a=setup:passive');
	
	// Log the modified SDP and then set it as the remote description.
	console.log(b_sdp);
	await a.setRemoteDescription({ type: 'answer', sdp: b_sdp });
	console.log(a_sdp);
	await b.setRemoteDescription({ type: 'answer', sdp: a_sdp });
	
	// Inspect the final local descriptions' sdp (which should include ice candidates at this point.)
	await new Promise(res => setTimeout(res, 1000));
	console.log(a.localDescription.sdp);
	console.log(b.localDescription.sdp);
})();