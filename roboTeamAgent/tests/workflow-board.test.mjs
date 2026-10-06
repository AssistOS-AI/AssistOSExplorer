import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeRoute } from '../public/workflow-routing.js';

function samplePath(path) {
    const tokens = path.split(' '), points = [];
    let current;
    const point = () => ({ x: Number(tokens.shift()), y: Number(tokens.shift()) });
    while (tokens.length) {
        const command = tokens.shift();
        if (command === 'M') { current = point(); points.push(current); continue; }
        if (command === 'L') {
            const end = point();
            for (let i = 1; i <= 100; i++) points.push({ x: current.x + (end.x - current.x) * i / 100, y: current.y + (end.y - current.y) * i / 100 });
            current = end; continue;
        }
        if (command === 'Q') {
            const a = point(), end = point();
            for (let i = 1; i <= 100; i++) {
                const t = i / 100, u = 1 - t;
                points.push({x: u*u*current.x+2*u*t*a.x+t*t*end.x, y: u*u*current.y+2*u*t*a.y+t*t*end.y});
            }
            current = end; continue;
        }
        assert.equal(command, 'C');
        const start = current, a = point(), b = point(), end = point();
        for (let step = 1; step <= 100; step++) {
            const t = step / 100, u = 1 - t;
            points.push(Object.fromEntries(['x', 'y'].map(axis => [axis,
                u ** 3 * start[axis] + 3 * u ** 2 * t * a[axis] + 3 * u * t ** 2 * b[axis] + t ** 3 * end[axis]])));
        }
        current = end;
    }
    return points;
}

test('left-port return avoids the nodes and approaches the destination from outside', () => {
    const start = { x: 569, y: 95 }, end = { x: 49, y: 95 };
    const route = edgeRoute(start, end, 'left', 'left', [{x:60,y:60,width:190,height:70},{x:580,y:60,width:190,height:70}]);
    const points = samplePath(route.path);
    assert.deepEqual(points[0], start);
    assert.deepEqual(points.at(-1), end);
    assert.ok(points[1].x < start.x);
    assert.ok(points.at(-2).x < end.x);
    assert.ok(points.some(point => point.y < 60));
    for (const point of points) {
        assert.ok(point.x >= route.minX && point.x <= route.maxX && point.y >= route.minY);
        for (const x of [60, 580]) {
            assert.ok(!(point.x > x && point.x < x + 190 && point.y > 60 && point.y < 130));
        }
    }
});

test('forward edges stay direct while return edges respect either port side', () => {
    const start = { x: 300, y: 100 }, end = { x: 600, y: 100 };
    assert.ok(samplePath(edgeRoute(start, end).path).every(point => Math.abs(point.y - 100) < 1e-10));
    for (const sourceSide of ['left', 'right']) for (const targetSide of ['left', 'right']) {
        const points = samplePath(edgeRoute(end, start, sourceSide, targetSide).path);
        assert.equal(Math.sign(points[1].x - end.x), sourceSide === 'right' ? 1 : -1);
        assert.equal(Math.sign(points.at(-2).x - start.x), targetSide === 'right' ? 1 : -1);
        if (sourceSide !== 'left' || targetSide !== 'right') assert.ok(points.some(point => point.y !== 100));
    }
});

function verifyClear(route, boxes) {
    assert.equal(route.unroutable, false);
    for (const point of samplePath(route.path)) for (const box of boxes) {
        assert.ok(!(point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height), `Route intersects node at ${point.x},${point.y}`);
    }
}

test('near-aligned coordinator and validation ports do not loop above the destination', () => {
    for (const gap of [20, 28, 40, 80]) {
        const boxes = [{x:310,y:235,width:190,height:70},{x:500+gap,y:110,width:190,height:70}];
        const route = edgeRoute({x:511,y:270},{x:489+gap,y:145},'right','left',boxes);
        verifyClear(route, boxes);
        assert.ok(route.minY >= 145, 'Unnecessary detour above destination');
        assert.ok(route.points.length <= 6, 'Too many bends');
    }
});

test('forward connectors avoid intervening nodes, including after corner rounding', () => {
    const boxes = [{x:0,y:0,width:190,height:70},{x:600,y:0,width:190,height:70}, {x:290,y:-30,width:180,height:140}];
    verifyClear(edgeRoute({x:201,y:35},{x:589,y:35},'right','left',boxes),boxes);
});

test('routing supports origin nodes, tall nodes and both port sides', () => {
    for (const sourceSide of ['left','right']) for (const targetSide of ['left','right']) {
        const boxes = [{x:0,y:0,width:190,height:150},{x:310,y:210,width:190,height:100}];
        const start = {x:sourceSide==='right'?201:-11,y:75};
        const end = {x:targetSide==='right'?511:299,y:260};
        const route = edgeRoute(start,end,sourceSide,targetSide,boxes);
        verifyClear(route, boxes);
        assert.equal(Math.sign(route.points[1].x-start.x), sourceSide==='right'?1:-1);
        assert.equal(Math.sign(route.points.at(-2).x-end.x), targetSide==='right'?1:-1);
    }
});
