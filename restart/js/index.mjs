const webtorrent_trackers = [
	"wss://tracker.btorrent.xyz",
	"wss://tracker.fastcast.nz",
	"wss://tracker.files.fm:7073/announce",
	// "wss://tracker.openwebtorrent.com",
	// List of trackers: https://github.com/ngosang/trackerslist/blob/master/trackers_all_ws.txt
];
const seed_info_hashes = [
	"¾\x80v\x90ú!çD\x1A\x98\x80\x8AÄWrÇìô5v",
	"[\fç\\ZÚ\x19#»w\x98BpË'Ú£@£»"
];
const iceServers = [{
	// A list of stun/turn servers: https://gist.github.com/sagivo/3a4b2f2c7ac6e1b5267c2f1f59ac6c6b
	urls: [
		'stun:stun.l.google.com:19302',
		'stun:stun1.l.google.com:19302'
	]
}];

