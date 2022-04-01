import { PeerId, our_peerid } from "./peer-id.mjs";
import { routing_table } from "./routing-table.mjs";

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
    const y = 1000 + Math.sin(rad) * 900;
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
    for (const pid of PeerId.peer_ids.values()) {
        const {value: conn, done: is_exact} = routing_table.lookup(pid.kad_id).next();
        const is_sibling = routing_table.is_sibling(pid.kad_id);
        if (pid == our_peerid) {
            ctx.fillStyle = 'red';
        } else if (is_sibling) {
            ctx.fillStyle = 'orange';
        } else if (is_exact && conn) {
            ctx.fillStyle = 'blue';
        } else {
            ctx.fillStyle = 'black';
        }
        const {x, y} = position_pid(pid);
        ctx.beginPath();
        ctx.arc(x, y, node_radius, 0, 2 * Math.PI);
        ctx.closePath();
        ctx.fill();
    }

    // Draw the sniffed connections
    // ctx.fillStyle = 'purple';
    // for (const [pid, conns] of sniffed_map.entries()) {
    //     for (const conn of conns) {
    //         // Draw an arc from pid -> conn
    //         const {x: x1, y: y1} = position_pid(pid);
    //         const {x: x2, y: y2} = position_pid(conn);
    //         ctx.beginPath();
    //         ctx.moveTo(x1, y1);
    //         ctx.bezierCurveTo(1000, 1000, 1000, 1000, x2, y2);
    //         ctx.stroke();
    //     }
    // }

    requestAnimationFrame(draw_network);
}
draw_network();