const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const TICK_RATE = 60;
const FIXED_DT = 1 / TICK_RATE;
const WORLD_BOUNDS = 30;
const PLAYER_SPEED = 6;
const SPRINT_SPEED_MULTIPLIER = 1.7;
const MAX_CHAT_LENGTH = 140;
const PLAYER_RADIUS = 0.45;
const PLAYER_HALF_HEIGHT = 1.0;
const GRAVITY = -24;
const JUMP_VELOCITY = 13.0;
const GROUND_ACCEL = 48;
const AIR_ACCEL = 16;
const GROUND_FRICTION = 30;
const AIR_DRAG = 0.8;
const AIR_SPEED_MULTIPLIER = 1.1;
const MAX_STAMINA = 100;
const STAMINA_DRAIN_PER_SEC = 8;
const STAMINA_REGEN_PER_SEC = 20;
const MAX_HEALTH = 100;
const ROUND_DURATION = 420;
const RESPAWN_DELAY = 5;

const {
  WEAPONS,
  DEFAULT_WEAPON,
  MAP_OBSTACLES,
  tryStartReload,
  finishReloadIfNeeded,
  findShotTarget,
} = require('./game');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// Expose only the Three.js browser build, not the rest of node_modules.
app.use('/node_modules/three/build', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

const players = new Map();
let stateSequence = 0;
let matchTime = 0;
let roundIndex = 0;
let gameTime = 0;

function randomSpawn() {
  for (let i = 0; i < 40; i += 1) {
    const candidate = {
      x: (Math.random() - 0.5) * 20,
      z: (Math.random() - 0.5) * 20,
    };

    if (!collidesWithObstacle2D(candidate.x, candidate.z, PLAYER_RADIUS)) {
      return candidate;
    }
  }

  return { x: 0, z: -14 };
}

function randomColorHex() {
  const color = Math.floor(0x555555 + Math.random() * 0xaaaaaa);
  return `#${color.toString(16).padStart(6, '0')}`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function moveTowards(current, target, maxDelta) {
  if (current < target) {
    return Math.min(current + maxDelta, target);
  }
  return Math.max(current - maxDelta, target);
}

function sanitizeName(value, fallback) {
  const clean = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return clean.length > 0 ? clean : fallback;
}

function sanitizeChat(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHAT_LENGTH);
}

function collidesWithObstacle2D(x, z, radius) {
  for (const obstacle of MAP_OBSTACLES) {
    const halfW = obstacle.w * 0.5 + radius;
    const halfD = obstacle.d * 0.5 + radius;
    if (x >= obstacle.x - halfW && x <= obstacle.x + halfW && z >= obstacle.z - halfD && z <= obstacle.z + halfD) {
      return true;
    }
  }
  return false;
}

function collidesWithObstacleAt(x, y, z, radius) {
  const playerMinY = y - PLAYER_HALF_HEIGHT;
  const playerMaxY = y + PLAYER_HALF_HEIGHT;

  for (const obstacle of MAP_OBSTACLES) {
    const halfW = obstacle.w * 0.5 + radius;
    const halfD = obstacle.d * 0.5 + radius;
    const overlapsXZ = x >= obstacle.x - halfW && x <= obstacle.x + halfW && z >= obstacle.z - halfD && z <= obstacle.z + halfD;
    if (!overlapsXZ) {
      continue;
    }

    const overlapsY = playerMinY < obstacle.h && playerMaxY > 0;
    if (overlapsY) {
      return true;
    }
  }

  return false;
}

function getSupportTop(x, z, radius) {
  let top = 0;
  for (const obstacle of MAP_OBSTACLES) {
    const halfW = obstacle.w * 0.5 + radius;
    const halfD = obstacle.d * 0.5 + radius;
    const overlapsXZ = x >= obstacle.x - halfW && x <= obstacle.x + halfW && z >= obstacle.z - halfD && z <= obstacle.z + halfD;
    if (overlapsXZ && obstacle.h > top) {
      top = obstacle.h;
    }
  }
  return top;
}

function respawnPlayer(player, weaponId = DEFAULT_WEAPON.id) {
  player.equippedWeapon = weaponId;
  const spawn = randomSpawn();
  player.position.x = spawn.x;
  player.position.y = PLAYER_HALF_HEIGHT;
  player.position.z = spawn.z;
  player.velX = 0;
  player.velY = 0;
  player.velZ = 0;
  player.grounded = true;
  player.health = MAX_HEALTH;
  const weapon = WEAPONS[weaponId] || DEFAULT_WEAPON;
  player.ammoMag = weapon.magSize;
  player.ammoReserve = weapon.reserveSize;
  player.reloadUntil = 0;
  player.alive = true;
}

function performShoot(shooter, nowSec) {
  finishReloadIfNeeded(shooter, nowSec);

  if (!shooter.alive) {
    return;
  }
  if (nowSec < shooter.reloadUntil) {
    return;
  }
  if (shooter.ammoMag <= 0) {
    return;
  }
  
  const weapon = WEAPONS[shooter.equippedWeapon] || DEFAULT_WEAPON;
  if (nowSec - shooter.lastShotAt < weapon.fireInterval) {
    return;
  }

  shooter.lastShotAt = nowSec;
  shooter.ammoMag -= 1;

  const { origin, dir, bestHit, bestDistance, blockedDistance } = findShotTarget(shooter, players.values(), weapon);

  // Trace always ends at the first thing hit: player first, then world, then max range.
  const traceDistance = bestHit
    ? bestDistance
    : Math.min(
      weapon.range,
      Number.isFinite(blockedDistance) ? blockedDistance : weapon.range
    );
  const traceEnd = {
    x: origin.x + dir.x * traceDistance,
    y: origin.y + dir.y * traceDistance,
    z: origin.z + dir.z * traceDistance,
  };
  const hasImpact = !!bestHit || (Number.isFinite(blockedDistance) && blockedDistance <= weapon.range);

  io.emit('shotTrace', {
    shooterId: shooter.id,
    origin,
    end: traceEnd,
    impact: hasImpact,
    hit: !!bestHit,
  });

  if (!bestHit) {
    return;
  }

  const damage = bestHit.hitKind === 'head' ? weapon.headDamage : weapon.bodyDamage;
  bestHit.target.health = clamp(bestHit.target.health - damage, 0, MAX_HEALTH);

  io.to(shooter.id).emit('hitConfirm', {
    damage,
    headshot: bestHit.hitKind === 'head',
    targetId: bestHit.target.id,
    origin,
    direction: dir,
  });

  if (bestHit.target.health <= 0) {
    bestHit.target.alive = false;
    bestHit.target.respawnAt = nowSec + RESPAWN_DELAY;
    bestHit.target.deaths += 1;
    shooter.kills += 1;

    io.emit('killFeed', {
      killerId: shooter.id,
      killer: shooter.name,
      victimId: bestHit.target.id,
      victim: bestHit.target.name,
      headshot: bestHit.hitKind === 'head',
      weapon: weapon.name,
      ts: Date.now(),
    });
  }
}

io.on('connection', (socket) => {
  const spawn = randomSpawn();
  const player = {
    id: socket.id,
    name: sanitizeName(socket.handshake.query?.name, `Player-${socket.id.slice(0, 4)}`),
    color: randomColorHex(),
    position: { x: spawn.x, y: PLAYER_HALF_HEIGHT, z: spawn.z },
    velX: 0,
    velZ: 0,
    velY: 0,
    grounded: true,
    alive: true,
    respawnAt: 0,
    stamina: MAX_STAMINA,
    health: MAX_HEALTH,
    isSprinting: false,
    prevJumpInput: false,
    yaw: 0,
    pitch: 0,
    kills: 0,
    deaths: 0,
    ammoMag: DEFAULT_WEAPON.magSize,
    ammoReserve: DEFAULT_WEAPON.reserveSize,
    reloadUntil: 0,
    lastShotAt: -999,
    input: {
      moveX: 0,
      moveZ: 0,
      yaw: 0,
      pitch: 0,
      jump: 0,
      sprint: 0,
    },
  };

  player.equippedWeapon = DEFAULT_WEAPON.id;

  players.set(socket.id, player);

  console.log(`[connect] id=${player.id} name=${player.name} players=${players.size}`);

  socket.emit('welcome', {
    id: socket.id,
    tickRate: TICK_RATE,
    worldBounds: WORLD_BOUNDS,
    speed: PLAYER_SPEED,
    sprintMultiplier: SPRINT_SPEED_MULTIPLIER,
    maxStamina: MAX_STAMINA,
    maxHealth: MAX_HEALTH,
    roundDuration: ROUND_DURATION,
    weapons: Object.values(WEAPONS).map(w => ({
      id: w.id,
      name: w.name,
      magSize: w.magSize,
      reserveSize: w.reserveSize,
      reloadSeconds: w.reloadSeconds,
      fireInterval: w.fireInterval,
    })),
    defaultWeapon: DEFAULT_WEAPON.id,
    obstacles: MAP_OBSTACLES,
  });

  io.emit('chatMessage', {
    id: 'system',
    name: 'System',
    text: `${player.name} joined the arena.`,
    ts: Date.now(),
  });

  socket.on('input', (incoming = {}) => {
    const p = players.get(socket.id);
    if (!p) {
      return;
    }

    p.input.moveX = Number.isFinite(incoming.moveX) ? incoming.moveX : 0;
    p.input.moveZ = Number.isFinite(incoming.moveZ) ? incoming.moveZ : 0;
    p.input.yaw = Number.isFinite(incoming.yaw) ? incoming.yaw : p.input.yaw;
    p.input.pitch = Number.isFinite(incoming.pitch) ? incoming.pitch : p.input.pitch;
    p.input.jump = incoming.jump ? 1 : 0;
    p.input.sprint = incoming.sprint ? 1 : 0;
    p.yaw = p.input.yaw;
    p.pitch = clamp(p.input.pitch, -Math.PI / 2.5, Math.PI / 2.5);
  });

  socket.on('shoot', () => {
    const p = players.get(socket.id);
    if (!p) {
      return;
    }
    performShoot(p, gameTime);
  });

  socket.on('reload', () => {
    const p = players.get(socket.id);
    if (!p) {
      return;
    }
    tryStartReload(p, gameTime);
  });

  socket.on('selectWeapon', (weaponId = DEFAULT_WEAPON.id) => {
    const p = players.get(socket.id);
    if (!p) {
      return;
    }
    if (WEAPONS[weaponId]) {
      p.equippedWeapon = weaponId;
    }
  });

  socket.on('chatMessage', (payload = {}) => {
    const p = players.get(socket.id);
    if (!p) {
      return;
    }

    const text = sanitizeChat(payload.text);
    if (!text) {
      return;
    }

    console.log(`[chat] id=${p.id} name=${p.name} text="${text}"`);

    io.emit('chatMessage', {
      id: p.id,
      name: p.name,
      text,
      ts: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    const leaving = players.get(socket.id);
    players.delete(socket.id);

    if (leaving) {
      console.log(`[disconnect] id=${leaving.id} name=${leaving.name} players=${players.size}`);
      io.emit('chatMessage', {
        id: 'system',
        name: 'System',
        text: `${leaving.name} left the arena.`,
        ts: Date.now(),
      });
    }
  });
});

function stepSimulation(dt) {
  for (const player of players.values()) {
    finishReloadIfNeeded(player, gameTime);

    if (!player.alive) {
      if (gameTime >= player.respawnAt) {
        respawnPlayer(player, player.equippedWeapon);
      }
      continue;
    }

    const jumpPressed = player.input.jump === 1 && !player.prevJumpInput;
    player.prevJumpInput = player.input.jump === 1;

    const supportTopBeforeMove = getSupportTop(player.position.x, player.position.z, PLAYER_RADIUS);
    const supportYBeforeMove = supportTopBeforeMove + PLAYER_HALF_HEIGHT;
    if (player.grounded) {
      player.position.y = supportYBeforeMove;
      player.velY = 0;
    }

    // Movement is already in world space from client
    const moveLen = Math.hypot(player.input.moveX, player.input.moveZ);
    const len = moveLen || 1;
    const nx = player.input.moveX / len;
    const nz = player.input.moveZ / len;

    const wantsSprint = player.input.sprint === 1;
    const canSprint = wantsSprint && moveLen > 0.05 && player.stamina > 0;
    player.isSprinting = canSprint;

    if (player.isSprinting) {
      player.stamina = clamp(player.stamina - STAMINA_DRAIN_PER_SEC * dt, 0, MAX_STAMINA);
      if (player.stamina <= 0) {
        player.isSprinting = false;
      }
    } else {
      player.stamina = clamp(player.stamina + STAMINA_REGEN_PER_SEC * dt, 0, MAX_STAMINA);
    }

    if (jumpPressed && player.grounded) {
      player.velY = JUMP_VELOCITY;
      player.grounded = false;
    }

    const moveSpeed = player.isSprinting ? PLAYER_SPEED * SPRINT_SPEED_MULTIPLIER : PLAYER_SPEED;
    const targetVelX = nx * moveSpeed;
    const targetVelZ = nz * moveSpeed;

    if (player.grounded) {
      player.velX = moveTowards(player.velX, targetVelX, GROUND_ACCEL * dt);
      player.velZ = moveTowards(player.velZ, targetVelZ, GROUND_ACCEL * dt);

      if (moveLen < 0.05) {
        const friction = Math.max(0, 1 - GROUND_FRICTION * dt);
        player.velX *= friction;
        player.velZ *= friction;
      }
    } else {
      player.velX = moveTowards(player.velX, targetVelX, AIR_ACCEL * dt);
      player.velZ = moveTowards(player.velZ, targetVelZ, AIR_ACCEL * dt);

      const airFactor = Math.max(0, 1 - AIR_DRAG * dt);
      player.velX *= airFactor;
      player.velZ *= airFactor;

      const maxAirSpeed = moveSpeed * AIR_SPEED_MULTIPLIER;
      const horizontalSpeed = Math.hypot(player.velX, player.velZ);
      if (horizontalSpeed > maxAirSpeed && horizontalSpeed > 0) {
        const scale = maxAirSpeed / horizontalSpeed;
        player.velX *= scale;
        player.velZ *= scale;
      }
    }

    const targetX = clamp(player.position.x + player.velX * dt, -WORLD_BOUNDS, WORLD_BOUNDS);
    const targetZ = clamp(player.position.z + player.velZ * dt, -WORLD_BOUNDS, WORLD_BOUNDS);

    // Resolve per-axis against static map obstacles (no player-player collision).
    if (!collidesWithObstacleAt(targetX, player.position.y, player.position.z, PLAYER_RADIUS)) {
      player.position.x = targetX;
    } else {
      player.velX = 0;
    }

    if (!collidesWithObstacleAt(player.position.x, player.position.y, targetZ, PLAYER_RADIUS)) {
      player.position.z = targetZ;
    } else {
      player.velZ = 0;
    }

    if (player.grounded) {
      const supportTopAfterMove = getSupportTop(player.position.x, player.position.z, PLAYER_RADIUS);
      const currentSupportTop = player.position.y - PLAYER_HALF_HEIGHT;

      // If the support drops away (e.g. stepping off a box), transition to falling.
      if (supportTopAfterMove + 1e-4 < currentSupportTop) {
        player.grounded = false;
      } else {
        player.position.y = supportTopAfterMove + PLAYER_HALF_HEIGHT;
        player.velY = 0;
      }
    }

    if (!player.grounded) {
      player.velY += GRAVITY * dt;
      let nextY = player.position.y + player.velY * dt;

      const supportTop = getSupportTop(player.position.x, player.position.z, PLAYER_RADIUS);
      const supportY = supportTop + PLAYER_HALF_HEIGHT;
      if (player.velY <= 0 && nextY <= supportY) {
        nextY = supportY;
        player.velY = 0;
        player.grounded = true;
      }

      player.position.y = nextY;
    }
  }
}

function buildSnapshot() {
  const snapshot = {};

  for (const [id, player] of players) {
    snapshot[id] = {
      id,
      name: player.name,
      color: player.color,
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      yaw: player.yaw,
      pitch: player.pitch,
      stamina: player.stamina,
      health: player.health,
      sprinting: player.isSprinting,
      alive: player.alive,
      respawnAt: player.respawnAt,
      kills: player.kills,
      deaths: player.deaths,
      ammoMag: player.ammoMag,
      ammoReserve: player.ammoReserve,
      equippedWeapon: player.equippedWeapon,
      reloading: player.reloadUntil > gameTime,
    };
  }

  return snapshot;
}

setInterval(() => {
  matchTime += FIXED_DT;
  gameTime += FIXED_DT;

  const newRoundIndex = Math.floor(matchTime / ROUND_DURATION);
  if (newRoundIndex !== roundIndex) {
    roundIndex = newRoundIndex;
    for (const player of players.values()) {
      player.kills = 0;
      player.deaths = 0;
    }
    io.emit('chatMessage', {
      id: 'system',
      name: 'System',
      text: 'New round started!',
      ts: Date.now(),
    });
  }

  stepSimulation(FIXED_DT);

  stateSequence += 1;
  io.volatile.emit('worldState', {
    seq: stateSequence,
    serverTime: Date.now(),
    roundTimeLeft: Math.max(0, ROUND_DURATION - (matchTime % ROUND_DURATION)),
    players: buildSnapshot(),
  });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Multiplayer server listening on http://localhost:${PORT}`);
  console.log(`[config] tickRate=${TICK_RATE}Hz worldBounds=${WORLD_BOUNDS} speed=${PLAYER_SPEED}`);
});
