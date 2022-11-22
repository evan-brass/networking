const rtc_options = {
	iceServers: [
		{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']}
	]
};

// These ICE parameters would need to be known (the same) network wide
const fake_username_fragment = "StUj";
const fake_password = "W6ZdlB8PKn61glhSQTCIq3J9";
const caller_username_fragment = "HlPy";
const caller_password = "yZ94bObvzKd9bVaVlvkKbZy7";

// We don't care what the fake_fingerprint is, because we want the dtls connection to fail / never attempt to connect.
const fake_fingerprint = "FA:75:C7:01:19:E3:51:C2:EF:EA:BE:24:83:B4:C8:5C:CB:0B:A8:29:4F:11:B9:A5:10:4E:E0:6B:04:6D:6B:C3"

function get_fingerprint({ sdp }) {
	return /a=fingerprint:sha-256 (.+)/.exec(sdp)[1];
}

function mung_sdp({
	type,
	ice_ufrag,
	ice_pwd,
	dtls_fingerprint = fake_fingerprint,
	setup = ( type == 'offer' ? 'actpass' : 'active')
}) {
	return { type, sdp: `v=0
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
a=setup:${setup}
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
`};
}

(async () => {
	const fake_conn = new RTCPeerConnection(rtc_options);
	let ice_transport, dtls_transport;

	let setup_res;
	const setup_prom = new Promise(res => setup_res = res);
	fake_conn.onconnectionstatechange = () => {
		if (fake_conn.connectionState == 'failed') {
			fake_conn.restartIce();
		}
	};
	fake_conn.createDataChannel('unused');
	
	// Do full setup of the fake connection
	const temp = await fake_conn.createOffer();
	// console.log(temp.sdp);
	const dtls_fingerprint = get_fingerprint(temp);
	const munged_local = mung_sdp({
		type: 'offer',
		ice_ufrag: fake_username_fragment,
		ice_pwd: fake_password,
		dtls_fingerprint
	});
	// console.log(munged_local.sdp);
	await fake_conn.setLocalDescription(munged_local);

	// Get all the stuff that our local description has given us:
	console.log(fake_conn.sctp);
	dtls_transport = fake_conn.sctp.transport;
	dtls_transport.onerror = console.warn;
	console.log(dtls_transport);
	ice_transport = dtls_transport.iceTransport;
	ice_transport.onselectedcandidateparechange = console.warn;
	ice_transport.onstatechange = console.log;
	ice_transport.ongatheringstatechange = console.log;
	console.log(ice_transport);

	// Complete the negotiation of the fake connection:
	await fake_conn.setRemoteDescription(mung_sdp({
		type: 'answer',
		ice_ufrag: caller_username_fragment,
		ice_pwd: caller_password,
		dtls_fingerprint: fake_fingerprint
	}));

	// Wait for the fake_conn to finish gathering ICE candidates
	while (ice_transport.gatheringState !== 'complete') {
		await new Promise(res => ice_transport.addEventListener('gatheringstatechange', res, {once: true}));
	}

	const candidates = ice_transport.getLocalCandidates();
	console.log(candidates);

	// Create the caller connection:
	const caller_conn = new RTCPeerConnection(rtc_options);
	caller_conn.createDataChannel('unused');

	// Do the full setup for the caller connection:
	const temp2 = await caller_conn.createOffer();
	const caller_fingerprint = get_fingerprint(temp2);
	await caller_conn.setLocalDescription(mung_sdp({
		type: 'offer',
		ice_ufrag: caller_username_fragment,
		ice_pwd: caller_password,
		dtls_fingerprint: caller_fingerprint,
	}));
	await caller_conn.setRemoteDescription(mung_sdp({
		type: 'answer',
		ice_ufrag: fake_username_fragment,
		ice_pwd: fake_password,
		dtls_fingerprint: fake_fingerprint,
		// setup: 'passive'
	}));

	for (const candidate of candidates) {
		console.log(candidate.candidate);
		await caller_conn.addIceCandidate(candidate);
	}

	fake_conn.onnegotiationneeded = async () => {
		await fake_conn.setLocalDescription();
	};

	console.log(fake_conn);
	console.log(caller_conn);
})();