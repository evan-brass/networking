function create_nonce() {
	return Array.from(crypto.getRandomValues(new Uint8Array(4))).map(v => v.toString(16).padStart(2, '0')).join('');
}

// Base class for outstanding requests:
// I'm thinking that requests will be stateful but responses will not be stateful.
class HCRequest extends EventTarget {
	nonce = create_nonce();
	timeout;
	constructor({ timeout = 5000 } = {}) {
		this.timeout = setTimeout(() => this.dispatchEvent(new CustomEvent('timedout')), timeout);
	}
	async handle_message(msg) {
		// Reset the timeout
		clearTimeout(this.timeout);

	}
	complete(result) {
		clearTimeout(this.timeout);
		this.dispatchEvent(new CustomEvent('complete', { detail: result }));
	}

}

class HyperspaceClient {
	// nonce -> HCRequest
	outstanding_requests = new Map();
	async handle_message({ data }) {

	}
	
}

export default new HyperspaceClient();