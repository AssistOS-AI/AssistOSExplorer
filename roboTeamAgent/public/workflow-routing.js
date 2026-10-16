// Orthogonal visibility-grid search. Direction is part of the state so that
// length, bends and conflicts with previously routed edges can be scored.
const clearance = 8;
const bendCost = 70;
const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function blocked(a, b, boxes) {
    return boxes.some(box => a.y === b.y
        ? a.y > box.y && a.y < box.bottom && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.right
        : a.x > box.x && a.x < box.right && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.bottom);
}

function conflictCost(a, b, segments) {
    let cost = 0;
    for (const [c, d] of segments) {
        const horizontal = a.y === b.y, otherHorizontal = c.y === d.y;
        if (horizontal === otherHorizontal) {
            const axis = horizontal ? 'x' : 'y', fixed = horizontal ? 'y' : 'x';
            if (Math.abs(a[fixed] - c[fixed]) < 12) {
                cost += Math.max(0, Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]))
                    - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]))) * 4;
            }
        } else {
            const [h1, h2, v1, v2] = horizontal ? [a, b, c, d] : [c, d, a, b];
            if (v1.x > Math.min(h1.x, h2.x) && v1.x < Math.max(h1.x, h2.x)
                && h1.y > Math.min(v1.y, v2.y) && h1.y < Math.max(v1.y, v2.y)) cost += 100;
        }
    }
    return cost;
}

class Queue {
    items = [];
    push(item) {
        let i = this.items.length;
        this.items.push(item);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.items[parent].score <= item.score) break;
            this.items[i] = this.items[parent]; i = parent;
        }
        this.items[i] = item;
    }
    pop() {
        const first = this.items[0], last = this.items.pop();
        if (this.items.length) {
            let i = 0;
            while (i * 2 + 1 < this.items.length) {
                let child = i * 2 + 1;
                if (child + 1 < this.items.length && this.items[child + 1].score < this.items[child].score) child++;
                if (last.score <= this.items[child].score) break;
                this.items[i] = this.items[child]; i = child;
            }
            this.items[i] = last;
        }
        return first;
    }
}

function simplify(points) {
    const result = [];
    for (const point of points) {
        if (result.length && distance(result.at(-1), point) === 0) continue;
        while (result.length > 1) {
            const a = result.at(-2), b = result.at(-1);
            if (!((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y))) break;
            result.pop();
        }
        result.push(point);
    }
    return result;
}

function roundedPath(points, obstacles) {
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
        const a = points[i - 1], b = points[i], c = points[i + 1];
        let radius = Math.min(28, distance(a, b) / 2, distance(b, c) / 2);
        // The rounding stays within this corner square. Shrink it until that
        // square clears every real node, including the source and destination.
        let before, after;
        while (true) {
            before = { x: b.x + Math.sign(a.x - b.x) * radius, y: b.y + Math.sign(a.y - b.y) * radius };
            after = { x: b.x + Math.sign(c.x - b.x) * radius, y: b.y + Math.sign(c.y - b.y) * radius };
            const collides = obstacles.some(box => Math.max(before.x, after.x) > box.x - 3
                && Math.min(before.x, after.x) < box.x + box.width + 3
                && Math.max(before.y, after.y) > box.y - 3 && Math.min(before.y, after.y) < box.y + box.height + 3);
            if (!collides || radius < 1) break;
            radius /= 2;
        }
        path += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
    }
    return `${path} L ${points.at(-1).x} ${points.at(-1).y}`;
}

export function edgeRoute(start, end, sourceSide = 'right', targetSide = 'left', obstacles = [], segments = []) {
    const sourceDirection = sourceSide === 'right' ? 0 : 2;
    const targetDirection = targetSide === 'left' ? 0 : 2;
    const from = start, to = end;
    const boxes = obstacles.map(box => ({ x: box.x - clearance, y: box.y - clearance,
        right: box.x + box.width + clearance, bottom: box.y + box.height + clearance }));
    const coordinates = (axis, far) => {
        const values = [from[axis], to[axis], (from[axis] + to[axis]) / 2, ...boxes.flatMap(box => [box[axis], box[far]])];
        if (axis === 'x') values.push(start.x + directions[sourceDirection][0] * 28, end.x - directions[targetDirection][0] * 28);
        values.push(Math.min(...values) - 28, Math.max(...values) + 28);
        // Extra tracks allow parallel connectors to separate without moving nodes.
        for (const [a, b] of segments) if (a[axis] === b[axis]) values.push(a[axis] - 16, a[axis] + 16);
        return [...new Set(values)].sort((a, b) => a - b);
    };
    const xs = coordinates('x', 'right'), ys = coordinates('y', 'bottom');
    const key = (x, y, direction) => (y * xs.length + x) * 4 + direction;
    const queue = new Queue(), costs = new Map(), parents = new Map(), states = new Map();
    const initial = { x: xs.indexOf(from.x), y: ys.indexOf(from.y), direction: sourceDirection, cost: 0 };
    initial.key = key(initial.x, initial.y, initial.direction);
    initial.score = distance(from, to);
    queue.push(initial); costs.set(initial.key, 0); states.set(initial.key, initial);
    let found;
    while (queue.items.length) {
        const current = queue.pop();
        if (current.cost !== costs.get(current.key)) continue;
        const a = { x: xs[current.x], y: ys[current.y] };
        if (a.x === to.x && a.y === to.y && current.direction === targetDirection) { found = current; break; }
        for (let direction = 0; direction < 4; direction++) {
            if (direction === (current.direction + 2) % 4 || (current.key === initial.key && direction !== sourceDirection)) continue;
            const [dx, dy] = directions[direction], x = current.x + dx, y = current.y + dy;
            if (x < 0 || y < 0 || x >= xs.length || y >= ys.length) continue;
            const b = { x: xs[x], y: ys[y] };
            if (blocked(a, b, boxes)) continue;
            const atEnd = b.x === to.x && b.y === to.y;
            if (atEnd && direction !== targetDirection) continue;
            const cost = current.cost + distance(a, b) + (direction === current.direction ? 0 : bendCost)
                + (atEnd && direction !== targetDirection ? bendCost : 0) + conflictCost(a, b, segments);
            const id = key(x, y, direction);
            if (cost >= (costs.get(id) ?? Infinity)) continue;
            const next = { key: id, x, y, direction, cost, score: cost + distance(b, to) };
            costs.set(id, cost); parents.set(id, current.key); states.set(id, next); queue.push(next);
        }
    }
    // Overlapping nodes may leave no corridor. Keep the edge visible but mark
    // this exceptional route so the board can distinguish it from a valid one.
    const points = [];
    if (found) {
        for (let state = found; state; state = states.get(parents.get(state.key))) points.push({ x: xs[state.x], y: ys[state.y] });
        points.reverse();
    } else points.push(from, { x: from.x, y: to.y }, to);
    const route = simplify([start, ...points, end]);
    return { points: route, unroutable: !found, path: roundedPath(route, obstacles),
        minX: Math.min(...route.map(p => p.x)), maxX: Math.max(...route.map(p => p.x)),
        minY: Math.min(...route.map(p => p.y)), maxY: Math.max(...route.map(p => p.y)) };
}
