// const certificates = [await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' })];
const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']}];

const a = new RTCPeerConnection({ iceServers });
const b = new RTCPeerConnection({ iceServers });
a.createDataChannel('dc').onopen = console.log;
b.createDataChannel('').onopen = console.log;
a.ondatachannel = console.log;
b.ondatachannel = console.log;


async function on_ice({ candidate }) {
	while (!this.remoteDescription) {
		await new Promise(res => this.addEventListener('signalingstatechanged', res));
	}
	if (candidate) {
		const other = (a == this) ? b : a;
		other.addIceCandidate(candidate);
	}
}
a.onicecandidate = on_ice;
b.onicecandidate = on_ice;

// Both connections create an offer
await a.setLocalDescription();
await b.setLocalDescription();

// Turn each peer's local description (an offer) into an answer
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