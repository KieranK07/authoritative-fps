'use strict';

// Pure game rules shared by the server loop and the tests: weapons, map,
// ray tests used for hit registration, and the reload state machine.

const EYE_HEIGHT = 1.6;

const WEAPONS = {
  rifle: {
    id: 'rifle',
    name: 'Rifle',
    bodyDamage: 34,
    headDamage: 68,
    range: 120,
    fireInterval: 0.12,
    magSize: 30,
    reserveSize: 90,
    reloadSeconds: 1.7,
  },
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    bodyDamage: 16,
    headDamage: 32,
    range: 80,
    fireInterval: 0.18,
    magSize: 15,
    reserveSize: 60,
    reloadSeconds: 0.8,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    bodyDamage: 62,
    headDamage: 96,
    range: 25,
    fireInterval: 0.6,
    magSize: 8,
    reserveSize: 32,
    reloadSeconds: 2.0,
  },
  sniper: {
    id: 'sniper',
    name: 'Sniper',
    bodyDamage: 68,
    headDamage: 120,
    range: 200,
    fireInterval: 0.8,
    magSize: 5,
    reserveSize: 30,
    reloadSeconds: 2.5,
  },
};

const DEFAULT_WEAPON = WEAPONS.rifle;

const MAP_OBSTACLES = [
  { x: 0, z: 0, w: 6, d: 6, h: 3, color: '#7f8c8d' },
  { x: -10, z: -8, w: 8, d: 2.5, h: 2.5, color: '#5d6d7e' },
  { x: 10, z: 8, w: 8, d: 2.5, h: 2.5, color: '#5d6d7e' },
  { x: -12, z: 10, w: 3, d: 8, h: 2.5, color: '#566573' },
  { x: 12, z: -10, w: 3, d: 8, h: 2.5, color: '#566573' },
  { x: -18, z: 0, w: 2.5, d: 12, h: 2.5, color: '#34495e' },
  { x: 18, z: 0, w: 2.5, d: 12, h: 2.5, color: '#34495e' },
];
function normalizeDirection(x, y, z) {
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

function raySphereDistance(origin, dir, center, radius) {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const h = b * b - c;
  if (h < 0) {
    return Infinity;
  }

  const sqrtH = Math.sqrt(h);
  const t1 = -b - sqrtH;
  const t2 = -b + sqrtH;

  if (t1 > 0) {
    return t1;
  }
  if (t2 > 0) {
    return t2;
  }
  return Infinity;
}

function rayAabbDistance(origin, dir, obstacle) {
  const min = {
    x: obstacle.x - obstacle.w * 0.5,
    y: 0,
    z: obstacle.z - obstacle.d * 0.5,
  };
  const max = {
    x: obstacle.x + obstacle.w * 0.5,
    y: obstacle.h,
    z: obstacle.z + obstacle.d * 0.5,
  };

  let tMin = 0;
  let tMax = Infinity;

  for (const axis of ['x', 'y', 'z']) {
    const originVal = origin[axis];
    const dirVal = dir[axis];
    const minVal = min[axis];
    const maxVal = max[axis];

    if (Math.abs(dirVal) < 1e-8) {
      if (originVal < minVal || originVal > maxVal) {
        return Infinity;
      }
      continue;
    }

    const inv = 1 / dirVal;
    let t1 = (minVal - originVal) * inv;
    let t2 = (maxVal - originVal) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }

    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) {
      return Infinity;
    }
  }

  return tMin >= 0 ? tMin : tMax >= 0 ? tMax : Infinity;
}

function getBlockedDistance(origin, dir, maxDistance, obstacles = MAP_OBSTACLES) {
  let closest = Infinity;
  for (const obstacle of obstacles) {
    const t = rayAabbDistance(origin, dir, obstacle);
    if (t < closest && t <= maxDistance) {
      closest = t;
    }
  }
  return closest;
}

function makeShotDirection(player) {
  return normalizeDirection(
    Math.sin(player.yaw) * Math.cos(player.pitch),
    Math.sin(player.pitch),
    Math.cos(player.yaw) * Math.cos(player.pitch)
  );
}

function tryStartReload(player, nowSec) {
  if (!player.alive || nowSec < player.reloadUntil) {
    return false;
  }
  const weapon = WEAPONS[player.equippedWeapon] || DEFAULT_WEAPON;
  if (player.ammoMag >= weapon.magSize || player.ammoReserve <= 0) {
    return false;
  }
  player.reloadUntil = nowSec + weapon.reloadSeconds;
  return true;
}

function finishReloadIfNeeded(player, nowSec) {
  if (player.reloadUntil <= 0 || nowSec < player.reloadUntil) {
    return;
  }
  const weapon = WEAPONS[player.equippedWeapon] || DEFAULT_WEAPON;
  const needed = weapon.magSize - player.ammoMag;
  const transfer = Math.min(needed, player.ammoReserve);
  player.ammoMag += transfer;
  player.ammoReserve -= transfer;
  player.reloadUntil = 0;
}

// Picks the nearest player the shot hits, ignoring anyone behind a wall.
// Hitboxes are a body sphere and a smaller head sphere above it.
function findShotTarget(shooter, targets, weapon, obstacles = MAP_OBSTACLES) {
  const origin = {
    x: shooter.position.x,
    y: shooter.position.y + EYE_HEIGHT,
    z: shooter.position.z,
  };
  const dir = makeShotDirection(shooter);
  let bestHit = null;
  let bestDistance = weapon.range;

  const blockedDistance = getBlockedDistance(origin, dir, weapon.range, obstacles);

  for (const target of targets) {
    if (target.id === shooter.id || !target.alive) {
      continue;
    }

    const bodyCenter = { x: target.position.x, y: target.position.y + 0.15, z: target.position.z };
    const headCenter = { x: target.position.x, y: target.position.y + 0.85, z: target.position.z };
    const bodyDistance = raySphereDistance(origin, dir, bodyCenter, 0.58);
    const headDistance = raySphereDistance(origin, dir, headCenter, 0.3);

    let hitDistance = bodyDistance;
    let hitKind = 'body';
    if (headDistance < hitDistance) {
      hitDistance = headDistance;
      hitKind = 'head';
    }

    if (hitDistance < bestDistance && hitDistance < blockedDistance) {
      bestDistance = hitDistance;
      bestHit = { target, hitKind };
    }
  }

  return { origin, dir, bestHit, bestDistance, blockedDistance };
}

module.exports = {
  EYE_HEIGHT,
  WEAPONS,
  DEFAULT_WEAPON,
  MAP_OBSTACLES,
  normalizeDirection,
  raySphereDistance,
  rayAabbDistance,
  getBlockedDistance,
  makeShotDirection,
  tryStartReload,
  finishReloadIfNeeded,
  findShotTarget,
};
