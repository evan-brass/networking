export const seed_addresses = [
	"ws://localhost:3030"
	// "seed1.hyperspace.gl"
	// etc.
];

/**
 * Sadly, I don't think there's an official protocol definition for the websocket trackers (yet).
 * The definition is based on the implementation at: https://npmjs.com/package/bittorrent-tracker
 */
export const seed_webtorrent = [
	{
		tracker: "wss://tracker.btorrent.xyz",
		info_hash: "¾\x80v\x90ú!çD\x1A\x98\x80\x8AÄWrÇìô5v"
	},
	// wss://tracker.btorrent.xyz
	// wss://tracker.openwebtorrent.com - Often gives me 429 errors
	// wss://tracker.fastcast.nz - I've never been able to connect to this tracker.
	// wss://tracker.files.fm:7073/announce
	// List of trackers: https://github.com/ngosang/trackerslist/blob/master/trackers_all_ws.txt
];

export const min_connections = 5;
export const iceServers = [{
	// A list of stun/turn servers: https://gist.github.com/sagivo/3a4b2f2c7ac6e1b5267c2f1f59ac6c6b
	urls: [
		'stun:stun.l.google.com:19302',
		'stun:stun1.l.google.com:19302'
	]
}];