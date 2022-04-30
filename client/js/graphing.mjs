import { PeerId, our_peerid, known_ids } from "./core/peer-id.mjs";
import { PeerConnection } from "./core/peer-connection.mjs";
import { above, below, sibling_range } from "./core/siblings.mjs";
import { bucket_index } from "./core/kbuckets.mjs";

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d');
const canvas_size = 2000;
canvas.width = canvas_size;
canvas.height = canvas_size;
canvas.style = "max-width: vmin;";
const node_radius = 10;
function position_pid(pid) {
	// We want to turn our id range [0, 2**256) into [0, 2π)
	// We'll do that in two steps by first the bigints into [0, 5000) and then converting to number
	const rad = Number(pid.kad_id * 5000n / (2n ** 256n)) * (2 * Math.PI / 5000);
	const x = 1000 + Math.cos(rad) * 900;
	const y = 1000 + -Math.sin(rad) * 900;
	return {x, y};
}
function draw_network() {

	ctx.clearRect(0, 0, canvas_size, canvas_size);

	// Draw the radius circle:
	ctx.beginPath();
	ctx.arc(1000, 1000, 900, 0, 2 * Math.PI);
	ctx.closePath();
	ctx.stroke();

	// Draw out all of the peer_ids that we've ever seen
	for (const wr of known_ids.values()) {
		if (!(wr instanceof WeakRef)) continue;
		const pid = wr.deref();
		if (pid == undefined) continue;
		const conn = PeerConnection.connections.get(pid);

		const {low, high} = sibling_range();
		if (pid == our_peerid) {
			ctx.fillStyle = 'red';
		} else if (conn instanceof PeerConnection) {
			if (conn.is_open()) {
				if (pid.kad_id <= high && pid.kad_id >= low) {
					ctx.fillStyle = 'orange';
				} else {
					ctx.fillStyle = 'blue';
				}
			} else {
				ctx.fillStyle = 'purple';
			}
		} else {
			ctx.fillStyle = 'black';
		}

		const bi = bucket_index(pid.kad_id);
		
		const {x, y} = position_pid(pid);
		ctx.beginPath();
		ctx.arc(x, y, node_radius, 0, 2 * Math.PI);
		ctx.closePath();
		ctx.fill();
		ctx.font = "30px bold sans-serif";
		ctx.fillText(bi, x + 20, y + 10);
	}

	// Draw the sniffed connections
	// ctx.fillStyle = 'purple';
	// for (const [pid, conns] of sniffed_map.entries()) {
	// 	for (const conn of conns) {
	// 		// Draw an arc from pid -> conn
	// 		const {x: x1, y: y1} = position_pid(pid);
	// 		const {x: x2, y: y2} = position_pid(conn);
	// 		ctx.beginPath();
	// 		ctx.moveTo(x1, y1);
	// 		ctx.bezierCurveTo(1000, 1000, 1000, 1000, x2, y2);
	// 		ctx.stroke();
	// 	}
	// }

	requestAnimationFrame(draw_network);
}
draw_network();