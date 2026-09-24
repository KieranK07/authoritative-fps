'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EYE_HEIGHT,
  WEAPONS,
  MAP_OBSTACLES,
  raySphereDistance,
  rayAabbDistance,
  getBlockedDistance,
  tryStartReload,
  finishReloadIfNeeded,
  findShotTarget,
} = require('../game');

const EPS = 1e-9;
const forward = { x: 0, y: 0, z: 1 };

function player(id, x, y, z, extra = {}) {
  return {
    id,
    alive: true,
    position: { x, y, z },
    yaw: 0,
    pitch: 0,
    equippedWeapon: 'rifle',
    ammoMag: WEAPONS.rifle.magSize,
    ammoReserve: WEAPONS.rifle.reserveSize,
    reloadUntil: 0,
    ...extra,
  };
}

// Points the shooter's eye at a world position, using the same yaw/pitch
// convention the client sends and makeShotDirection reads.
function aimAt(shooter, point) {
  const dx = point.x - shooter.position.x;
  const dy = point.y - (shooter.position.y + EYE_HEIGHT);
  const dz = point.z - shooter.position.z;
  shooter.yaw = Math.atan2(dx, dz);
  shooter.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return shooter;
}

const bodyOf = (p) => ({ x: p.position.x, y: p.position.y + 0.15, z: p.position.z });
const headOf = (p) => ({ x: p.position.x, y: p.position.y + 0.85, z: p.position.z });

test('ray-vs-sphere: hit in front returns distance to the near surface', () => {
  const t = raySphereDistance({ x: 0, y: 0, z: 0 }, forward, { x: 0, y: 0, z: 10 }, 1);
  assert.ok(Math.abs(t - 9) < EPS);
});

test('ray-vs-sphere: a ray that passes beside the sphere misses', () => {
  const t = raySphereDistance({ x: 0, y: 0, z: 0 }, forward, { x: 2, y: 0, z: 10 }, 1);
  assert.equal(t, Infinity);
});

test('ray-vs-sphere: a sphere behind the origin is not hit', () => {
  const t = raySphereDistance({ x: 0, y: 0, z: 0 }, forward, { x: 0, y: 0, z: -10 }, 1);
  assert.equal(t, Infinity);
});

test('ray-vs-sphere: from inside the sphere, returns the exit distance', () => {
  const t = raySphereDistance({ x: 0, y: 0, z: 0 }, forward, { x: 0, y: 0, z: 0.5 }, 1);
  assert.ok(Math.abs(t - 1.5) < EPS);
});

const crate = { x: 0, z: 5, w: 2, d: 2, h: 3 }; // spans z 4..6, y 0..3

test('ray-vs-AABB: hit returns distance to the first face', () => {
  const t = rayAabbDistance({ x: 0, y: 1, z: 0 }, forward, crate);
  assert.ok(Math.abs(t - 4) < EPS);
});

test('ray-vs-AABB: a ray over the top of the box misses', () => {
  const t = rayAabbDistance({ x: 0, y: 3.5, z: 0 }, forward, crate);
  assert.equal(t, Infinity);
});

test('ray-vs-AABB: axis-parallel ray outside the slab misses', () => {
  const t = rayAabbDistance({ x: 5, y: 1, z: 0 }, forward, crate);
  assert.equal(t, Infinity);
});

test('ray-vs-AABB: a box behind the origin is not hit', () => {
  const t = rayAabbDistance({ x: 0, y: 1, z: 10 }, forward, crate);
  assert.equal(t, Infinity);
});

test('ray-vs-AABB: from inside the box, the ray is blocked immediately', () => {
  const t = rayAabbDistance({ x: 0, y: 1, z: 5 }, forward, crate);
  assert.equal(t, 0);
});

test('getBlockedDistance: nearest wall wins, walls past max range are ignored', () => {
  const near = { x: 0, z: 5, w: 2, d: 2, h: 3 };
  const far = { x: 0, z: 20, w: 2, d: 2, h: 3 };
  const origin = { x: 0, y: 1, z: 0 };
  assert.ok(Math.abs(getBlockedDistance(origin, forward, 100, [far, near]) - 4) < EPS);
  assert.equal(getBlockedDistance(origin, forward, 10, [far]), Infinity);
});

test('shot: clear line of sight hits the body', () => {
  const target = player('b', 0, 1, 10);
  const shooter = aimAt(player('a', 0, 1, 0), bodyOf(target));
  const { bestHit } = findShotTarget(shooter, [shooter, target], WEAPONS.rifle, []);
  assert.equal(bestHit?.target, target);
  assert.equal(bestHit.hitKind, 'body');
});

test('shot: aiming at the head sphere counts as a headshot', () => {
  const target = player('b', 0, 1, 10);
  const shooter = aimAt(player('a', 0, 1, 0), headOf(target));
  const { bestHit } = findShotTarget(shooter, [target], WEAPONS.rifle, []);
  assert.equal(bestHit?.hitKind, 'head');
});

test('shot: cannot hit a player through the central crate on the real map', () => {
  const center = MAP_OBSTACLES[0];
  assert.deepEqual([center.x, center.z], [0, 0]);
  const target = player('b', 0, 1, 10);
  const shooter = aimAt(player('a', 0, 1, -10), bodyOf(target));
  const { bestHit, blockedDistance } = findShotTarget(shooter, [target], WEAPONS.sniper);
  assert.equal(bestHit, null);
  assert.ok(blockedDistance < 20);
});

test('shot: a player in front of a wall is still hit', () => {
  const wall = { x: 0, z: 15, w: 4, d: 1, h: 3 };
  const target = player('b', 0, 1, 10);
  const shooter = aimAt(player('a', 0, 1, 0), bodyOf(target));
  const { bestHit } = findShotTarget(shooter, [target], WEAPONS.rifle, [wall]);
  assert.equal(bestHit?.target, target);
});

test('shot: the nearer of two players in line takes the hit', () => {
  const near = player('near', 0, 1, 6);
  const far = player('far', 0, 1, 12);
  const shooter = player('a', 0, 1, 0, { pitch: Math.atan2(-1.45, 6) });
  const { bestHit } = findShotTarget(shooter, [far, near], WEAPONS.rifle, []);
  assert.equal(bestHit?.target, near);
});

test('shot: targets beyond weapon range, dead players and the shooter are skipped', () => {
  const shooter = player('a', 0, 1, 0);
  const tooFar = player('b', 0, 1, 40);
  aimAt(shooter, bodyOf(tooFar));
  assert.equal(findShotTarget(shooter, [shooter, tooFar], WEAPONS.shotgun, []).bestHit, null);

  const dead = player('c', 0, 1, 10, { alive: false });
  aimAt(shooter, bodyOf(dead));
  assert.equal(findShotTarget(shooter, [shooter, dead], WEAPONS.rifle, []).bestHit, null);
});

test('reload: does not start with a full magazine, empty reserve, or while dead', () => {
  assert.equal(tryStartReload(player('a', 0, 1, 0), 10), false);
  assert.equal(tryStartReload(player('a', 0, 1, 0, { ammoMag: 3, ammoReserve: 0 }), 10), false);
  assert.equal(tryStartReload(player('a', 0, 1, 0, { ammoMag: 3, alive: false }), 10), false);
});

test('reload: start sets reloadUntil and cannot be restarted mid-reload', () => {
  const p = player('a', 0, 1, 0, { ammoMag: 10 });
  assert.equal(tryStartReload(p, 10), true);
  assert.equal(p.reloadUntil, 10 + WEAPONS.rifle.reloadSeconds);
  assert.equal(tryStartReload(p, 10.5), false);
  assert.equal(p.reloadUntil, 10 + WEAPONS.rifle.reloadSeconds);
});

test('reload: nothing moves until the timer passes, then the magazine fills from reserve', () => {
  const p = player('a', 0, 1, 0, { ammoMag: 10, ammoReserve: 90 });
  tryStartReload(p, 10);
  finishReloadIfNeeded(p, 11);
  assert.deepEqual([p.ammoMag, p.ammoReserve], [10, 90]);
  finishReloadIfNeeded(p, 10 + WEAPONS.rifle.reloadSeconds);
  assert.deepEqual([p.ammoMag, p.ammoReserve, p.reloadUntil], [30, 70, 0]);
});

test('reload: a short reserve only transfers what is left', () => {
  const p = player('a', 0, 1, 0, { ammoMag: 10, ammoReserve: 5 });
  tryStartReload(p, 0);
  finishReloadIfNeeded(p, 100);
  assert.deepEqual([p.ammoMag, p.ammoReserve], [15, 0]);
});

test('reload: finishing with no reload pending is a no-op', () => {
  const p = player('a', 0, 1, 0, { ammoMag: 10 });
  finishReloadIfNeeded(p, 100);
  assert.deepEqual([p.ammoMag, p.ammoReserve, p.reloadUntil], [10, 90, 0]);
});
