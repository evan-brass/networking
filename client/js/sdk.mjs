// If we're not being embedded, then we need to embed a hyperspace client:
if (window.parent == window || window.parent === null) {
	let iframe = document.createElement('iframe');
	iframe.style.display = 'none';
	// iframe.sandbox = "allow-scripts";
	iframe.src = "/hyperspace-fallback.html";
	document.body.appendChild(iframe);
}

// Top-level await is supported by all browsers in their latest releases.
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await#browser_compatibility
const client_port = await new Promise(resolve => {
	// Listen for the hyperspace-client to push us a message channel that we'll use to communicate with it.
	window.addEventListener('message', ({ data, origin }) => {
		if ('hyperspace_client_message_port' in data) {
			console.log('Received our hyperspace client from: ', origin);
			resolve(data.hyperspace_client_message_port);
		}
	})
});

let seq = 0;

function make_request(request_data) {
	return new Promise((resolve, reject) => {
		const msg_seq = seq++;
		client_port.postMessage(request_data);
		function handler({ data, origin }) {
			if (data?.msg_seq == msg_seq) {
				if (data.type = 'error') {
					reject(data.error);
				} else {
					resolve(data);
					client_port.removeEventListener('message', handler);
				}
			}
		};
		client_port.addEventListener('message', handler);
	});
}

export async function list_peers() {
	const {peers} = await make_request({
		type: 'peer_list',
		msg_seq
	});
	return peers;
}